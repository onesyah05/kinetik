import React, {useEffect, useMemo, useState} from 'react';
import {Player} from '@remotion/player';
import {Check, Code2, RefreshCw, Sparkles} from 'lucide-react';
import {KitRoot, type ProjectSettings} from '@kit';
import {projectUrl, type Project} from '../api';

/** A style choice: live code (`file`) or an AI-generated still (`image`, a path inside public/). */
export type StyleOption = {id: string; name: string; description: string; file?: string; image?: string; voice?: string};

const SAMPLE_SECONDS = 3;

/** One style sample, loaded live from the project through Vite and looped in a small player. */
const Sample: React.FC<{project: Project; file: string; live: boolean}> = ({project, file, live}) => {
  const [Comp, setComp] = useState<React.FC | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!project.entry) return;
    const base = project.entry.replace(/src\/Video\.tsx$/, '');
    let cancelled = false;
    import(/* @vite-ignore */ `${base}${file}?t=${Date.now()}`)
      .then((m) => {
        if (cancelled) return;
        if (typeof m.Sample !== 'function') throw new Error('No Sample export');
        setComp(() => m.Sample as React.FC);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [project.entry, file]);

  const settings = useMemo(() => {
    const {createdAt, updatedAt, providerId, model, running, entry, thumb, ...s} = project as Project & Record<string, unknown>;
    return s as unknown as ProjectSettings;
  }, [project]);

  const Wrapped = useMemo(() => {
    if (!Comp) return null;
    const W: React.FC<{settings: ProjectSettings}> = ({settings: st}) => (
      <KitRoot settings={st}>
        <Comp />
      </KitRoot>
    );
    return W;
  }, [Comp]);

  const ratio = `${project.width} / ${project.height}`;
  if (error) return <div className="style-media style-error" style={{aspectRatio: ratio}}>Sample failed to load</div>;
  if (!Wrapped) return <div className="style-media style-loading" style={{aspectRatio: ratio}}>Loading sample…</div>;
  return (
    <div className="style-media" style={{aspectRatio: ratio}}>
      <Player
        component={Wrapped}
        inputProps={{settings}}
        durationInFrames={Math.round(project.fps * SAMPLE_SECONDS)}
        compositionWidth={project.width}
        compositionHeight={project.height}
        fps={project.fps}
        style={{width: '100%', height: '100%'}}
        autoPlay={live}
        initiallyMuted
        loop
        controls={false}
        clickToPlay={false}
        acknowledgeRemotionLicense
      />
    </div>
  );
};

export const StylePicker: React.FC<{
  project: Project;
  options: StyleOption[];
  disabled: boolean;
  /** Play the samples only while the choice is still open; old pickers stay paused to save CPU. */
  live: boolean;
  onPick: (o: StyleOption) => void;
  /** Ask the agent to show the options again: as AI frames, as live code, or new AI frames. */
  onSwitch?: (to: 'ai' | 'code' | 'regenerate') => void;
}> = ({project, options, disabled, live, onPick, onSwitch}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const portrait = project.height > project.width;
  const isAi = options.some((o) => o.image);
  const locked = disabled || !!picked;
  return (
    <>
    <div className={`style-grid ${portrait ? 'portrait' : ''}`}>
      {options.map((o) => (
        <div key={o.id} className={`style-card ${picked === o.id ? 'picked' : ''}`}>
          {o.image ? (
            <div className="style-media" style={{aspectRatio: `${project.width} / ${project.height}`}}>
              <img className="style-image" src={projectUrl(project.id, `public/${o.image}`)} alt={o.name} />
            </div>
          ) : o.file ? (
            <Sample project={project} file={o.file} live={live} />
          ) : null}
          <div className="style-info">
            <div className="style-name">{o.name}</div>
            <div className="style-desc">{o.description}</div>
            <button
              className={`btn sm ${picked === o.id ? 'primary' : ''}`}
              disabled={disabled || !!picked}
              onClick={() => {
                setPicked(o.id);
                onPick(o);
              }}
            >
              {picked === o.id ? <Check size={16} /> : null}
              {picked === o.id ? 'Chosen' : 'Use this style'}
            </button>
          </div>
        </div>
      ))}
    </div>
    {onSwitch && (
      <div className="style-actions">
        {isAi ? (
          <>
            <button className="btn sm" disabled={locked} onClick={() => onSwitch('regenerate')} title="Make 3 new AI frames">
              <RefreshCw size={14} /> Regenerate
            </button>
            <button className="btn ghost sm" disabled={locked} onClick={() => onSwitch('code')} title="Show the options as live animated code samples">
              <Code2 size={14} /> Use live code
            </button>
          </>
        ) : (
          <button className="btn sm" disabled={locked} onClick={() => onSwitch('ai')} title="Show the options as AI-generated frames (~40 s)">
            <Sparkles size={14} /> Generate frames with AI
          </button>
        )}
      </div>
    )}
    </>
  );
};
