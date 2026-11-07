import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronDown, RefreshCw, Search} from 'lucide-react';
import {api, type Provider} from '../api';

type ModelList = {models: string[]; error?: string};

// Model lists for the whole session: fetching them hits each provider (or the account behind a login).
const cache = new Map<string, Promise<ModelList>>();
const loadModels = (p: Provider, fresh = false) => {
  if (fresh || !cache.has(p.id))
    cache.set(
      p.id,
      api
        .models({providerId: p.id, baseURL: p.baseURL, apiKey: p.apiKey})
        .then((r) => ({models: r.models}))
        .catch((e) => ({models: [], error: String(e?.message ?? e)})),
    );
  return cache.get(p.id)!;
};

const usable = (p: Provider) => !!p.apiKey || /localhost|127\.0\.0\.1/.test(p.baseURL);
/** "Codex · someone@mail.com" → ["Codex", "someone@mail.com"] */
const splitName = (name: string) => {
  const at = name.indexOf(' · ');
  return at < 0 ? [name, ''] : [name.slice(0, at), name.slice(at + 3)];
};
const SHOWN = 40;

/** Header dropdown: every model of every provider or signed-in account, grouped by provider. */
export const ModelPicker: React.FC<{
  providers: Provider[];
  providerId?: string;
  model?: string;
  onPick: (providerId: string, model: string) => void;
}> = ({providers, providerId, model, onPick}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lists, setLists] = useState<Record<string, ModelList | undefined>>({});
  const [pos, setPos] = useState({top: 0, right: 0});
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const current = providers.find((p) => p.id === providerId) ?? providers[0];
  const currentModel = model || current?.model || '';
  // The provider in use first, then signed-in accounts, then the rest.
  const rank = (p: Provider) => (p.id === current?.id ? 0 : p.id.startsWith('sub:') ? 1 : 2);
  const shown = useMemo(
    () => providers.filter((p) => usable(p) || p.id === current?.id).sort((a, b) => rank(a) - rank(b)),
    [providers, current?.id],
  );

  const fetchAll = (fresh = false) => {
    for (const p of shown) {
      if (fresh) setLists((l) => ({...l, [p.id]: undefined}));
      loadModels(p, fresh).then((r) => setLists((l) => ({...l, [p.id]: r})));
    }
  };

  useEffect(() => {
    if (!open) return;
    fetchAll();
    setQuery('');
    setTimeout(() => search.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      const r = button.current!.getBoundingClientRect();
      setPos({top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right)});
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  const pick = (p: Provider, m: string) => {
    setOpen(false);
    onPick(p.id, m);
  };

  const q = query.trim().toLowerCase();
  const [kind] = current ? splitName(current.name) : ['Model'];
  const groups = shown.map((p) => {
    const [name, account] = splitName(p.name);
    const list = lists[p.id];
    // Keep the configured default in the list even when the provider can't be reached.
    const all = [...new Set([...(list?.models ?? []), p.model].filter(Boolean))];
    const hit = q ? all.filter((m) => m.toLowerCase().includes(q) || name.toLowerCase().includes(q)) : all;
    return {p, name, account, list, all, hit, visible: q ? hit : hit.slice(0, SHOWN)};
  });

  return (
    <>
      <button
        ref={button}
        className={`select model-button ${open ? 'open' : ''}`}
        title={current ? `${current.name} · ${currentModel}` : 'Model'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-kind">{kind}</span>
        <span className="model-id">{currentModel || 'Pick a model'}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="model-panel" style={{top: pos.top, right: pos.right}}>
            <div className="model-search">
              <Search size={14} className="faint" />
              <input ref={search} placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="btn ghost icon sm" title="Reload model lists" onClick={() => fetchAll(true)}>
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="model-groups">
              {groups.map(({p, name, account, list, all, hit, visible}) => {
                if (q && !hit.length) return null;
                return (
                  <div key={p.id} className="model-group">
                    <div className="model-group-head" title={p.name}>
                      <b>{name}</b>
                      {account && <span className="faint">{account}</span>}
                      <span className="grow" />
                      <span className="faint mono">{list ? (list.error ? 'offline' : all.length) : '…'}</span>
                    </div>
                    {list?.error && !q && <div className="model-note">Couldn't load this list. Showing the saved model.</div>}
                    {visible.map((m) => {
                      const on = p.id === current?.id && m === currentModel;
                      return (
                        <button key={m} className={`model-option ${on ? 'on' : ''}`} onClick={() => pick(p, m)}>
                          <span className="grow mono">{m}</span>
                          {m === p.model && <span className="faint small">default</span>}
                          {on && <Check size={14} />}
                        </button>
                      );
                    })}
                    {hit.length > visible.length && <div className="model-note">+{hit.length - visible.length} more, type to search</div>}
                  </div>
                );
              })}
              {q && groups.every((g) => !g.hit.length) && <div className="model-note">No model matches “{query}”.</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
