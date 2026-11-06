/**
 * Drives one login at a time for a subscription provider and turns it into a
 * stored account.
 *
 * Codex uses a device flow: we start it, hand the user a URL + code, and poll
 * until they approve. Claude and Antigravity use a browser authorization-code
 * flow with a loopback callback, so we bind the exact registered port for the
 * life of the flow — otherwise the browser lands on a dead page and the code
 * never reaches us.
 */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {
  ANTIGRAVITY,
  CLAUDE,
  buildAntigravityAuthorizeUrl,
  buildClaudeAuthorizeUrl,
  buildPkcePair,
  encodeMuseCredential,
  exchangeAntigravityCode,
  exchangeClaudeCode,
  exchangeCodexCode,
  mintMuseKey,
  pollCodexDevice,
  pollMuseDevice,
  randomState,
  startCodexDevice,
  startMuseDevice,
} from './oauth';
import {accountIdentity, shortHash, upsertAccount} from './store';

export type LoginKind = 'codex' | 'claude' | 'antigravity' | 'muse';

/** Progress reported to the UI while a login is in flight. */
export type LoginStatus =
  | {phase: 'awaiting_user'; message: string; url?: string; userCode?: string}
  | {phase: 'exchanging'; message: string}
  | {phase: 'done'; message: string; accountId: string; label: string}
  | {phase: 'error'; message: string};

type Waiter = (s: LoginStatus) => void;

/** One active login per kind — starting a second replaces the first. */
const active = new Map<LoginKind, {abort: AbortController; waiter: Waiter}>();

const isRunning = (kind: LoginKind) => active.has(kind);

function emit(kind: LoginKind, status: LoginStatus) {
  active.get(kind)?.waiter(status);
}

/**
 * Codex device flow. Returns the stored account id once approved. Polls on the
 * interval the endpoint states; a network error surfaces rather than silently
 * polling to expiry.
 */
async function loginCodex(waiter: Waiter, signal: AbortSignal): Promise<LoginStatus> {
  const started = await startCodexDevice();
  emit('codex', {
    phase: 'awaiting_user',
    message: `Open ${started.verificationUri} and enter code ${started.userCode}`,
    url: started.verificationUri,
    userCode: started.userCode,
  });
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    if (signal.aborted) return {phase: 'error', message: 'Login cancelled'};
    await sleep(started.interval * 1000);
    if (signal.aborted) return {phase: 'error', message: 'Login cancelled'};
    let auth: {authorizationCode: string; codeVerifier: string} | null;
    try {
      auth = await pollCodexDevice({deviceAuthId: started.deviceAuthId, userCode: started.userCode});
    } catch (e) {
      return {phase: 'error', message: e instanceof Error ? e.message : String(e)};
    }
    if (!auth) continue;
    emit('codex', {phase: 'exchanging', message: 'Exchanging code for tokens…'});
    const tokens = await exchangeCodexCode(auth.authorizationCode, auth.codeVerifier);
    const identity = accountIdentity('codex', tokens.label ?? '', shortHash(tokens.access));
    const acct = upsertAccount({
      identity,
      kind: 'codex',
      label: tokens.label ?? 'Codex account',
      accessToken: tokens.access,
      refreshToken: tokens.refresh,
      expiresAt: tokens.expiresAt,
      authState: tokens.accountId ? {accountId: tokens.accountId} : undefined,
    });
    return {phase: 'done', message: 'Codex connected', accountId: acct.id, label: acct.label};
  }
  return {phase: 'error', message: 'Codex login timed out'};
}

/**
 * Muse Code (Meta) device flow. Same shape as Codex: start a device login, hand
 * the user a URL + code, poll until approved, then mint the subscription api_key
 * the model backend accepts. The stored access token is the
 * `{oauthAccessToken, apiKey}` blob; the OAuth access token is parked in the
 * refresh slot so a re-mint can reuse it (Muse tokens do not expire).
 */
async function loginMuse(waiter: Waiter, signal: AbortSignal): Promise<LoginStatus> {
  const started = await startMuseDevice();
  emit('muse', {
    phase: 'awaiting_user',
    message: `Open ${started.verificationUri} and enter code ${started.userCode}`,
    url: started.verificationUri,
    userCode: started.userCode,
  });
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    if (signal.aborted) return {phase: 'error', message: 'Login cancelled'};
    await sleep(started.interval * 1000);
    if (signal.aborted) return {phase: 'error', message: 'Login cancelled'};
    let auth: {accessToken: string} | null;
    try {
      auth = await pollMuseDevice(started.deviceCode);
    } catch (e) {
      return {phase: 'error', message: e instanceof Error ? e.message : String(e)};
    }
    if (!auth) continue;
    emit('muse', {phase: 'exchanging', message: 'Minting your Muse Code key…'});
    const {apiKey, label} = await mintMuseKey(auth.accessToken);
    const identity = accountIdentity('muse', label ?? '', shortHash(apiKey));
    const acct = upsertAccount({
      identity,
      kind: 'muse',
      label: label ?? 'Muse Code account',
      accessToken: encodeMuseCredential(auth.accessToken, apiKey),
      refreshToken: auth.accessToken,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    return {phase: 'done', message: 'Muse Code connected', accountId: acct.id, label: acct.label};
  }
  return {phase: 'error', message: 'Muse login timed out'};
}

/**
 * Browser authorization-code flow with a loopback callback. Binds the exact
 * registered redirect port, opens the authorize URL, and completes the exchange
 * from inside the listener so the redirect delivers its code without the user
 * copying anything.
 */
async function loginBrowser(
  kind: 'claude' | 'antigravity',
  waiter: Waiter,
  signal: AbortSignal,
): Promise<LoginStatus> {
  const cfg = kind === 'claude' ? CLAUDE : ANTIGRAVITY;
  const redirect = new URL(cfg.redirectUri);
  const port = Number(redirect.port);
  const path = redirect.pathname || '/';
  const pkce = buildPkcePair();
  const state = randomState();
  const authorizeUrl = kind === 'claude' ? buildClaudeAuthorizeUrl(pkce, state) : buildAntigravityAuthorizeUrl(pkce, state);

  const codePromise = new Promise<{code?: string; error?: string}>((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (u.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code') ?? undefined;
      const error = u.searchParams.get('error_description') ?? u.searchParams.get('error') ?? undefined;
      const returnedState = u.searchParams.get('state');
      res.writeHead(200, {'content-type': 'text/html'});
      res.end(
        `<html><body style="font-family:system-ui;padding:2rem;text-align:center">` +
          `<h2>${error ? 'Login failed' : 'Almost done'}</h2>` +
          `<p>${error ? escapeHtml(error) : 'You can close this tab and return to Kinetik.'}</p>` +
          `</body></html>`,
      );
      // `state` is the correlation key; a mismatched or replayed callback is refused.
      if (returnedState !== state) resolve({error: 'State mismatch — please retry the login'});
      else resolve(code ? {code} : {error: error ?? 'No authorization code returned'});
      setTimeout(() => server.close(), 250);
    });
    server.on('error', (e) => resolve({error: `Could not bind port ${port}: ${e.message}`}));
    server.listen(port, '127.0.0.1');
    const close = () => server.close();
    signal.addEventListener('abort', close, {once: true});
  });

  emit(kind, {
    phase: 'awaiting_user',
    message: 'Complete the login in your browser…',
    url: authorizeUrl,
  });

  const opened = await import('node:child_process').then(({exec}) =>
    new Promise<void>((r) => {
      try {
        const start =
          process.platform === 'win32'
            ? `start "" "${authorizeUrl}"`
            : process.platform === 'darwin'
              ? `open "${authorizeUrl}"`
              : `xdg-open "${authorizeUrl}"`;
        exec(start, () => r());
      } catch {
        r();
      }
    }),
  );
  void opened;

  const result = await codePromise;
  if (result.error || !result.code) return {phase: 'error', message: result.error ?? 'Login did not complete'};
  emit(kind, {phase: 'exchanging', message: 'Exchanging code for tokens…'});
  const tokens =
    kind === 'claude'
      ? await exchangeClaudeCode(result.code, pkce.verifier)
      : await exchangeAntigravityCode(result.code, pkce.verifier);
  const identity = accountIdentity(kind, tokens.label ?? '', shortHash(tokens.access));
  const acct = upsertAccount({
    identity,
    kind,
    label: tokens.label ?? (kind === 'claude' ? 'Claude account' : 'Antigravity account'),
    accessToken: tokens.access,
    refreshToken: tokens.refresh,
    expiresAt: tokens.expiresAt,
  });
  return {phase: 'done', message: kind === 'claude' ? 'Claude connected' : 'Antigravity connected', accountId: acct.id, label: acct.label};
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a login. `onStatus` receives progress updates and the terminal
 * `done`/`error`. Starting a login for a kind that is already running cancels
 * the previous one.
 */
export const startLogin = (kind: LoginKind, onStatus: Waiter): void => {
  cancelLogin(kind);
  const abort = new AbortController();
  active.set(kind, {abort, waiter: onStatus});
  const run =
    kind === 'codex'
      ? loginCodex(onStatus, abort.signal)
      : kind === 'muse'
        ? loginMuse(onStatus, abort.signal)
        : loginBrowser(kind, onStatus, abort.signal);
  run
    .then((status) => {
      onStatus(status);
      if (active.get(kind)?.abort === abort) active.delete(kind);
    })
    .catch((e) => {
      onStatus({phase: 'error', message: e instanceof Error ? e.message : String(e)});
      if (active.get(kind)?.abort === abort) active.delete(kind);
    });
};

export const cancelLogin = (kind: LoginKind) => {
  active.get(kind)?.abort.abort();
  active.delete(kind);
};

export const loginInProgress = isRunning;
export const newToken = randomBytes;
