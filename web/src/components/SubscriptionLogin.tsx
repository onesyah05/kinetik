import React, {useEffect, useState} from 'react';
import {KeyRound, LogOut, X, ExternalLink, Check} from 'lucide-react';
import {api, type LoginStatus, type SubAccount} from '../api';

type Kind = 'codex' | 'claude' | 'antigravity' | 'muse';

const PROVIDERS: {kind: Kind; name: string; blurb: string; color: string}[] = [
  {kind: 'codex', name: 'Codex', blurb: 'ChatGPT Plus/Pro — GPT-6', color: '#10a37f'},
  {kind: 'claude', name: 'Claude Code', blurb: 'Claude Pro/Max', color: '#d97757'},
  {kind: 'antigravity', name: 'Antigravity', blurb: 'Google — Gemini 3', color: '#4285f4'},
  {kind: 'muse', name: 'Muse Code', blurb: 'Meta — Muse Spark', color: '#0064e0'},
];

/**
 * "Sign in with your subscription" panel. Mirrors how Cartethyia connects
 * subscription providers: one click starts the vendor's own OAuth login, the
 * connected account then shows up as a ready-to-use provider.
 */
const SubscriptionLogin: React.FC<{onChange: () => void}> = ({onChange}) => {
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [status, setStatus] = useState<Record<string, LoginStatus | null>>({});
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const r = await api.subscriptions();
      setAccounts(r.accounts);
      setRunning(r.running);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (kind: Kind) => {
    setError('');
    setStatus((s) => ({...s, [kind]: {phase: 'exchanging', message: 'Starting…'}}));
    setRunning((r) => (r.includes(kind) ? r : [...r, kind]));
    try {
      await api.login(kind, (s) => {
        setStatus((cur) => ({...cur, [kind]: s}));
        if (s.phase === 'done' || s.phase === 'error') {
          setRunning((r) => r.filter((k) => k !== kind));
          refresh();
          onChange();
        }
      });
    } catch (e: any) {
      setStatus((cur) => ({...cur, [kind]: {phase: 'error', message: e.message}}));
      setRunning((r) => r.filter((k) => k !== kind));
    }
  };

  const cancel = async (kind: Kind) => {
    await api.cancelLogin(kind);
    setRunning((r) => r.filter((k) => k !== kind));
    setStatus((s) => ({...s, [kind]: null}));
  };

  const disconnect = async (id: string) => {
    await api.disconnect(id);
    refresh();
    onChange();
  };

  const connected = (kind: Kind) => accounts.filter((a) => a.kind === kind);

  return (
    <div className="sublogin">
      <div className="sublogin-head">
        <KeyRound size={16} />
        <strong>Sign in with subscription</strong>
        <span className="sublogin-sub">Use your ChatGPT, Claude, Google, or Meta plan — no API key needed.</span>
      </div>
      <div className="sublogin-grid">
        {PROVIDERS.map(({kind, name, blurb, color}) => {
          const st = status[kind];
          const isRunning = running.includes(kind);
          const conns = connected(kind);
          return (
            <div key={kind} className="sublogin-card" style={{'--pc': color} as React.CSSProperties}>
              <div className="sublogin-card-head">
                <span className="sublogin-dot" />
                <div>
                  <div className="sublogin-name">{name}</div>
                  <div className="sublogin-blurb">{blurb}</div>
                </div>
              </div>

              {conns.map((a) => (
                <div key={a.id} className="sublogin-acct">
                  <Check size={14} />
                  <span className="sublogin-label">{a.label}</span>
                  <button className="btn ghost icon sm danger" onClick={() => disconnect(a.id)} title="Disconnect">
                    <LogOut size={14} />
                  </button>
                </div>
              ))}

              {isRunning && st ? (
                <div className="sublogin-status">
                  <div className="sublogin-msg">{st.message}</div>
                  {st.phase === 'awaiting_user' && st.url && (
                    <a className="btn sm" href={st.url} target="_blank" rel="noreferrer">
                      Open login <ExternalLink size={13} />
                    </a>
                  )}
                  {st.phase === 'awaiting_user' && st.userCode && (
                    <div className="sublogin-code">
                      Code: <code>{st.userCode}</code>
                    </div>
                  )}
                  {st.phase !== 'done' && st.phase !== 'error' && (
                    <button className="btn ghost sm" onClick={() => cancel(kind)}>
                      <X size={13} /> Cancel
                    </button>
                  )}
                </div>
              ) : (
                <button className="btn sm sublogin-btn" onClick={() => login(kind)}>
                  Sign in
                </button>
              )}

              {st?.phase === 'error' && <div className="sublogin-err">{st.message}</div>}
            </div>
          );
        })}
      </div>
      {error && <div className="sublogin-err">{error}</div>}
    </div>
  );
};

export default SubscriptionLogin;
