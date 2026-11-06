import React, {useEffect, useState} from 'react';
import {Plus, Settings, Trash2} from 'lucide-react';
import {api, PRESETS, projectUrl, type Project} from '../api';
import {go} from '../App';

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

export const Shape: React.FC<{w: number; h: number; size: number; className?: string}> = ({w, h, size, className}) => {
  const s = size / Math.max(w, h);
  return <div className={className} style={{width: w * s, height: h * s}} />;
};

export const Brand: React.FC = () => (
  <div className="brand" onClick={() => go(null)}>
    <div className="brand-mark" />
    Kinetik
  </div>
);

export const Home: React.FC<{onOpenSettings: () => void}> = ({onOpenSettings}) => {
  const [projects, setProjects] = useState<(Project & {thumb?: string})[] | null>(null);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState(0);
  const [seconds, setSeconds] = useState(15);
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.projects().then(setProjects).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const p = PRESETS[preset];
      const proj = await api.createProject({name: name.trim() || 'Untitled video', width: p.width, height: p.height, fps, seconds});
      go(proj.id);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const remove = async (e: React.MouseEvent, p: Project) => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}" and all its files?`)) return;
    await api.deleteProject(p.id);
    load();
  };

  return (
    <div style={{height: '100%', overflow: 'auto'}}>
      <div className="topbar">
        <Brand />
        <div className="grow" />
        <button className="btn ghost" onClick={onOpenSettings}>
          <Settings size={16} /> Settings
        </button>
      </div>
      <div className="home">
        <div className="home-head">
          <div>
            <h1>Videos written as code, rendered on this laptop</h1>
            <p className="lede">Describe a video in chat. The agent writes the scenes in Remotion, checks its own frames and hands you an MP4</p>
            <ol className="steps">
              <li>
                <b>01</b>Pick a format and a working title
              </li>
              <li>
                <b>02</b>Describe the video, attach a logo or references
              </li>
              <li>
                <b>03</b>Watch the live preview, ask for changes, render
              </li>
            </ol>
          </div>

          <div className="new-card glass">
            <h2>New video</h2>
            <div className="field">
              <label className="label">Working title</label>
              <input
                className="input"
                placeholder="Product launch teaser"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label">Format</label>
              <div className="presets">
                {PRESETS.map((p, i) => (
                  <div key={p.label} className={`preset ${i === preset ? 'active' : ''}`} onClick={() => setPreset(i)}>
                    <Shape w={p.width} h={p.height} size={20} className="preset-shape" />
                    <div>
                      <div className="preset-title">{p.label}</div>
                      <div className="preset-sub">{p.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid2" style={{marginBottom: 8}}>
              <div>
                <label className="label">Length in seconds</label>
                <input className="input num" type="number" min={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Frame rate</label>
                <select className="select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="hint">The agent can change length and format later</div>
            <button className="btn primary" style={{width: '100%', height: 40, marginTop: 20}} onClick={create} disabled={busy}>
              <Plus size={16} /> Create project
            </button>
            {error && (
              <div className="error-box" style={{marginTop: 12}}>
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="section-head">
          <h3>Projects</h3>
          <span className="faint mono small">{projects?.length ?? ''}</span>
        </div>
        {projects && projects.length === 0 && <div className="empty">No projects yet</div>}
        <div className="projects">
          {projects?.map((p) => (
            <div key={p.id} className="project-card" onClick={() => go(p.id)}>
              <div className="project-thumb">
                {p.thumb ? <img src={projectUrl(p.id, p.thumb)} alt="" loading="lazy" /> : <Shape w={p.width} h={p.height} size={88} className="frame" />}
              </div>
              <div className="project-meta">
                <div className="grow">
                  <div className="project-name">{p.name}</div>
                  <div className="project-sub">
                    {p.width}×{p.height} · {(p.durationInFrames / p.fps).toFixed(1)}s · {ago(p.updatedAt)}
                  </div>
                </div>
                <button className="btn ghost icon sm danger" title="Delete" onClick={(e) => remove(e, p)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
