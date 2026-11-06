/**
 * HTTP surface for subscription logins + the OpenAI-compatible gateway.
 *
 * Login routes drive the OAuth flows and report progress as JSON the UI polls.
 * The gateway route speaks OpenAI `chat.completions` streaming so Kinetik's
 * agent can use a logged-in subscription as if it were a plain API-key provider:
 * the provider's `apiKey` field carries the stored account id, and the gateway
 * resolves it to the right vendor wire protocol.
 */
import express, {type Request, type Response} from 'express';
import multer from 'multer';
import {generateSubscriptionImage, listSubscriptionModels, streamSubscription, DEFAULT_MODELS, type ChatRequest} from './gateway';
import {cancelLogin, loginInProgress, startLogin, type LoginKind, type LoginStatus} from './login';
import {listAccounts, removeAccount, type SubscriptionAccount} from './store';
import {syncSubscriptionProviders} from './sync';

export const subscriptionRouter = express.Router();

const KINDS: LoginKind[] = ['codex', 'claude', 'antigravity'];

const publicAccount = (a: SubscriptionAccount) => ({
  id: a.id,
  kind: a.kind,
  label: a.label,
  expiresAt: a.expiresAt,
  defaultModel: DEFAULT_MODELS[a.kind],
});

/** GET /api/subscriptions — list connected accounts + which logins are running. */
subscriptionRouter.get('/api/subscriptions', (_req, res) => {
  res.json({
    accounts: listAccounts().map(publicAccount),
    running: KINDS.filter(loginInProgress),
  });
});

/**
 * POST /api/subscriptions/:kind/login — start a login. Progress is delivered
 * over SSE on this same response so the UI shows the device code / browser
 * prompt live without polling.
 */
subscriptionRouter.post('/api/subscriptions/:kind/login', (req: Request, res: Response) => {
  const kind = req.params.kind as LoginKind;
  if (!KINDS.includes(kind)) {
    res.status(400).json({error: `Unknown provider: ${kind}`});
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (s: LoginStatus) => {
    // Register the new account as a provider before the UI reloads config.
    if (s.phase === 'done') syncSubscriptionProviders();
    res.write(`data: ${JSON.stringify(s)}\n\n`);
  };
  send({phase: 'exchanging', message: 'Starting login…'});
  startLogin(kind, send);
  req.on('close', () => cancelLogin(kind));
});

/** POST /api/subscriptions/:kind/cancel — abort an in-flight login. */
subscriptionRouter.post('/api/subscriptions/:kind/cancel', (req: Request, res: Response) => {
  cancelLogin(req.params.kind as LoginKind);
  res.json({ok: true});
});

/** DELETE /api/subscriptions/:id — disconnect an account. */
subscriptionRouter.delete('/api/subscriptions/:id', (req: Request, res: Response) => {
  removeAccount(String(req.params.id));
  syncSubscriptionProviders();
  res.json({ok: true});
});

const bearer = (req: Request) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
const imageUpload = multer({storage: multer.memoryStorage(), limits: {fileSize: 50 * 1024 * 1024}});

/** Shared handler for the OpenAI-style image endpoints; answers `{data: [{b64_json}]}`. */
const imageHandler = async (req: Request, res: Response) => {
  const key = bearer(req);
  if (!key) {
    res.status(401).json({error: {message: 'Missing account id in Authorization header'}});
    return;
  }
  const b = (req.body ?? {}) as Record<string, string>;
  if (!b.prompt) {
    res.status(400).json({error: {message: 'prompt is required'}});
    return;
  }
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  try {
    const png = await generateSubscriptionImage(key, {
      prompt: b.prompt,
      size: b.size,
      model: b.model,
      background: b.background as 'transparent' | 'opaque' | 'auto' | undefined,
      references: files.map((f) => ({data: f.buffer, mime: f.mimetype || 'image/png'})),
    });
    res.json({created: Math.floor(Date.now() / 1000), data: [{b64_json: png.toString('base64')}]});
  } catch (e) {
    res.status(502).json({error: {message: e instanceof Error ? e.message : String(e)}});
  }
};

/** POST /sub/v1/images/generations — text to image (JSON body). */
subscriptionRouter.post('/sub/v1/images/generations', imageHandler);
/** POST /sub/v1/images/edits — image(s) + prompt (multipart, `image` or `image[]`). */
subscriptionRouter.post('/sub/v1/images/edits', imageUpload.any(), imageHandler);

/** GET /sub/v1/models — OpenAI-style model list for the account named in `Authorization`. */
subscriptionRouter.get('/sub/v1/models', async (req: Request, res: Response) => {
  const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!key) {
    res.status(401).json({error: {message: 'Missing account id in Authorization header'}});
    return;
  }
  try {
    const ids = await listSubscriptionModels(key);
    res.json({object: 'list', data: ids.map((id) => ({id, object: 'model', owned_by: 'subscription'}))});
  } catch (e) {
    res.status(404).json({error: {message: e instanceof Error ? e.message : String(e)}});
  }
});

// ---------------------------------------------------------------------------
// OpenAI-compatible gateway
// ---------------------------------------------------------------------------

/**
 * POST /sub/v1/chat/completions — the OpenAI-compatible gateway. `Authorization:
 * Bearer <accountId>` selects the stored subscription; the body is a normal
 * OpenAI chat.completions request. Streams OpenAI-format chunks back.
 */
subscriptionRouter.post('/sub/v1/chat/completions', async (req: Request, res: Response) => {
  const auth = String(req.headers.authorization ?? '');
  const accountId = auth.replace(/^Bearer\s+/i, '').trim();
  if (!accountId) {
    res.status(401).json({error: {message: 'Missing account id in Authorization header'}});
    return;
  }
  const body = req.body as ChatRequest;
  if (!body?.messages?.length) {
    res.status(400).json({error: {message: 'messages is required'}});
    return;
  }

  // Non-streaming callers (character description, rig part detection) get one JSON reply.
  if (body.stream !== true) {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    let content = '';
    const calls: Array<{id: string; type: 'function'; function: {name: string; arguments: string}}> = [];
    let finish = 'stop';
    try {
      for await (const d of streamSubscription(accountId, body, ac.signal)) {
        content += d.content ?? '';
        for (const tc of d.tool_calls ?? []) {
          const c = (calls[tc.index] ??= {id: '', type: 'function', function: {name: '', arguments: ''}});
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name = tc.function.name;
          c.function.arguments += tc.function?.arguments ?? '';
        }
        if (d.finish_reason) finish = d.finish_reason;
      }
      res.json({
        id: 'chatcmpl-sub',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? '',
        choices: [{index: 0, message: {role: 'assistant', content, ...(calls.length ? {tool_calls: calls.filter(Boolean)} : {})}, finish_reason: finish}],
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = Number(/error (\d{3})/.exec(message)?.[1]);
      if (!res.headersSent) res.status(code >= 400 && code < 600 ? code : 502).json({error: {message, type: 'provider_error'}});
    }
    return;
  }

  // Headers go out with the first chunk, so an upstream error before any output can
  // still be answered as a real HTTP error: the agent then shows it as an error
  // instead of storing it as the model's reply.
  const startStream = () => {
    if (!res.headersSent) res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
  };
  const write = (obj: unknown) => {
    startStream();
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // Abort the upstream call when the client disconnects mid-stream.
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    for await (const delta of streamSubscription(accountId, body, ac.signal)) {
      write({
        id: `chatcmpl-sub`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? '',
        choices: [
          {
            index: 0,
            delta: {
              ...(delta.content ? {content: delta.content} : {}),
              ...(delta.reasoning ? {reasoning_content: delta.reasoning} : {}),
              ...(delta.tool_calls
                ? {
                    tool_calls: delta.tool_calls.map((tc) => ({
                      index: tc.index,
                      ...(tc.id ? {id: tc.id} : {}),
                      ...(tc.type ? {type: tc.type} : {}),
                      ...(tc.function ? {function: tc.function} : {}),
                    })),
                  }
                : {}),
            },
            finish_reason: delta.finish_reason ?? null,
          },
        ],
      });
    }
    startStream();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      const code = Number(/error (\d{3})/.exec(message)?.[1]);
      res.status(code >= 400 && code < 600 ? code : 502).json({error: {message, type: 'provider_error'}});
      return;
    }
    // Mid-stream: emit the error as a final chunk so the SDK surfaces it, then close.
    write({
      id: 'chatcmpl-sub',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? '',
      choices: [{index: 0, delta: {content: `\n\n[Provider error] ${message}`}, finish_reason: 'stop'}],
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});
