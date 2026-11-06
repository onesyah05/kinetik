/**
 * Bridges logged-in subscription accounts into Kinetik's provider config.
 *
 * Kinetik's agent and Settings UI already know how to use an OpenAI-compatible
 * provider (baseURL + apiKey). So each connected subscription becomes a provider
 * that points at this app's own gateway route, with the stored account id in the
 * apiKey slot. The agent needs no changes — it just streams chat.completions at
 * the gateway, which translates to the vendor's native protocol.
 *
 * Sync runs on read (config GET) and after any login/logout so the provider list
 * always mirrors the connected accounts.
 */
import {getConfig, saveConfig, type Provider} from '../config';
import {listAccounts} from './store';
import {DEFAULT_MODELS, RETIRED_MODELS} from './gateway';

/** Local gateway base the agent's OpenAI SDK points at. Absolute: the SDK runs server-side. */
const GATEWAY_BASE = `http://127.0.0.1:${process.env.PORT || 3210}/sub/v1`;

/** Provider id for a subscription account — stable and prefixed to avoid collisions. */
export const subscriptionProviderId = (accountId: string) => `sub:${accountId}`;

const KIND_LABEL: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
};

/**
 * Ensure every connected account has a matching provider, and drop providers
 * whose account was disconnected. Returns the updated provider list.
 */
export const syncSubscriptionProviders = (): Provider[] => {
  const c = getConfig();
  const accounts = listAccounts();
  const subIds = new Set(accounts.map((a) => subscriptionProviderId(a.id)));

  // Remove stale subscription providers (account disconnected).
  let providers = c.providers.filter((p) => !(p.id.startsWith('sub:') && !subIds.has(p.id)));

  // Add or refresh a provider per account.
  providers = providers.map((p) => {
    if (!p.id.startsWith('sub:')) return p;
    const acct = accounts.find((a) => subscriptionProviderId(a.id) === p.id);
    if (!acct) return p;
    return {
      ...p,
      name: `${KIND_LABEL[acct.kind] ?? acct.kind} · ${acct.label}`,
      apiKey: p.id, // the gateway resolves this account id
      model: p.model && !RETIRED_MODELS.has(p.model) ? p.model : DEFAULT_MODELS[acct.kind],
      vision: true,
    };
  });
  for (const a of accounts) {
    const id = subscriptionProviderId(a.id);
    if (providers.some((p) => p.id === id)) continue;
    providers.push({
      id,
      name: `${KIND_LABEL[a.kind] ?? a.kind} · ${a.label}`,
      baseURL: GATEWAY_BASE,
      apiKey: id, // the gateway resolves this account id
      model: DEFAULT_MODELS[a.kind],
      vision: true,
    });
  }

  // Image generation: drop a link to a removed provider; with nothing usable set up
  // and an account that can draw, follow the chat provider.
  // 'auto' follows each project's chat provider (see imageGenTarget).
  let imageGen = c.imageGen;
  if (imageGen.providerId && imageGen.providerId !== 'auto' && !providers.some((p) => p.id === imageGen.providerId))
    imageGen = {...imageGen, providerId: undefined};
  if (accounts.some((a) => a.kind === 'codex' || a.kind === 'antigravity') && !imageGen.providerId && !imageGen.apiKey) {
    imageGen = {...imageGen, providerId: 'auto', model: imageGen.model || 'gpt-image'};
  }

  // Only persist when something actually changed, to avoid rewriting config on every read.
  const changed = JSON.stringify(providers) !== JSON.stringify(c.providers) || imageGen !== c.imageGen;
  if (changed) saveConfig({...c, providers, imageGen});
  return providers;
};

/** True when a provider id refers to a logged-in subscription. */
export const isSubscriptionProvider = (id: string) => id.startsWith('sub:');
