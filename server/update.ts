import {
  ROOT,
  UPDATE_EXIT_CODE,
  compareVersions,
  currentVersion,
  fetchLatest,
  installMethod,
  manualCommand,
  readStatus,
  type Release,
} from '../bin/update.mjs';

// The version this process started with (package.json may change under it during an update).
const VERSION = currentVersion();
const CHECK_EVERY = 6 * 60 * 60 * 1000;

let cache: {at: number; latest: Release | null} | null = null;

/** Started by `kinetik start`, which can install an update and start the server again. */
export const canSelfUpdate = () => process.env.KINETIK_SUPERVISED === '1';

export const versionInfo = () => {
  const last = readStatus();
  return {
    version: VERSION,
    root: ROOT,
    // The result of an update that just ran, so the page can say how it went.
    lastUpdate: last && last.at && Date.now() - last.at < 15 * 60 * 1000 ? last : null,
  };
};

export const checkForUpdate = async (force = false) => {
  if (process.env.KINETIK_NO_UPDATE_CHECK) return {current: VERSION, available: false, disabled: true};
  if (force || !cache || Date.now() - cache.at > CHECK_EVERY) {
    const latest = await fetchLatest();
    // Keep the old answer when offline, but retry sooner.
    cache = latest || !cache ? {at: latest ? Date.now() : Date.now() - CHECK_EVERY + 10 * 60 * 1000, latest} : cache;
  }
  const latest = cache.latest;
  const method = installMethod();
  return {
    current: VERSION,
    latest: latest?.version ?? null,
    available: !!latest && compareVersions(latest.version, VERSION) > 0,
    notes: latest?.notes ?? '',
    url: latest?.url ?? null,
    method,
    canSelfUpdate: canSelfUpdate(),
    command: manualCommand(method),
  };
};

/** Close the server so `kinetik start` installs the update and starts it again. */
export const requestUpdate = async (busy: string | null, beforeExit: () => Promise<void>) => {
  if (!canSelfUpdate())
    throw new Error(`Kinetik was not started with the "kinetik" command, so it can't restart itself. Stop it and run: ${manualCommand()}`);
  if (busy) throw new Error(busy);
  console.log('\n  Update requested from the app. Closing the server…\n');
  // Release files (headless Chrome) first, then exit once the response has gone out.
  await beforeExit().catch(() => undefined);
  setTimeout(() => process.exit(UPDATE_EXIT_CODE), 300);
  return {ok: true};
};
