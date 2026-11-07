/**
 * A local OpenAI-compatible gateway for logged-in subscriptions.
 *
 * Kinetik's agent speaks OpenAI `chat.completions` through the `openai` SDK. A
 * subscription account is not an API key, though — each vendor serves its own
 * wire protocol and authenticates with an OAuth bearer token. So this gateway
 * accepts a normal streaming `chat.completions` request and translates it to the
 * provider's native endpoint, then translates the native SSE/JSON back into
 * `chat.completions` chunks the SDK understands.
 *
 * This is the same shape as Cartethyia's surface/provider adapter split, scoped
 * down to what a video agent needs: text, vision (image_url), and tool calling.
 */
import {getAccount, readAccessToken, readRefreshToken, updateAuthState, updateTokens, type SubscriptionAccount} from './store';
import {decodeMuseCredential, refreshAntigravity, refreshClaude, refreshCodex, refreshMuse} from './oauth';

// A minimal OpenAI chat.completions request as sent by the agent.
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{type: string; text?: string; image_url?: {url: string}}>;
  tool_calls?: Array<{id: string; type: 'function'; function: {name: string; arguments: string}}>;
  tool_call_id?: string;
  name?: string;
};
export type Tool = {type: 'function'; function: {name: string; description?: string; parameters: unknown}};
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: Tool[];
  tool_choice?: 'auto' | 'none' | {type: 'function'; function: {name: string}};
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
};

/** One normalized output chunk, mirroring an OpenAI streaming delta. */
export type OutDelta = {
  content?: string;
  reasoning?: string;
  tool_calls?: Array<{index: number; id?: string; type?: 'function'; function?: {name?: string; arguments?: string}}>;
  finish_reason?: string | null;
};

const textOf = (content: ChatMessage['content']): string => {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n');
};

const imagesOf = (content: ChatMessage['content']): string[] => {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === 'image_url' && p.image_url?.url).map((p) => p.image_url!.url);
};

/** Ensure a fresh access token, refreshing if it is at/near expiry. */
const freshToken = async (a: SubscriptionAccount): Promise<string> => {
  const margin = 120_000;
  if (a.expiresAt - margin > Date.now()) return readAccessToken(a);
  const refresh = readRefreshToken(a);
  if (!refresh) throw new Error(`${a.label}: access token expired and no refresh token stored`);
  const refresher =
    a.kind === 'codex'
      ? refreshCodex
      : a.kind === 'claude'
        ? refreshClaude
        : a.kind === 'muse'
          ? refreshMuse
          : refreshAntigravity;
  const t = await refresher(refresh);
  updateTokens(a.id, {accessToken: t.access, refreshToken: t.refresh, expiresAt: t.expiresAt});
  return t.access;
};

// ---------------------------------------------------------------------------
// SSE line reader (shared by all providers)
// ---------------------------------------------------------------------------

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const rest = buf.trim();
  if (rest.startsWith('data:')) yield rest.slice(5).trim();
}

const chunkFor = (delta: OutDelta, model: string, id: string, finish: string | null = null) => ({
  id,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{index: 0, delta, finish_reason: finish}],
});

// ---------------------------------------------------------------------------
// Claude Code — Anthropic Messages API
// ---------------------------------------------------------------------------

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_VERSION = '2023-06-01';
const CLAUDE_BETA = 'oauth-2025-04-20';

function toAnthropicMessages(req: ChatRequest) {
  const system: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: textOf(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content: Array<Record<string, unknown>> = [];
      const txt = textOf(m.content);
      if (txt) content.push({type: 'text', text: txt});
      for (const tc of m.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        content.push({type: 'tool_use', id: tc.id, name: tc.function.name, input: args});
      }
      messages.push({role: 'assistant', content});
      continue;
    }
    const images = imagesOf(m.content);
    if (images.length) {
      const content: Array<Record<string, unknown>> = [];
      const txt = textOf(m.content);
      if (txt) content.push({type: 'text', text: txt});
      for (const url of images) {
        const match = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (match) content.push({type: 'image', source: {type: 'base64', media_type: match[1], data: match[2]}});
      }
      messages.push({role: m.role, content});
      continue;
    }
    messages.push({role: m.role, content: textOf(m.content)});
  }
  const tools = req.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters,
  }));
  return {system: system.join('\n\n'), messages, tools};
}

async function* streamClaude(
  acct: SubscriptionAccount,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OutDelta> {
  const token = await freshToken(acct);
  const {system, messages, tools} = toAnthropicMessages(req);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? 8192,
    messages,
    stream: true,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools;
  if (req.temperature !== undefined) body.temperature = req.temperature;

  const res = await fetch(CLAUDE_MESSAGES_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
      'anthropic-version': CLAUDE_VERSION,
      'anthropic-beta': CLAUDE_BETA,
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.0.0 (external, cli)',
      'x-app': 'cli',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Claude error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
  let blockIndex = -1; // index of the current content/tool block
  let currentType: 'text' | 'tool' | null = null;
  let toolIndex = 0;
  for await (const data of sseEvents(res.body)) {
    if (!data || data === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'content_block_start': {
        blockIndex = ev.index;
        const b = ev.content_block ?? {};
        if (b.type === 'tool_use') {
          currentType = 'tool';
          yield {
            tool_calls: [{index: toolIndex, id: b.id, type: 'function', function: {name: b.name, arguments: ''}}],
          };
        } else {
          currentType = 'text';
        }
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && d.text) yield {content: d.text};
        else if (d.type === 'thinking_delta' && d.thinking) yield {reasoning: d.thinking};
        else if (d.type === 'input_json_delta' && d.partial_json)
          yield {tool_calls: [{index: toolIndex, function: {arguments: d.partial_json}}]};
        break;
      }
      case 'content_block_stop': {
        if (currentType === 'tool') toolIndex++;
        currentType = null;
        break;
      }
      case 'message_delta': {
        if (ev.delta?.stop_reason) {
          const fr = ev.delta.stop_reason === 'tool_use' ? 'tool_calls' : ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
          yield {finish_reason: fr};
        }
        break;
      }
      case 'error':
        throw new Error(`Claude stream error: ${JSON.stringify(ev.error ?? ev)}`);
    }
  }
  void id;
  void blockIndex;
}

// ---------------------------------------------------------------------------
// Codex — OpenAI Responses API (ChatGPT backend)
// ---------------------------------------------------------------------------

const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const CODEX_RESPONSES_URL = `${CODEX_BASE}/responses`;
/**
 * Codex client version we report. The backend hides models (and rejects them with
 * `model_not_found`) when this is below a model's `minimal_client_version`, so it
 * must stay ahead of the newest model's minimum (0.155.0 as of 2026-11).
 */
const CODEX_CLIENT_VERSION = '0.160.0';

const codexHeaders = (token: string, accountId?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
  originator: 'codex_cli_rs',
  version: CODEX_CLIENT_VERSION,
  ...(accountId ? {'chatgpt-account-id': accountId} : {}),
});

/** Models shown when the live list can't be fetched. */
const CODEX_FALLBACK_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

/** Live model list for a ChatGPT account, best first (the backend's own `priority`). */
async function listCodexModels(acct: SubscriptionAccount): Promise<string[]> {
  const token = await freshToken(acct);
  const accountId = typeof acct.authState?.accountId === 'string' ? acct.authState.accountId : undefined;
  const r = await fetch(`${CODEX_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`, {headers: codexHeaders(token, accountId)});
  if (!r.ok) throw new Error(`Codex models ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as {models?: Array<{slug: string; visibility?: string; priority?: number}>};
  return (j.models ?? [])
    .filter((m) => m.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => m.slug);
}

export type ImageRequest = {
  prompt: string;
  /** e.g. 1024x1024; snapped to a size the image tool supports. */
  size?: string;
  /** Model that drives the image tool. `gpt-image*` names (the image model itself) fall back to the default chat model. */
  model?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  /** Reference images to edit or match, as PNG/JPEG bytes. */
  references?: Array<{data: Buffer; mime: string}>;
};

const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
const snapImageSize = (size?: string): string => {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  if (!m) return '1024x1024';
  if (IMAGE_SIZES.includes(size!)) return size!;
  const ratio = +m[1] / +m[2];
  return ratio > 1.2 ? '1536x1024' : ratio < 0.83 ? '1024x1536' : '1024x1024';
};

/**
 * Generate (or, with references, edit) an image through ChatGPT's hosted
 * `image_generation` tool, so a Codex login covers images without an API key.
 */
async function generateCodexImage(acct: SubscriptionAccount, req: ImageRequest): Promise<Buffer> {
  const token = await freshToken(acct);
  const accountId = typeof acct.authState?.accountId === 'string' ? acct.authState.accountId : undefined;
  const model = req.model && !/gpt-image|dall-e/i.test(req.model) ? req.model : DEFAULT_MODELS.codex;
  const content: Array<Record<string, unknown>> = [{type: 'input_text', text: req.prompt}];
  for (const r of req.references ?? []) content.push({type: 'input_image', image_url: `data:${r.mime};base64,${r.data.toString('base64')}`});
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'text/event-stream', ...codexHeaders(token, accountId)},
    body: JSON.stringify({
      model,
      instructions: req.references?.length
        ? 'Create the requested image with the image_generation tool, using the attached image(s) as the reference to edit or match.'
        : 'Create the requested image with the image_generation tool.',
      input: [{role: 'user', content}],
      tools: [{type: 'image_generation', output_format: 'png', size: snapImageSize(req.size), ...(req.background ? {background: req.background} : {})}],
      tool_choice: {type: 'image_generation'},
      stream: true,
      store: false,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Codex image error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let failure = '';
  for await (const data of sseEvents(res.body)) {
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_item.done' && ev.item?.type === 'image_generation_call' && ev.item.result)
      return Buffer.from(ev.item.result, 'base64');
    if (ev.type === 'response.failed' || ev.type === 'error') failure = JSON.stringify(ev.response?.error ?? ev.error ?? ev).slice(0, 300);
  }
  throw new Error(`Codex returned no image${failure ? `: ${failure}` : ''}`);
}

/** Antigravity's image model (Gemini); edits when references are attached. */
const ANTIGRAVITY_IMAGE_MODEL = 'gemini-3.1-flash-image';
const ASPECTS: Array<[string, number]> = [['1:1', 1], ['3:2', 1.5], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4]];
const aspectFor = (size?: string) => {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  const r = m ? +m[1] / +m[2] : 1;
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r)) ? a : best))[0];
};

async function generateAntigravityImage(acct: SubscriptionAccount, req: ImageRequest): Promise<Buffer> {
  const token = await freshToken(acct);
  const project = await antigravityProject(acct, token);
  const model = req.model && /gemini.*image/i.test(req.model) ? req.model : ANTIGRAVITY_IMAGE_MODEL;
  const parts: Array<Record<string, unknown>> = (req.references ?? []).map((r) => ({inlineData: {mimeType: r.mime, data: r.data.toString('base64')}}));
  parts.push({text: req.prompt});
  const res = await fetch(`${ANTIGRAVITY_BASE}/v1internal:generateContent`, {
    method: 'POST',
    headers: await antigravityHeaders(token),
    body: JSON.stringify({
      model,
      project,
      userAgent: 'antigravity',
      requestId: `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      request: {contents: [{role: 'user', parts}], generationConfig: {responseModalities: ['IMAGE'], imageConfig: {aspectRatio: aspectFor(req.size)}}},
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Antigravity image error ${res.status}: ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  const img = ((j.response ?? j).candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
  if (!img) throw new Error(`Antigravity returned no image: ${JSON.stringify(j).slice(0, 300)}`);
  return Buffer.from(img.inlineData.data, 'base64');
}

/** Account kinds that can draw images. */
export const IMAGE_KINDS = new Set(['codex', 'antigravity']);

/** Image generation for a subscription account: Codex (ChatGPT image tool) or Antigravity (Gemini image). */
export async function generateSubscriptionImage(accountKey: string, req: ImageRequest): Promise<Buffer> {
  const acct = accountFromKey(accountKey);
  if (acct.kind === 'codex') return generateCodexImage(acct, req);
  if (acct.kind === 'antigravity') return generateAntigravityImage(acct, req);
  throw new Error('This account cannot make images. Use a Codex or Antigravity account (Settings → Image generation).');
}

function toResponsesPayload(req: ChatRequest) {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      instructions.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: textOf(m.content),
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const txt = textOf(m.content);
      if (txt) input.push({role: 'assistant', content: [{type: 'output_text', text: txt}]});
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    if (m.role === 'assistant') {
      // The Responses API only takes output_text (or refusal) in assistant turns.
      const txt = textOf(m.content);
      if (txt) input.push({role: 'assistant', content: [{type: 'output_text', text: txt}]});
      continue;
    }
    const images = imagesOf(m.content);
    const parts: Array<Record<string, unknown>> = [];
    const txt = textOf(m.content);
    if (txt) parts.push({type: 'input_text', text: txt});
    for (const url of images) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match) parts.push({type: 'input_image', image_url: `data:${match[1]};base64,${match[2]}`});
    }
    if (parts.length) input.push({role: 'user', content: parts});
  }
  const tools = req.tools?.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: t.function.parameters,
  }));
  return {
    model: req.model,
    instructions: instructions.join('\n\n'),
    input,
    ...(tools?.length ? {tools, tool_choice: 'auto'} : {}),
    stream: true,
    store: false,
  };
}

async function* streamCodex(
  acct: SubscriptionAccount,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OutDelta> {
  const token = await freshToken(acct);
  const accountId = typeof acct.authState?.accountId === 'string' ? acct.authState.accountId : undefined;
  const payload = toResponsesPayload(req);
  const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...codexHeaders(token, accountId),
      'OpenAI-Beta': 'responses=experimental',
      session_id: sessionId,
      conversation_id: sessionId,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`Codex error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  yield* consumeResponsesSSE(res.body, 'Codex');
}

/**
 * Muse Code (Meta) — OpenAI Responses wire at `api.meta.ai/v1`, authenticated
 * with the per-subscription api_key minted at login (unwrapped from the stored
 * credential blob). Same event stream as Codex, so it shares the parser.
 */
const MUSE_RESPONSES_URL = 'https://api.meta.ai/v1/responses';

async function* streamMuse(
  acct: SubscriptionAccount,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OutDelta> {
  const blob = await freshToken(acct);
  const {apiKey} = decodeMuseCredential(blob);
  const payload = toResponsesPayload(req);
  const res = await fetch(MUSE_RESPONSES_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`Muse error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  yield* consumeResponsesSSE(res.body, 'Muse');
}

/** Translate an OpenAI Responses SSE stream into normalized output deltas. */
async function* consumeResponsesSSE(
  body: ReadableStream<Uint8Array>,
  label: string,
): AsyncGenerator<OutDelta> {
  let toolIndex = 0;
  const toolCallIds = new Map<number, string>();
  const calls = new Map<string, {index: number; sent: string}>();
  for await (const data of sseEvents(body)) {
    if (!data || data === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    const type = ev.type ?? '';
    if (type === 'response.output_text.delta' && ev.delta) yield {content: ev.delta};
    else if (type === 'response.reasoning_summary_text.delta' && ev.delta) yield {reasoning: ev.delta};
    else if (type === 'response.output_item.added' && ev.item?.type === 'function_call') {
      // Index tool calls by the item they belong to: calls can be announced before
      // their arguments arrive, so arrival order is not enough.
      const index = toolIndex++;
      calls.set(ev.item.id, {index, sent: ev.item.arguments ?? ''});
      toolCallIds.set(index, ev.item.call_id ?? ev.item.id);
      yield {
        tool_calls: [
          {index, id: ev.item.call_id ?? ev.item.id, type: 'function', function: {name: ev.item.name, arguments: ev.item.arguments ?? ''}},
        ],
      };
    } else if (type === 'response.function_call_arguments.delta' && ev.delta) {
      const c = calls.get(ev.item_id);
      if (!c) continue;
      c.sent += ev.delta;
      yield {tool_calls: [{index: c.index, function: {arguments: ev.delta}}]};
    } else if (
      (type === 'response.function_call_arguments.done' && typeof ev.arguments === 'string') ||
      (type === 'response.output_item.done' && ev.item?.type === 'function_call')
    ) {
      // Newer models skip the deltas and send the arguments only here.
      const c = calls.get(ev.item_id ?? ev.item?.id);
      const full: string = ev.arguments ?? ev.item?.arguments ?? '';
      if (!c || !full || c.sent === full) continue;
      if (full.startsWith(c.sent)) {
        yield {tool_calls: [{index: c.index, function: {arguments: full.slice(c.sent.length)}}]};
        c.sent = full;
      }
    } else if (type === 'response.completed' || type === 'response.failed') {
      const resp = ev.response ?? {};
      const status = resp.status;
      if (status === 'failed') throw new Error(`${label} response failed: ${JSON.stringify(resp.error ?? resp)}`);
      const incomplete = resp.incomplete_details?.reason === 'max_output_tokens';
      yield {finish_reason: incomplete ? 'length' : toolIndex > 0 ? 'tool_calls' : 'stop'};
    } else if (type === 'error') {
      throw new Error(`${label} stream error: ${JSON.stringify(ev)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Antigravity — Google generateContent (Cloud Code)
// ---------------------------------------------------------------------------

// The daily surface is what Antigravity itself calls; the prod `cloudcode-pa`
// host answers 429 for the same free-tier account.
const ANTIGRAVITY_BASE = 'https://daily-cloudcode-pa.googleapis.com';
const ANTIGRAVITY_METADATA = {ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI'};

/**
 * The backend gates model access on the Antigravity client version in the
 * User-Agent and refuses stale ones with "This version of Antigravity is no
 * longer supported". The real client is `antigravity/hub/<version>
 * (aidev_client; os_type=…; arch=…; cl=…)`. We discover the newest version from
 * the app's own auto-updater manifest and fall back to a recent pin; the
 * backend gates on the version, not on the opaque `cl`/os/arch fields.
 */
const ANTIGRAVITY_UPDATER = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app';
const ANTIGRAVITY_UA_FALLBACK_VERSION = '2.29.0';
let antigravityVersion: {value: string; until: number} | null = null;

/** Reads a version out of the updater's answers: a YAML manifest or its "Stable Version: x.y.z" status line. */
const versionIn = (text: string) => {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    const v = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
    if (v && /^\d+(\.\d+)*$/.test(v)) return v;
  }
  return /Stable Version:\s*(\d+(?:\.\d+)+)/i.exec(text)?.[1];
};

const resolveAntigravityVersion = async (): Promise<string> => {
  if (antigravityVersion && Date.now() < antigravityVersion.until) return antigravityVersion.value;
  // The manifest path has answered 404 at times; the updater's root page names the stable version.
  for (const url of [`${ANTIGRAVITY_UPDATER}/manifest/latest-win32-x64.yml`, `${ANTIGRAVITY_UPDATER}/`]) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(5000)});
      const v = r.ok ? versionIn(await r.text()) : undefined;
      if (v) return (antigravityVersion = {value: v, until: Date.now() + 6 * 3600_000}).value;
    } catch {
      /* slow or offline: try the next source */
    }
  }
  // Retry the lookup in 10 minutes rather than pinning the fallback for the whole session.
  return (antigravityVersion = {value: antigravityVersion?.value ?? ANTIGRAVITY_UA_FALLBACK_VERSION, until: Date.now() + 10 * 60_000}).value;
};

const antigravityHeaders = async (token: string): Promise<Record<string, string>> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'user-agent': `antigravity/hub/${await resolveAntigravityVersion()} (aidev_client; os_type=windows; arch=amd64; cl=963137146)`,
});

/**
 * Gemini 3 returns a `thoughtSignature` with each function call and rejects a
 * replayed call without it. The agent only round-trips OpenAI tool calls, so the
 * signature is kept here, keyed by the tool call id we handed out.
 */
const thoughtSignatures = new Map<string, string>();
const rememberSignature = (callId: string, sig: string) => {
  thoughtSignatures.set(callId, sig);
  if (thoughtSignatures.size > 2000) thoughtSignatures.delete(thoughtSignatures.keys().next().value!);
};
/** Google's documented placeholder for calls whose signature was lost (e.g. after a server restart). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/**
 * The Cloud Code project the account calls through. `loadCodeAssist` reports it;
 * a first-time account gets one from `onboardUser`. Cached on the account.
 */
async function antigravityProject(acct: SubscriptionAccount, token: string): Promise<string> {
  const cached = acct.authState?.projectId;
  if (typeof cached === 'string' && cached) return cached;
  const post = async (method: string, body: unknown) => {
    const r = await fetch(`${ANTIGRAVITY_BASE}/v1internal:${method}`, {method: 'POST', headers: await antigravityHeaders(token), body: JSON.stringify(body)});
    if (!r.ok) throw new Error(`Antigravity ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as any;
  };
  const projectOf = (v: any): string | undefined => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : undefined);
  const loaded = await post('loadCodeAssist', {metadata: ANTIGRAVITY_METADATA});
  let project = projectOf(loaded.cloudaicompanionProject);
  if (!project) {
    const tier = (loaded.allowedTiers ?? []).find((t: any) => t.isDefault)?.id ?? 'free-tier';
    const onboarded = await post('onboardUser', {tierId: tier, metadata: ANTIGRAVITY_METADATA});
    project = projectOf(onboarded.response?.cloudaicompanionProject);
  }
  if (!project) throw new Error('Antigravity: this Google account has no Cloud Code project. Open Antigravity once to finish setup, then retry.');
  updateAuthState(acct.id, {projectId: project});
  return project;
}

/** Drop JSON Schema keywords the Gemini function schema rejects. */
const cleanSchema = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(cleanSchema);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '$schema' || k === 'additionalProperties') continue;
    out[k] = cleanSchema(val);
  }
  return out;
};

function toGooglePayload(req: ChatRequest) {
  const contents: Array<{role: string; parts: Array<Record<string, unknown>>}> = [];
  // Tool results arrive without the function name; recover it from the call.
  const callNames = new Map<string, string>();
  const system: string[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      const part = {functionResponse: {id, name: m.name ?? callNames.get(id) ?? 'tool', response: {result: textOf(m.content)}}};
      // Gemini wants all responses to one turn's calls in a single content.
      const last = contents.at(-1);
      if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) last.parts.push(part);
      else contents.push({role: 'user', parts: [part]});
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      const txt = textOf(m.content);
      if (txt) parts.push({text: txt});
      for (const tc of m.tool_calls) {
        callNames.set(tc.id, tc.function.name);
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {id: tc.id, name: tc.function.name, args},
          // Gemini 3 and Claude-on-Antigravity both gate tool calls on a
          // thought signature. Send the one captured at call time, or Google's
          // documented placeholder when it was lost (e.g. after a restart).
          thoughtSignature: thoughtSignatures.get(tc.id) ?? SKIP_SIGNATURE,
        });
      }
      contents.push({role: 'model', parts});
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    const txt = textOf(m.content);
    if (txt) parts.push({text: txt});
    for (const url of imagesOf(m.content)) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match) parts.push({inlineData: {mimeType: match[1], data: match[2]}});
    }
    if (parts.length) contents.push({role: m.role === 'assistant' ? 'model' : 'user', parts});
  }
  const tools = req.tools?.length
    ? [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description ?? '',
            parameters: cleanSchema(t.function.parameters),
          })),
        },
      ]
    : undefined;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  const generationConfig = {
    ...(maxTokens ? {maxOutputTokens: maxTokens} : {}),
    ...(typeof req.temperature === 'number' ? {temperature: req.temperature} : {}),
  };
  return {
    contents,
    ...(system.length ? {systemInstruction: {role: 'user', parts: [{text: system.join('\n\n')}]}} : {}),
    ...(tools ? {tools} : {}),
    ...(Object.keys(generationConfig).length ? {generationConfig} : {}),
  };
}

/**
 * Antigravity requires a stable per-conversation session identity on every
 * turn: `agentId`, `trajectoryId`, `sessionId`, and a `labels` block carrying
 * the step index. Without them the backend rejects the turn. Keyed by account.
 */
type AntigravitySession = {agentId: string; trajectoryId: string; sessionId: string; step: number};
const antigravitySessions = new Map<string, AntigravitySession>();
const sessionFor = (accountId: string): AntigravitySession => {
  const existing = antigravitySessions.get(accountId);
  if (existing) return existing;
  const s: AntigravitySession = {
    agentId: crypto.randomUUID(),
    trajectoryId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    step: 0,
  };
  antigravitySessions.set(accountId, s);
  return s;
};

async function* streamAntigravity(
  acct: SubscriptionAccount,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OutDelta> {
  const token = await freshToken(acct);
  const project = await antigravityProject(acct, token);
  const session = sessionFor(acct.id);
  session.step += 1;
  // Cloud Code's `v1internal` surface wraps a normal generateContent request in
  // an Antigravity "agent" envelope: the wire model id travels on the envelope,
  // while the Gemini contents/tools/labels ride inside `request`.
  const envelope = {
    requestId: `agent/${session.agentId}/${Date.now()}/${session.trajectoryId}/${session.step}`,
    model: req.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    project,
    request: {
      ...toGooglePayload(req),
      labels: {
        trajectory_id: session.trajectoryId,
        last_step_index: String(session.step - 1),
      },
      sessionId: session.sessionId,
    },
  };
  const res = await fetch(`${ANTIGRAVITY_BASE}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: {...(await antigravityHeaders(token)), accept: 'text/event-stream'},
    body: JSON.stringify(envelope),
  });
  if (!res.ok || !res.body) throw new Error(`Antigravity error ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let toolIndex = 0;
  for await (const data of sseEvents(res.body)) {
    if (!data || data === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    const candidate = (ev.response ?? ev).candidates?.[0];
    if (!candidate) continue;
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        const id = part.functionCall.id || `call_${Math.random().toString(36).slice(2)}`;
        if (part.thoughtSignature) rememberSignature(id, part.thoughtSignature);
        yield {
          tool_calls: [
            {
              index: toolIndex,
              id,
              type: 'function',
              function: {name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {})},
            },
          ],
        };
        toolIndex++;
      } else if (part.thought) {
        if (part.text) yield {reasoning: part.text};
      } else if (part.text) yield {content: part.text};
    }
    if (candidate.finishReason) {
      const fr = candidate.finishReason === 'MAX_TOKENS' ? 'length' : toolIndex > 0 ? 'tool_calls' : 'stop';
      yield {finish_reason: fr};
    }
  }
}

/** Sort key: Gemini first, then Claude, then the rest. */
const family = (id: string) => (/^gemini/.test(id) ? 0 : /^claude/.test(id) ? 1 : 2);

/** Chat models the account can use, from Cloud Code's own catalog. */
async function listAntigravityModels(acct: SubscriptionAccount): Promise<string[]> {
  const token = await freshToken(acct);
  const project = await antigravityProject(acct, token);
  const r = await fetch(`${ANTIGRAVITY_BASE}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: await antigravityHeaders(token),
    body: JSON.stringify({project}),
  });
  if (!r.ok) throw new Error(`Antigravity models ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as {models?: Record<string, {displayName?: string; quotaInfo?: {resetTime?: string}}>};
  // Chat models carry a quota reset time; internal autocomplete/tab models don't. Image models can't drive the agent.
  return Object.entries(j.models ?? {})
    .filter(([id, m]) => m.quotaInfo?.resetTime && !/image/i.test(id))
    .map(([id]) => id)
    .sort((a, b) => family(a) - family(b) || b.localeCompare(a, undefined, {numeric: true}));
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Look up the account behind a gateway API key. Providers carry their own id
 * (`sub:<accountId>`) in the key slot, so strip that prefix before the lookup.
 */
const accountFromKey = (key: string): SubscriptionAccount => {
  const id = key.replace(/^sub:/, '');
  const acct = getAccount(id);
  if (!acct) throw new Error(`Unknown subscription account: ${id}`);
  return acct;
};

/** Stream a chat.completions-shaped request against a stored subscription. */
export async function* streamSubscription(
  accountKey: string,
  req: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<OutDelta> {
  const acct = accountFromKey(accountKey);
  const gen =
    acct.kind === 'codex'
      ? streamCodex
      : acct.kind === 'claude'
        ? streamClaude
        : acct.kind === 'muse'
          ? streamMuse
          : streamAntigravity;
  yield* gen(acct, req, signal);
}

/** Model ids the account can use, for the Settings model picker. */
export async function listSubscriptionModels(accountKey: string): Promise<string[]> {
  const acct = accountFromKey(accountKey);
  if (acct.kind === 'codex') {
    try {
      const live = await listCodexModels(acct);
      if (live.length) return live;
    } catch (e) {
      console.warn('[subscription] codex model list failed, using fallback:', e instanceof Error ? e.message : e);
    }
    return CODEX_FALLBACK_MODELS;
  }
  if (acct.kind === 'muse') return MUSE_MODELS;
  if (acct.kind === 'antigravity') {
    try {
      const live = await listAntigravityModels(acct);
      if (live.length) return live;
    } catch (e) {
      console.warn('[subscription] antigravity model list failed:', e instanceof Error ? e.message : e);
    }
  }
  return [DEFAULT_MODELS[acct.kind]];
}

/** Defaults that the vendor has since retired; synced providers using one get moved to the current default. */
export const RETIRED_MODELS = new Set(['gpt-5.1-codex', 'gemini-3-pro-preview']);

/** Default model ids per provider kind (used when registering the provider). */
export const DEFAULT_MODELS: Record<LoginKindAlias, string> = {
  codex: 'gpt-6-sol',
  claude: 'claude-sonnet-4-5',
  antigravity: 'gemini-3-flash',
  muse: 'muse-spark-1.3',
};
type LoginKindAlias = 'codex' | 'claude' | 'antigravity' | 'muse';

/** Models a Muse Code account can use (from Cartethyia's `muse-code` catalog). */
const MUSE_MODELS = [
  'muse-spark-1.3',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2',
  'muse-spark-1.2-contributor',
  'muse-spark-1.1',
];
