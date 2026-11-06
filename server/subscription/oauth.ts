/**
 * OAuth login clients for subscription providers, following Cartethyia's
 * provider integrations. Three flows:
 *  - Codex (OpenAI ChatGPT subscription): RFC 8628 device flow — easiest for a
 *    local app, no callback port needed. User opens a URL and types a code.
 *  - Claude Code (Anthropic Pro/Max): authorization-code + PKCE with a loopback
 *    callback the app binds for the life of the flow.
 *  - Antigravity (Google): authorization-code + PKCE with a loopback callback.
 *
 * client_id values are the public identities baked into each vendor's own CLI;
 * they are not secrets. redirect_uri values must match the vendor's registered
 * allowlist exactly (host spelling and port), or the authorize step rejects
 * before any consent screen.
 */
import {createHash, randomBytes} from 'node:crypto';

export type PkcePair = {verifier: string; challenge: string};

export const randomState = (): string => randomBytes(24).toString('base64url');

export const buildPkcePair = (): PkcePair => {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return {verifier, challenge};
};

const form = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

const readJson = async (res: Response, what: string): Promise<Record<string, unknown>> => {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what}: invalid response (${res.status})`);
  }
  if (!res.ok) {
    const detail =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).error_description ??
          (body as Record<string, unknown>).error ??
          text.slice(0, 200)
        : text.slice(0, 200);
    throw new Error(`${what} failed (${res.status}): ${String(detail)}`);
  }
  return body as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Codex — device flow
// ---------------------------------------------------------------------------

export const CODEX = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  deviceUserCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  verificationUri: 'https://auth.openai.com/codex/device',
};

export type DeviceStart = {deviceAuthId: string; userCode: string; interval: number; verificationUri: string};

export const startCodexDevice = async (): Promise<DeviceStart> => {
  const res = await fetch(CODEX.deviceUserCodeUrl, {
    method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({client_id: CODEX.clientId}),
  });
  const body = await readJson(res, 'Codex device authorization');
  if (typeof body.device_auth_id !== 'string' || typeof body.user_code !== 'string')
    throw new Error('Codex device authorization returned an invalid response');
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    interval: typeof body.interval === 'number' ? body.interval : 5,
    verificationUri: CODEX.verificationUri,
  };
};

/** One poll attempt. Returns null while the user has not approved yet. */
export const pollCodexDevice = async (
  d: {deviceAuthId: string; userCode: string},
): Promise<{authorizationCode: string; codeVerifier: string} | null> => {
  let res: Response;
  try {
    res = await fetch(CODEX.deviceTokenUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({device_auth_id: d.deviceAuthId, user_code: d.userCode}),
    });
  } catch (e) {
    throw new Error(`Codex device polling failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 403/404 are the endpoint's "not approved yet" answers, not failures.
  if (res.status === 403 || res.status === 404) return null;
  const body = await readJson(res, 'Codex device poll');
  if (typeof body.authorization_code === 'string' && typeof body.code_verifier === 'string')
    return {authorizationCode: body.authorization_code, codeVerifier: body.code_verifier};
  return null;
};

/** Exchange the device-flow authorization code for tokens. */
export const exchangeCodexCode = async (
  code: string,
  codeVerifier: string,
): Promise<{access: string; refresh: string; expiresAt: number; label?: string; accountId?: string}> => {
  const res = await fetch(CODEX.tokenUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form({
      grant_type: 'authorization_code',
      client_id: CODEX.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CODEX.deviceRedirectUri,
    }),
  });
  const body = await readJson(res, 'Codex token exchange');
  const access = body.access_token;
  const refresh = body.refresh_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Codex token response omitted access/refresh/expires_in');
  const profile = decodeCodexProfile(access, body.id_token);
  return {
    access,
    refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    label: profile.email,
    accountId: profile.accountId,
  };
};

/** Pull the ChatGPT account id + email out of the JWT claims. */
export const decodeCodexProfile = (
  accessToken: string,
  idToken?: unknown,
): {accountId?: string; email?: string} => {
  const authClaim = 'https://api.openai.com/auth';
  const profileClaim = 'https://api.openai.com/profile';
  const accessClaims = decodeJwt(accessToken);
  const idClaims = typeof idToken === 'string' ? decodeJwt(idToken) : undefined;
  const auth = pickRecord(accessClaims?.[authClaim]) ?? pickRecord(idClaims?.[authClaim]);
  const profile = pickRecord(accessClaims?.[profileClaim]) ?? pickRecord(idClaims?.[profileClaim]);
  const accountId = str(auth?.chatgpt_account_id);
  const email = str(profile?.email);
  return {...(accountId ? {accountId} : {}), ...(email ? {email} : {})};
};

export const refreshCodex = async (
  refreshToken: string,
): Promise<{access: string; refresh?: string; expiresAt: number}> => {
  const res = await fetch(CODEX.tokenUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form({grant_type: 'refresh_token', client_id: CODEX.clientId, refresh_token: refreshToken}),
  });
  const body = await readJson(res, 'Codex token refresh');
  const access = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Codex refresh response omitted access/expires_in');
  return {
    access,
    ...(typeof body.refresh_token === 'string' ? {refresh: body.refresh_token} : {}),
    expiresAt: Date.now() + expiresIn * 1000,
  };
};

// ---------------------------------------------------------------------------
// Claude Code — authorization code + PKCE (browser)
// ---------------------------------------------------------------------------

export const CLAUDE = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
  redirectUri: 'http://localhost:54545/callback',
  scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
};

export const buildClaudeAuthorizeUrl = (pkce: PkcePair, state: string): string => {
  const u = new URL(CLAUDE.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLAUDE.clientId);
  u.searchParams.set('redirect_uri', CLAUDE.redirectUri);
  u.searchParams.set('scope', CLAUDE.scope);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
};

export const exchangeClaudeCode = async (
  code: string,
  codeVerifier: string,
): Promise<{access: string; refresh: string; expiresAt: number; label?: string}> => {
  const res = await fetch(CLAUDE.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'User-Agent': 'anthropic-sdk-typescript/0.60.0 userOAuthProvider',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLAUDE.clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: CLAUDE.redirectUri,
    }),
  });
  const body = await readJson(res, 'Claude token exchange');
  const access = body.access_token;
  const refresh = body.refresh_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Claude token response is missing required fields');
  const acct = pickRecord(body.account);
  const org = pickRecord(body.organization);
  const label = str(acct?.email_address) ?? str(org?.name);
  return {access, refresh, expiresAt: Date.now() + expiresIn * 1000, ...(label ? {label} : {})};
};

export const refreshClaude = async (
  refreshToken: string,
): Promise<{access: string; refresh?: string; expiresAt: number}> => {
  const res = await fetch(CLAUDE.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'User-Agent': 'anthropic-sdk-typescript/0.60.0 userOAuthProvider',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLAUDE.clientId,
      refresh_token: refreshToken,
    }),
  });
  const body = await readJson(res, 'Claude token refresh');
  const access = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Claude refresh response is missing required fields');
  return {
    access,
    ...(typeof body.refresh_token === 'string' ? {refresh: body.refresh_token} : {}),
    expiresAt: Date.now() + expiresIn * 1000,
  };
};

// ---------------------------------------------------------------------------
// Antigravity — Google OAuth + PKCE (browser)
// ---------------------------------------------------------------------------

export const ANTIGRAVITY = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  // Identifies the client application, not an account. Stored base64 to keep a
  // `GOCSPX-` literal out of source, matching Cartethyia.
  clientSecret: Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=', 'base64').toString('utf8'),
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  redirectUri: 'http://127.0.0.1:51121/oauth-callback',
  userinfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
  scope: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ].join(' '),
};

export const buildAntigravityAuthorizeUrl = (pkce: PkcePair, state: string): string => {
  const u = new URL(ANTIGRAVITY.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', ANTIGRAVITY.clientId);
  u.searchParams.set('redirect_uri', ANTIGRAVITY.redirectUri);
  u.searchParams.set('scope', ANTIGRAVITY.scope);
  u.searchParams.set('code_challenge', pkce.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
};

export const exchangeAntigravityCode = async (
  code: string,
  codeVerifier: string,
): Promise<{access: string; refresh: string; expiresAt: number; label?: string}> => {
  const res = await fetch(ANTIGRAVITY.tokenUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form({
      grant_type: 'authorization_code',
      client_id: ANTIGRAVITY.clientId,
      client_secret: ANTIGRAVITY.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: ANTIGRAVITY.redirectUri,
    }),
  });
  const body = await readJson(res, 'Antigravity token exchange');
  const access = body.access_token;
  const refresh = body.refresh_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Antigravity token response is missing required fields');
  let label: string | undefined;
  try {
    const ui = await (
      await fetch(ANTIGRAVITY.userinfoUrl, {headers: {authorization: `Bearer ${access}`}})
    ).json();
    label = str((ui as Record<string, unknown>).email);
  } catch {
    // userinfo is best-effort; login still completes without it.
  }
  return {access, refresh, expiresAt: Date.now() + expiresIn * 1000, ...(label ? {label} : {})};
};

export const refreshAntigravity = async (
  refreshToken: string,
): Promise<{access: string; refresh?: string; expiresAt: number}> => {
  const res = await fetch(ANTIGRAVITY.tokenUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: form({
      grant_type: 'refresh_token',
      client_id: ANTIGRAVITY.clientId,
      client_secret: ANTIGRAVITY.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const body = await readJson(res, 'Antigravity token refresh');
  const access = body.access_token;
  const expiresIn = body.expires_in;
  if (typeof access !== 'string' || typeof expiresIn !== 'number')
    throw new Error('Antigravity refresh response is missing required fields');
  return {
    access,
    ...(typeof body.refresh_token === 'string' ? {refresh: body.refresh_token} : {}),
    expiresAt: Date.now() + expiresIn * 1000,
  };
};

// ---------------------------------------------------------------------------
// Muse Code (Meta) — RFC 8628 device flow + api-key mint
// ---------------------------------------------------------------------------

/**
 * Muse Code lands on Meta's `api.meta.ai/v1` OpenAI-compatible surface behind a
 * per-subscription minted API key. The device-code login yields an OAuth access
 * token; a follow-up `POST /muse-code/key` exchanges that for the `api_key` the
 * model backend accepts as `Authorization: Bearer <apiKey>`.
 *
 * The stored access token is the JSON blob `{oauthAccessToken, apiKey}` so the
 * gateway can unwrap the minted key at dispatch time (same arrangement
 * Cartethyia's Muse adapter uses). Muse tokens do not expire and Meta rejects
 * refresh grants, so the OAuth access token is parked in the refresh slot and
 * re-minting the api_key reuses the existing one.
 */
export const MUSE = {
  clientId: '1031625952748946',
  deviceAuthorizeUrl: 'https://auth.meta.com/oidc/device/authorization/',
  deviceTokenUrl: 'https://auth.meta.com/oidc/device/token/',
  keyUrl: 'https://api.meta.ai/muse-code/key',
  apiVersion: '1.0.0',
};

export type MuseDeviceStart = {deviceCode: string; userCode: string; interval: number; verificationUri: string};

export const startMuseDevice = async (): Promise<MuseDeviceStart> => {
  const res = await fetch(MUSE.deviceAuthorizeUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'x-api-version': MUSE.apiVersion,
    },
    body: form({client_id: MUSE.clientId}),
  });
  const body = await readJson(res, 'Muse device authorization');
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  if (!deviceCode || !userCode) throw new Error('Muse device authorization returned an invalid response');
  const verificationUri =
    str(body.verification_uri_complete) ?? str(body.verification_uri) ?? 'https://auth.meta.com/device';
  return {
    deviceCode,
    userCode,
    interval: typeof body.interval === 'number' ? body.interval : 5,
    verificationUri,
  };
};

/** One poll attempt. Returns null while the user has not approved yet. */
export const pollMuseDevice = async (deviceCode: string): Promise<{accessToken: string} | null> => {
  let res: Response;
  try {
    res = await fetch(MUSE.deviceTokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'x-api-version': MUSE.apiVersion,
      },
      body: form({
        client_id: MUSE.clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
  } catch (e) {
    throw new Error(`Muse device polling failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 400 authorization_pending / slow_down are the "not approved yet" answers.
  if (res.status === 400 || res.status === 428) {
    let err = '';
    try {
      err = str(((await res.json()) as Record<string, unknown>).error) ?? '';
    } catch {
      /* not json */
    }
    if (err === 'slow_down') await sleep(5000);
    // RFC 8628: the user said no, or the code ran out. Stop instead of polling until the deadline.
    if (err === 'access_denied') throw new Error('Muse login was declined. Try again and approve it on the Meta page.');
    if (err === 'expired_token') throw new Error('The Muse login code expired. Start the login again.');
    return null;
  }
  if (!res.ok) return null;
  const body = await readJson(res, 'Muse device poll');
  const accessToken = str(body.access_token);
  if (!accessToken) throw new Error('Muse token response omitted access_token');
  return {accessToken};
};

/** Exchange the OAuth access token for the subscription api_key. */
export const mintMuseKey = async (
  accessToken: string,
): Promise<{apiKey: string; label?: string}> => {
  const res = await fetch(MUSE.keyUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-version': MUSE.apiVersion,
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({onboard: true}),
  });
  const body = await readJson(res, 'Muse key exchange');
  const apiKey = str(body.api_key);
  if (!apiKey) throw new Error('Muse key exchange omitted api_key');
  const label = str(body.user_email);
  return {apiKey, ...(label ? {label} : {})};
};

/** Encode the credential blob stored in the access/refresh slots. */
export const encodeMuseCredential = (oauthAccessToken: string, apiKey: string): string =>
  JSON.stringify({oauthAccessToken, apiKey});

export const decodeMuseCredential = (blob: string): {oauthAccessToken: string; apiKey: string} => {
  const parsed = JSON.parse(blob) as Record<string, unknown>;
  const oauthAccessToken = str(parsed.oauthAccessToken);
  const apiKey = str(parsed.apiKey);
  if (!oauthAccessToken || !apiKey) throw new Error('muse: credential is missing oauthAccessToken or apiKey; sign in again');
  return {oauthAccessToken, apiKey};
};

/** Re-mint the api_key from the parked OAuth access token (used on refresh). */
export const refreshMuse = async (
  oauthAccessToken: string,
): Promise<{access: string; refresh: string; expiresAt: number}> => {
  const {apiKey} = await mintMuseKey(oauthAccessToken);
  return {
    access: encodeMuseCredential(oauthAccessToken, apiKey),
    refresh: oauthAccessToken,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const pickRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
