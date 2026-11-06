import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync} from 'node:crypto';
import {DATA} from '../paths';

/**
 * Stored credentials for one logged-in subscription account.
 *
 * Mirrors what Cartethyia persists after an OAuth login: the access/refresh
 * pair, when the access token expires, and the human-readable account label the
 * provider reported (an email or org name). `authState` carries any identity the
 * flow learned beside the tokens that the model call needs later — Codex's
 * ChatGPT account id, Antigravity's Cloud Code project id.
 */
export type SubscriptionAccount = {
  /** Stable id: `<providerKind>:<label or hash>`. Re-login to the same account overwrites it. */
  id: string;
  /** `codex` | `claude` | `antigravity`. */
  kind: 'codex' | 'claude' | 'antigravity';
  label: string;
  /** Encrypted at rest; decrypted only in memory when a model call needs it. */
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Provider-specific extras threaded from login to the model call. */
  authState?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

type StoreShape = {accounts: SubscriptionAccount[]};

const FILE = path.join(DATA, 'subscriptions.json');

/**
 * Encryption key for tokens at rest. Derived from a per-install random secret so
 * the file is useless if copied to another machine. This is a local convenience
 * app (not a server holding other people's keys), so a machine-bound key is the
 * right threat model — same as Cartethyia's local credential store.
 */
const keyFile = path.join(DATA, 'subscriptions.key');
const encryptionKey = (): Buffer => {
  fs.mkdirSync(DATA, {recursive: true});
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32));
  // Stretch to a 32-byte AES-256 key.
  return scryptSync(fs.readFileSync(keyFile), 'kinetik-subscription-v1', 32);
};

const encrypt = (plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
};

const decrypt = (blob: string): string => {
  const [ivB64, tagB64, dataB64] = blob.split('.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
};

/** Stable identity for an account that survives re-login (label may change). */
export const accountIdentity = (kind: string, label: string, fallback: string) =>
  `${kind}:${(label || fallback).toLowerCase().trim()}`;

let cache: StoreShape | null = null;

const load = (): StoreShape => {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {accounts: Array.isArray(raw.accounts) ? raw.accounts : []};
  } catch {
    cache = {accounts: []};
  }
  return cache!;
};

const persist = (s: StoreShape) => {
  fs.mkdirSync(DATA, {recursive: true});
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  cache = s;
};

export const listAccounts = (): SubscriptionAccount[] => load().accounts;

export const getAccount = (id: string): SubscriptionAccount | undefined => load().accounts.find((a) => a.id === id);

/** Decrypt-on-read helpers so the raw tokens never sit in the store file. */
export const readAccessToken = (a: SubscriptionAccount): string => {
  try {
    return decrypt(a.accessToken);
  } catch {
    return '';
  }
};
export const readRefreshToken = (a: SubscriptionAccount): string => {
  try {
    return decrypt(a.refreshToken);
  } catch {
    return '';
  }
};

/**
 * Upsert by stable identity. A fresh login mints a new refresh token, so keying
 * on it would let the same account be added twice — matching on identity keeps
 * one row per real account.
 */
export const upsertAccount = (
  acct: Omit<SubscriptionAccount, 'id' | 'createdAt' | 'updatedAt'> & {identity: string},
): SubscriptionAccount => {
  const s = load();
  const id = acct.identity;
  const now = Date.now();
  const existing = s.accounts.find((a) => a.id === id);
  const next: SubscriptionAccount = {
    id,
    kind: acct.kind,
    label: acct.label,
    accessToken: encrypt(acct.accessToken),
    refreshToken: encrypt(acct.refreshToken),
    expiresAt: acct.expiresAt,
    authState: acct.authState,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, next);
  else s.accounts.push(next);
  persist(s);
  return next;
};

/** Replace tokens after a refresh. */
export const updateTokens = (
  id: string,
  tokens: {accessToken: string; refreshToken?: string; expiresAt: number},
) => {
  const s = load();
  const a = s.accounts.find((x) => x.id === id);
  if (!a) return;
  a.accessToken = encrypt(tokens.accessToken);
  if (tokens.refreshToken) a.refreshToken = encrypt(tokens.refreshToken);
  a.expiresAt = tokens.expiresAt;
  a.updatedAt = Date.now();
  persist(s);
};

/** Merge provider-specific identity learned after login (e.g. Antigravity's project id). */
export const updateAuthState = (id: string, patch: Record<string, unknown>) => {
  const s = load();
  const a = s.accounts.find((x) => x.id === id);
  if (!a) return;
  a.authState = {...a.authState, ...patch};
  a.updatedAt = Date.now();
  persist(s);
};

export const removeAccount = (id: string) => {
  const s = load();
  s.accounts = s.accounts.filter((a) => a.id !== id);
  persist(s);
};

/** sha256 hex, used for identity fallbacks when a provider reports no label. */
export const shortHash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);
