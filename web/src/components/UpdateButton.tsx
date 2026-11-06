import React, {useEffect, useRef, useState} from 'react';
import {ArrowUpCircle, Check, Copy, X} from 'lucide-react';
import {api, type UpdateInfo, type UpdateResult} from '../api';

const DISMISSED = 'kinetik.update.dismissed';
const SEEN = 'kinetik.update.seen';
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window: just forget */
    }
  },
};

/** Light rendering of release notes (headings, bullets, code), enough for GitHub's markdown. */
const Notes: React.FC<{text: string}> = ({text}) => {
  const clean = (s: string) =>
    s
      .replace(/\*\*|__/g, '')
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const out: React.ReactNode[] = [];
  let code = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (line.trim().startsWith('```')) return void (code = !code);
    if (!line.trim()) return;
    if (code) out.push(<pre key={i} className="notes-code">{line}</pre>);
    else if (/^#{1,6}\s/.test(line)) out.push(<div key={i} className="notes-h">{clean(line.replace(/^#+\s*/, ''))}</div>);
    else if (/^\s*[-*]\s/.test(line)) out.push(<div key={i} className="notes-li">{clean(line.replace(/^\s*[-*]\s/, ''))}</div>);
    else if (!/^\s*\|/.test(line)) out.push(<p key={i}>{clean(line)}</p>);
  });
  return <div className="notes">{out}</div>;
};

type Phase = 'idle' | 'confirm' | 'updating' | 'failed';

/**
 * Header button that appears when a newer Kinetik exists. Clicking Update closes the
 * server; `kinetik start` installs the new version and starts it again, and this page
 * waits for it and reloads.
 */
export const UpdateButton: React.FC = () => {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [, force] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    const check = () => api.checkUpdate().then(setInfo).catch(() => undefined);
    check();
    const t = setInterval(check, 3 * 60 * 60 * 1000);
    // Say once how the last update went.
    api
      .version()
      .then((v) => {
        if (v.lastUpdate?.at && store.get(SEEN) !== String(v.lastUpdate.at)) setResult(v.lastUpdate);
      })
      .catch(() => undefined);
    return () => clearInterval(t);
  }, []);

  // While updating: wait for the server to come back, then reload into the new version.
  useEffect(() => {
    if (phase !== 'updating') return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - started.current > 10 * 60 * 1000) {
        setError('Kinetik did not come back after 10 minutes. Look at the terminal where it runs for details.');
        return setPhase('failed');
      }
      try {
        const v = await api.version();
        const last = v.lastUpdate;
        if (v.version !== info?.current) return location.reload();
        if (last && (last.at ?? 0) >= started.current && !last.ok) {
          store.set(SEEN, String(last.at));
          setError(last.error || 'The update failed.');
          return setPhase('failed');
        }
      } catch {
        /* still restarting */
      }
      setTimeout(tick, 2000);
    };
    const t = setTimeout(tick, 2500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [phase]);

  const start = async () => {
    setError('');
    if (!info?.canSelfUpdate) return; // the dialog shows the command instead
    try {
      started.current = Date.now() - 1000;
      await api.startUpdate();
      setPhase('updating');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const dismissResult = () => {
    if (result?.at) store.set(SEEN, String(result.at));
    setResult(null);
  };

  const show = info?.available && info.latest;
  const snoozed = show && store.get(DISMISSED) === info!.latest;

  return (
    <>
      {result && (
        <div className={`update-toast ${result.ok ? '' : 'bad'}`} role="status">
          {result.ok ? <Check size={16} /> : <X size={16} />}
          <span className="grow">
            {result.ok ? `Kinetik updated to v${result.to}` : `Update failed: ${result.error ?? 'unknown error'}`}
          </span>
          <button className="btn ghost icon sm" onClick={dismissResult} title="Close">
            <X size={14} />
          </button>
        </div>
      )}

      {show && (
        <button
          className={`btn sm update-pill ${snoozed ? 'quiet' : ''}`}
          onClick={() => setPhase('confirm')}
          title={`Kinetik v${info!.latest} is available`}
        >
          <ArrowUpCircle size={16} /> Update{snoozed ? '' : ` to v${info!.latest}`}
        </button>
      )}

      {phase !== 'idle' && info && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && phase === 'confirm' && setPhase('idle')}>
          <div className="modal" style={{width: 'min(560px, 100%)'}}>
            <div className="modal-head">
              <span className="grow">
                {phase === 'updating' ? `Updating to v${info.latest}…` : phase === 'failed' ? 'Update did not finish' : `Kinetik v${info.latest} is available`}
              </span>
              {phase !== 'updating' && (
                <button className="btn ghost icon" onClick={() => setPhase('idle')} title="Close">
                  <X size={16} />
                </button>
              )}
            </div>
            <div className="modal-body">
              {phase === 'confirm' && (
                <>
                  <div className="small faint" style={{marginBottom: 16}}>
                    You have v{info.current}. Your projects, settings and logins stay as they are.
                  </div>
                  <Notes text={info.notes ?? ''} />
                  {!info.canSelfUpdate && (
                    <div className="update-cmd">
                      <div className="small" style={{marginBottom: 8}}>
                        This Kinetik was not started with the <span className="mono">kinetik</span> command, so it can't restart itself. Stop it, then run:
                      </div>
                      <div className="row">
                        <code className="grow mono">{info.command}</code>
                        <button className="btn sm" onClick={() => copy(info.command ?? '')}>
                          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                  {error && <div className="error-box" style={{marginTop: 12}}>{error}</div>}
                </>
              )}
              {phase === 'updating' && (
                <>
                  <div className="progress indeterminate" style={{marginBottom: 16}}>
                    <div />
                  </div>
                  <div className="small">
                    Kinetik is closing, downloading v{info.latest} and starting again. This usually takes a minute or two. The page reloads by
                    itself when it's done. Progress shows in the terminal where Kinetik runs.
                  </div>
                </>
              )}
              {phase === 'failed' && (
                <>
                  <div className="error-box">{error}</div>
                  <div className="small faint" style={{marginTop: 12}}>
                    Kinetik is still on v{info.current} and keeps working. To try by hand, close Kinetik and run{' '}
                    <span className="mono">{info.command}</span> in a terminal.
                  </div>
                </>
              )}
            </div>
            {phase === 'confirm' && (
              <div className="modal-foot">
                {info.url && (
                  <a className="btn ghost sm" href={info.url} target="_blank" rel="noreferrer">
                    Release page
                  </a>
                )}
                <div className="grow" />
                <button
                  className="btn ghost"
                  onClick={() => {
                    store.set(DISMISSED, info.latest!);
                    force((n) => n + 1);
                    setPhase('idle');
                  }}
                >
                  Later
                </button>
                {info.canSelfUpdate && (
                  <button className="btn primary" onClick={start}>
                    <ArrowUpCircle size={16} /> Update now
                  </button>
                )}
              </div>
            )}
            {phase === 'failed' && (
              <div className="modal-foot">
                <div className="grow" />
                <button className="btn" onClick={() => setPhase('idle')}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
