import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {MessageSquarePlus, RefreshCw, Wand2} from 'lucide-react';
import {KitRoot, type ProjectSettings} from '@kit';
import {api, timecode, type Project} from '../api';

type Mod = {Video: React.FC};

/** Ask the chat panel to send or prefill a message. */
export const askAgent = (text: string, send = false) =>
  window.dispatchEvent(new CustomEvent('kinetik:ask', {detail: {text, send}}));

class Boundary extends React.Component<{children: React.ReactNode; onError: (e: Error) => void; resetKey: unknown}, {error: Error | null}> {
  state = {error: null as Error | null};
  static getDerivedStateFromError(error: Error) {
    return {error};
  }
  componentDidCatch(e: Error) {
    this.props.onError(e);
  }
  componentDidUpdate(prev: {resetKey: unknown}) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({error: null});
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

const ErrorPanel: React.FC<{title: string; detail: string}> = ({title, detail}) => (
  <div style={{maxWidth: 640, width: '100%'}}>
    <div className="error-box">
      <b>{title}</b>
      {'\n'}
      {detail}
    </div>
    <div className="row" style={{marginTop: 10}}>
      <button className="btn" onClick={() => askAgent(`The preview shows this error, please fix it:\n\n${title}\n${detail}`, true)}>
        <Wand2 size={16} /> Ask agent to fix
      </button>
    </div>
  </div>
);

export const Preview: React.FC<{project: Project; version: number}> = ({project, version}) => {
  const [mod, setMod] = useState<Mod | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<Error | null>(null);
  const [frame, setFrame] = useState(0);
  const [reload, setReload] = useState(0);
  const player = useRef<PlayerRef>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({w: 0, h: 0});

  // (Re)load the project's Video module through Vite. Debounced: the agent often writes several files in a row.
  useEffect(() => {
    if (!project.entry) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const m = await import(/* @vite-ignore */ `${project.entry}?t=${Date.now()}`);
        if (cancelled) return;
        const Video = m.Video ?? m.default;
        if (typeof Video !== 'function') throw new Error('src/Video.tsx must export `Video` (a React component).');
        setMod({Video});
        setLoadError(null);
        setRuntimeError(null);
      } catch (e: any) {
        if (cancelled) return;
        // Dynamic import errors are vague; the compile check gives the real message.
        const check = await api.check(project.id).catch(() => null);
        setLoadError(check && !check.ok ? check.errors.join('\n\n') : String(e?.message ?? e));
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [project.entry, project.id, version, reload]);

  // Fit the player into the stage while keeping the aspect ratio.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const {width, height} = e.contentRect;
      const s = Math.min(width / project.width, height / project.height);
      setBox({w: Math.floor(project.width * s), h: Math.floor(project.height * s)});
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    const on = (e: {detail: {frame: number}}) => setFrame(e.detail.frame);
    p.addEventListener('frameupdate', on);
    return () => p.removeEventListener('frameupdate', on);
  }, [mod]);

  const Main = useMemo(() => {
    if (!mod) return null;
    const V = mod.Video;
    const C: React.FC<{settings: ProjectSettings}> = ({settings}) => (
      <KitRoot settings={settings}>
        <V />
      </KitRoot>
    );
    return C;
  }, [mod]);

  const settings = useMemo(() => {
    const {createdAt, updatedAt, providerId, running, entry, ...s} = project as Project & Record<string, unknown>;
    return s as unknown as ProjectSettings;
  }, [project]);

  const t = (frame / project.fps).toFixed(2);
  const tc = timecode(frame, project.fps);

  return (
    <div className="preview">
      <div className="stage">
        <div className="stage-inner" ref={stage}>
          {loadError ? (
            <ErrorPanel title="Code failed to compile" detail={loadError} />
          ) : runtimeError ? (
            <ErrorPanel title={runtimeError.message} detail={(runtimeError.stack ?? '').split('\n').slice(1, 6).join('\n')} />
          ) : Main && box.w > 0 ? (
            <Boundary onError={setRuntimeError} resetKey={mod}>
              <div className="player-shell" style={{width: box.w, height: box.h}}>
              <Player
                ref={player}
                component={Main}
                inputProps={{settings}}
                durationInFrames={project.durationInFrames}
                compositionWidth={project.width}
                compositionHeight={project.height}
                fps={project.fps}
                style={{width: box.w, height: box.h}}
                controls
                loop
                clickToPlay
                doubleClickToFullscreen
                spaceKeyToPlayOrPause
                acknowledgeRemotionLicense
                errorFallback={({error}) => (
                  <div style={{padding: 20}}>
                    <ErrorPanel title={error.message} detail={(error.stack ?? '').split('\n').slice(1, 6).join('\n')} />
                  </div>
                )}
              />
              </div>
            </Boundary>
          ) : (
            <div className="faint">Loading preview</div>
          )}
        </div>
      </div>
      <div className="preview-bar">
        <span className="timecode">
          {tc} <span>/ {timecode(project.durationInFrames, project.fps)}</span>
        </span>
        <span className="chip">f{frame}</span>
        <span className="faint small">Browser preview, the render is the final check</span>
        <div className="grow" />
        <button className="btn sm" title="Write a comment about this exact moment" onClick={() => askAgent(`At ${t}s (frame ${frame}): `)}>
          <MessageSquarePlus size={16} /> Comment on frame
        </button>
        <button className="btn sm ghost" title="Reload preview" onClick={() => setReload((r) => r + 1)}>
          <RefreshCw size={16} />
        </button>
      </div>
    </div>
  );
};
