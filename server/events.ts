import type {Response} from 'express';

export type ServerEvent = {type: string; projectId?: string; [k: string]: unknown};

const clients = new Set<{res: Response; projectId?: string}>();

export const addClient = (res: Response, projectId?: string) => {
  const c = {res, projectId};
  clients.add(c);
  res.on('close', () => clients.delete(c));
};

export const emit = (ev: ServerEvent) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    if (!c.projectId || !ev.projectId || c.projectId === ev.projectId) c.res.write(data);
  }
};

// Keep connections alive through proxies.
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 20000).unref();
