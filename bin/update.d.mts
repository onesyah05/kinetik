// Types for update.mjs, so the TypeScript server can import it.
export type Release = {version: string; notes: string; url: string; tarball: string | null; publishedAt?: string};
export type UpdateResult = {ok: boolean; from: string; to: string; error?: string; upToDate?: boolean; at?: number};
export const ROOT: string;
export const REPO: string;
export const UPDATE_EXIT_CODE: number;
export const currentVersion: () => string;
export const homeDir: () => string;
export const compareVersions: (a: string, b: string) => number;
export const installMethod: () => 'git' | 'npm' | 'folder';
export const manualCommand: (method?: 'git' | 'npm' | 'folder') => string;
export const fetchLatest: (timeoutMs?: number) => Promise<Release | null>;
export const readStatus: () => UpdateResult | null;
export const performUpdate: (latest?: Release | null) => Promise<UpdateResult>;
