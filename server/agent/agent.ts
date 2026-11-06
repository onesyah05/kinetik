import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import OpenAI from 'openai';
import {getConfig, getProvider, saveConfig, type Provider} from '../config';
import {emit} from '../events';
import {getProject, listAssets, listSourceFiles, projectDir, touchProject} from '../projects';
import {buildSystemPrompt} from './prompt';
import {imageGenTarget} from '../media';
import {ttsEngine} from '../tts';
import {imageToDataUrl, runTool, toolSchemas, type AskQuestion, type StyleOption} from './tools';

// ---------- Stored history ----------

export type ToolCall = {id: string; name: string; arguments: string};

/** Sent (hidden from the chat UI) when a model stops after only describing what it will do. */
const NUDGE =
  'Continue now: carry out that plan with the tools (write the files, check_code, snapshot). Do not stop or wait for confirmation until the video is built and checked.';

/** Sent (hidden) after a gateway dropped the model's tool calls. */
const DROPPED =
  'Your last tool calls never arrived: the API gateway drops replies that contain several tool calls. Call exactly ONE tool per reply from now on and continue the work.';

/** Errors worth retrying: gateway timeouts, overload, rate limits, dropped connections. */
const TRANSIENT = /deadline|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|socket hang up|overloaded|rate.?limit|\b(429|500|502|503|504)\b/i;

/** Sent (hidden) after a reply took so long that the gateway cut it off. */
const TOO_SLOW =
  'Your last reply took too long and the API gateway cut it off. Work in smaller pieces: write one scene per file under src/scenes/ (at most ~120 lines each), then a short src/Video.tsx that only composes them. Continue.';

/** Remember that this provider needs one tool call per reply, so later runs start in that mode. */
const rememberOneTool = (providerId: string) => {
  const c = getConfig();
  const p = c.providers.find((x) => x.id === providerId);
  if (p && !p.oneToolPerTurn) {
    p.oneToolPerTurn = true;
    saveConfig(c);
  }
};

export type StoredMessage =
  | {id: string; ts: number; role: 'user'; content: string; images?: string[]; hidden?: boolean}
  | {id: string; ts: number; role: 'assistant'; content: string; reasoning?: string; tool_calls?: ToolCall[]; model?: string}
  | {
      id: string;
      ts: number;
      role: 'tool';
      tool_call_id: string;
      name: string;
      content: string;
      images?: string[];
      error?: boolean;
      display?: string;
      styles?: StyleOption[];
      questions?: AskQuestion[];
    }
  | {id: string; ts: number; role: 'error'; content: string};

const chatFile = (projectId: string) => path.join(projectDir(projectId), 'chat.json');

export const loadHistory = (projectId: string): StoredMessage[] => {
  try {
    return JSON.parse(fs.readFileSync(chatFile(projectId), 'utf8')).messages ?? [];
  } catch {
    return [];
  }
};

const saveHistory = (projectId: string, messages: StoredMessage[]) => {
  fs.writeFileSync(chatFile(projectId), JSON.stringify({messages}, null, 1));
};

export const clearHistory = (projectId: string) => saveHistory(projectId, []);

const mid = () => randomBytes(6).toString('hex');

// ---------- Conversion to OpenAI format ----------

const KEEP_IMAGE_MESSAGES = 2;
const KEEP_FULL_TOOL_RESULTS = 24;

export const toOpenAI = (projectId: string, history: StoredMessage[], vision: boolean): OpenAI.ChatCompletionMessageParam[] => {
  const imageIdx = history.map((m, i) => ('images' in m && m.images?.length ? i : -1)).filter((i) => i >= 0);
  const keepImages = new Set(imageIdx.slice(-KEEP_IMAGE_MESSAGES));
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  let pendingImages: {label: string; url: string}[] = [];

  const flush = () => {
    if (!pendingImages.length) return;
    out.push({
      role: 'user',
      content: [
        {type: 'text', text: `Images returned by the tools above: ${pendingImages.map((p) => p.label).join(', ')}`},
        ...pendingImages.map((p) => ({type: 'image_url' as const, image_url: {url: p.url}})),
      ],
    });
    pendingImages = [];
  };

  const imgs = (i: number, list: string[] | undefined) => {
    if (!list?.length || !vision || !keepImages.has(i)) return [];
    return list
      .filter((rel) => fs.existsSync(path.join(projectDir(projectId), rel)))
      .map((rel) => ({label: rel, url: imageToDataUrl(projectId, rel)}));
  };

  history.forEach((m, i) => {
    if (m.role !== 'tool') flush();
    const old = i < history.length - KEEP_FULL_TOOL_RESULTS;
    if (m.role === 'user') {
      const im = imgs(i, m.images);
      const note = m.images?.length && !im.length ? `\n[attached: ${m.images.join(', ')}]` : '';
      out.push(
        im.length
          ? {role: 'user', content: [{type: 'text', text: m.content + note}, ...im.map((x) => ({type: 'image_url' as const, image_url: {url: x.url}}))]}
          : {role: 'user', content: m.content + note},
      );
    } else if (m.role === 'assistant') {
      if (!m.content && !m.tool_calls?.length) return; // empty turns only confuse the model
      out.push({
        role: 'assistant',
        content: m.content || (m.tool_calls?.length ? null : ''),
        ...(m.tool_calls?.length
          ? {tool_calls: m.tool_calls.map((t) => ({id: t.id, type: 'function' as const, function: {name: t.name, arguments: t.arguments || '{}'}}))}
          : {}),
      } as OpenAI.ChatCompletionAssistantMessageParam);
    } else if (m.role === 'tool') {
      let content = m.content;
      if (old && content.length > 1500) content = content.slice(0, 1500) + '\n…(older result truncated)';
      if (m.images?.length && !keepImages.has(i)) content += '\n[images from this older call omitted]';
      out.push({role: 'tool', tool_call_id: m.tool_call_id, content});
      pendingImages.push(...imgs(i, m.images));
    }
    // 'error' messages are UI-only.
  });
  flush();
  return out;
};

// ---------- Run state ----------

type Run = {abort: AbortController};
const runs = new Map<string, Run>();

export const isRunning = (projectId: string) => runs.has(projectId);
export const anyAgentRunning = () => runs.size > 0;
export const stopAgent = (projectId: string) => runs.get(projectId)?.abort.abort();

const send = (projectId: string, event: Record<string, unknown>) => emit({type: 'agent', projectId, ...event});

const clientFor = (p: Provider) =>
  new OpenAI({
    baseURL: p.baseURL,
    apiKey: p.apiKey || 'none',
    dangerouslyAllowBrowser: false,
    maxRetries: 2,
    defaultHeaders: {'HTTP-Referer': 'http://localhost', 'X-Title': 'Kinetik'},
  });

/** One streamed completion. Accumulates text + tool calls; emits deltas to the UI. */
const complete = async (
  projectId: string,
  provider: Provider,
  messages: OpenAI.ChatCompletionMessageParam[],
  signal: AbortSignal,
) => {
  const client = clientFor(provider);
  const params: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: provider.model,
    messages,
    tools: toolSchemas(),
    tool_choice: 'auto',
    stream: true,
  };
  if (provider.maxTokens) params.max_tokens = provider.maxTokens;
  if (provider.temperature !== undefined && provider.temperature !== null) params.temperature = provider.temperature;

  const stream = await client.chat.completions.create(params, {signal});
  let content = '';
  let reasoning = '';
  const calls: ToolCall[] = [];
  let finish: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d: any = choice.delta ?? {};
    if (d.content) {
      content += d.content;
      send(projectId, {event: 'delta', text: d.content});
    }
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === 'string' && r) {
      reasoning += r;
      send(projectId, {event: 'reasoning', text: r});
    }
    for (const tc of d.tool_calls ?? []) {
      let slot = typeof tc.index === 'number' ? calls[tc.index] : tc.id ? calls.find((c) => c.id === tc.id) : calls.at(-1);
      if (!slot || (tc.id && slot.id && slot.id !== tc.id && typeof tc.index !== 'number')) {
        slot = {id: tc.id ?? '', name: '', arguments: ''};
        if (typeof tc.index === 'number') calls[tc.index] = slot;
        else calls.push(slot);
      }
      if (tc.id) slot.id = tc.id;
      // Some proxies repeat the full name in every chunk; only append genuinely new parts.
      const n = tc.function?.name;
      if (n && n !== slot.name) slot.name = n.startsWith(slot.name) ? n : slot.name + n;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      send(projectId, {event: 'tool_progress', name: slot.name, chars: slot.arguments.length});
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const toolCalls = calls.filter(Boolean).map((c) => ({...c, id: c.id || `call_${mid()}`}));
  return {content, reasoning, toolCalls, finish};
};

export type RunInput = {
  text: string;
  images?: string[];
  providerId?: string;
  /** Edit/resend: drop this user message and everything after it, then send `text` in its place. */
  editFrom?: string;
  /** Override the configured step limit (tests). */
  maxSteps?: number;
};

/** Runs the agent loop for one user message. Resolves when the agent finishes or is stopped. */
export const runAgent = async (projectId: string, input: RunInput) => {
  if (runs.has(projectId)) throw new Error('Agent is already running for this project.');
  const provider = getProvider(input.providerId ?? getProject(projectId).providerId);
  if (!provider) throw new Error('No LLM provider configured. Open Settings.');
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL))
    throw new Error(`Provider "${provider.name}" has no API key. Open Settings.`);

  const abort = new AbortController();
  runs.set(projectId, {abort});
  const history = loadHistory(projectId);
  if (input.editFrom) {
    const at = history.findIndex((m) => m.id === input.editFrom && m.role === 'user');
    if (at < 0) {
      runs.delete(projectId);
      throw new Error('That message is no longer in the chat.');
    }
    history.splice(at);
    saveHistory(projectId, history);
    send(projectId, {event: 'history', messages: history});
  }
  const push = (m: StoredMessage) => {
    history.push(m);
    saveHistory(projectId, history);
    send(projectId, {event: 'message', message: m});
  };

  push({id: mid(), ts: Date.now(), role: 'user', content: input.text, images: input.images?.length ? input.images : undefined});
  send(projectId, {event: 'status', running: true});
  touchProject(projectId);

  const maxSteps = input.maxSteps ?? (getConfig().agent.maxSteps || 80);
  let toolsCalled = 0;
  let nudges = 0;
  let retries = 0;
  let transientRetries = 0;
  let endTurn = false;
  let oneTool = !!provider.oneToolPerTurn;
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (abort.signal.aborted) break;
      const project = getProject(projectId);
      const system = buildSystemPrompt(
        project,
        listSourceFiles(projectId),
        listAssets(projectId),
        provider.vision,
        oneTool,
        imageGenTarget(projectId).ready,
        ttsEngine(),
      );
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        {role: 'system', content: system},
        ...toOpenAI(projectId, history, provider.vision),
      ];
      send(projectId, {event: 'assistant_start'});
      let res: Awaited<ReturnType<typeof complete>>;
      try {
        res = await complete(projectId, provider, messages, abort.signal);
      } catch (e: any) {
        // Timeouts, rate limits and 5xx from the gateway: retry a couple of times instead of ending the run.
        const msg = String(e?.error?.message ?? e?.message ?? e);
        if (abort.signal.aborted || !TRANSIENT.test(msg) || transientRetries >= 2) throw e;
        transientRetries++;
        send(projectId, {event: 'retry', message: msg.slice(0, 200), attempt: transientRetries});
        await new Promise((r) => setTimeout(r, 2000 * transientRetries));
        if (/deadline|time.?out/i.test(msg)) push({id: mid(), ts: Date.now(), role: 'user', hidden: true, content: TOO_SLOW});
        continue;
      }
      // Gateway said "tool_calls" but delivered none: it dropped them (seen with proxies that can't pass parallel calls).
      const dropped = res.finish === 'tool_calls' && res.toolCalls.length === 0;
      if (res.content.trim() || res.toolCalls.length) {
        push({
          id: mid(),
          ts: Date.now(),
          role: 'assistant',
          content: res.content,
          reasoning: res.reasoning || undefined,
          tool_calls: res.toolCalls.length ? res.toolCalls : undefined,
          model: provider.model,
        });
      }
      if (dropped) {
        if (retries >= 3) {
          push({id: mid(), ts: Date.now(), role: 'error', content: 'The API gateway keeps dropping tool calls. Try another provider or model.'});
          break;
        }
        retries++;
        if (!oneTool) {
          oneTool = true;
          rememberOneTool(provider.id);
        }
        push({id: mid(), ts: Date.now(), role: 'user', hidden: true, content: DROPPED});
        continue;
      }
      if (!res.toolCalls.length) {
        if (!res.content.trim() && nudges >= 2) {
          push({id: mid(), ts: Date.now(), role: 'error', content: 'The model returned an empty reply.'});
          break;
        }
        if (res.finish === 'length') {
          push({id: mid(), ts: Date.now(), role: 'error', content: 'The model hit its output token limit.'});
          break;
        }
        // Some models announce a plan and stop. If nothing was built yet and the reply isn't a question, push it to act.
        const askedQuestion = /\?\s*$/.test(res.content.trim());
        if (toolsCalled === 0 && !askedQuestion && nudges < 2) {
          nudges++;
          push({id: mid(), ts: Date.now(), role: 'user', hidden: true, content: NUDGE});
          continue;
        }
        break;
      }
      toolsCalled += res.toolCalls.length;
      for (const tc of res.toolCalls) {
        if (abort.signal.aborted) {
          push({id: mid(), ts: Date.now(), role: 'tool', tool_call_id: tc.id, name: tc.name, content: 'Cancelled by user.', error: true});
          continue;
        }
        send(projectId, {event: 'tool_start', id: tc.id, name: tc.name, arguments: tc.arguments});
        const r = await runTool(tc.name, tc.arguments, {projectId, signal: abort.signal});
        push({
          id: mid(),
          ts: Date.now(),
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: r.content,
          images: r.images,
          error: r.error,
          display: r.display,
          styles: r.styles,
          questions: r.questions,
        });
        if (r.endTurn) endTurn = true;
      }
      if (endTurn) break; // e.g. style samples shown: wait for the user's choice
      if (step === maxSteps - 1) push({id: mid(), ts: Date.now(), role: 'error', content: `Stopped after ${maxSteps} steps.`});
    }
  } catch (e: any) {
    if (!abort.signal.aborted) {
      const msg = e?.error?.message ?? e?.message ?? String(e);
      push({id: mid(), ts: Date.now(), role: 'error', content: `LLM error: ${String(msg).slice(0, 1500)}`});
    }
  } finally {
    // Every tool call needs a matching tool result, otherwise the next request fails.
    const last = [...history].reverse().find((m) => m.role === 'assistant') as Extract<StoredMessage, {role: 'assistant'}> | undefined;
    if (last?.tool_calls) {
      for (const tc of last.tool_calls) {
        if (!history.some((m) => m.role === 'tool' && m.tool_call_id === tc.id)) {
          push({id: mid(), ts: Date.now(), role: 'tool', tool_call_id: tc.id, name: tc.name, content: 'Cancelled.', error: true});
        }
      }
    }
    if (abort.signal.aborted) push({id: mid(), ts: Date.now(), role: 'error', content: 'Stopped by user.'});
    runs.delete(projectId);
    send(projectId, {event: 'status', running: false});
  }
};
