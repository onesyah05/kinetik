import React, {useEffect, useState} from 'react';
import {api, PRESETS, type CaptionSettings, type Project} from '../api';

const Toggle: React.FC<{on: boolean; onChange: (v: boolean) => void}> = ({on, onChange}) => (
  <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />
);

export const ProjectSettingsPanel: React.FC<{project: Project; onChange: (p: Project) => void}> = ({project, onChange}) => {
  const [w, setW] = useState(project.width);
  const [h, setH] = useState(project.height);
  const [fps, setFps] = useState(project.fps);
  const [secs, setSecs] = useState(+(project.durationInFrames / project.fps).toFixed(2));
  const [error, setError] = useState('');

  useEffect(() => {
    setW(project.width);
    setH(project.height);
    setFps(project.fps);
    setSecs(+(project.durationInFrames / project.fps).toFixed(2));
  }, [project.width, project.height, project.fps, project.durationInFrames]);

  const patch = async (p: Partial<Project>) => {
    setError('');
    try {
      const next = await api.updateProject(project.id, p);
      onChange({...project, ...next});
    } catch (e: any) {
      setError(e.message);
    }
  };
  const cap = (c: Partial<CaptionSettings>) => patch({captions: {...project.captions, ...c}});
  const c = project.captions;

  return (
    <div className="pad">
      <div className="section">
        <h2 className="page-title">Video settings</h2>
        <p className="page-sub">Changes apply to the preview at once and to the next render</p>
        <h3>Format</h3>
        <div className="presets" style={{marginBottom: 14}}>
          {PRESETS.map((p) => (
            <div
              key={p.label}
              className={`preset ${p.width === project.width && p.height === project.height ? 'active' : ''}`}
              onClick={() => patch({width: p.width, height: p.height})}
            >
              <div>
                <div className="preset-title">{p.label}</div>
                <div className="preset-sub mono">
                  {p.width}×{p.height}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="grid3">
          <div>
            <label className="label">Width</label>
            <input className="input" type="number" value={w} onChange={(e) => setW(+e.target.value)} onBlur={() => w !== project.width && patch({width: w})} />
          </div>
          <div>
            <label className="label">Height</label>
            <input className="input" type="number" value={h} onChange={(e) => setH(+e.target.value)} onBlur={() => h !== project.height && patch({height: h})} />
          </div>
          <div>
            <label className="label">FPS</label>
            <select
              className="select"
              value={fps}
              onChange={(e) => {
                const f = +e.target.value;
                setFps(f);
                patch({fps: f, durationInFrames: Math.round(secs * f)});
              }}
            >
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field" style={{marginTop: 16, maxWidth: 200}}>
          <label className="label">Duration in seconds</label>
          <input
            className="input"
            type="number"
            step="0.1"
            value={secs}
            onChange={(e) => setSecs(+e.target.value)}
            onBlur={() => patch({durationInFrames: Math.round(secs * project.fps)})}
          />
        </div>
        <div className="hint" style={{marginTop: -8}}>The agent usually sets this to fit the voiceover</div>

        <h3>Style options</h3>
        <div className="field" style={{maxWidth: 320}}>
          <label className="label">How the agent shows style choices for a new video</label>
          <select
            className="select"
            value={project.styleFrames ?? 'ai'}
            onChange={(e) => patch({styleFrames: e.target.value as 'ai' | 'code'})}
          >
            <option value="ai">AI frames (images, ~40 s)</option>
            <option value="code">Live code samples (animated, free)</option>
          </select>
        </div>
        <div className="hint" style={{marginTop: -8}}>AI frames need image generation, e.g. a connected Codex or Antigravity account</div>

        <h3>Captions</h3>
        <div className="setting-row">
          <Toggle on={c.enabled} onChange={(v) => cap({enabled: v})} />
          <div>
            <div>{c.enabled ? 'Captions on' : 'Captions off'}</div>
            <div className="small faint">Word-synced captions under every voiceover</div>
          </div>
        </div>
        <div style={{opacity: c.enabled ? 1 : 0.45, pointerEvents: c.enabled ? 'auto' : 'none'}}>
          <div className="grid3">
            <div>
              <label className="label">Style</label>
              <select className="select" value={c.style} onChange={(e) => cap({style: e.target.value as CaptionSettings['style']})}>
                <option value="tiktok">TikTok (bold, word pop)</option>
                <option value="classic">Classic (subtitle box)</option>
                <option value="karaoke">Karaoke (fill as spoken)</option>
              </select>
            </div>
            <div>
              <label className="label">Position</label>
              <select className="select" value={c.position} onChange={(e) => cap({position: e.target.value as CaptionSettings['position']})}>
                <option value="bottom">Bottom</option>
                <option value="center">Center</option>
                <option value="top">Top</option>
              </select>
            </div>
            <div>
              <label className="label">Words at once</label>
              <input className="input" type="number" min={1} max={20} value={c.wordsPerPage} onChange={(e) => cap({wordsPerPage: +e.target.value})} />
            </div>
          </div>
          <div className="grid3" style={{marginTop: 16}}>
            <div>
              <label className="label">Text color</label>
              <input className="input" type="color" value={c.color} onChange={(e) => cap({color: e.target.value})} />
            </div>
            <div>
              <label className="label">Highlight color</label>
              <input className="input" type="color" value={c.highlightColor} onChange={(e) => cap({highlightColor: e.target.value})} />
            </div>
            <div>
              <label className="label">Font size, 0 is auto</label>
              <input className="input" type="number" min={0} value={c.fontSize} onChange={(e) => cap({fontSize: +e.target.value})} />
            </div>
          </div>
          <div className="grid2" style={{marginTop: 16}}>
            <div>
              <label className="label">Font family</label>
              <input className="input" defaultValue={c.fontFamily} onBlur={(e) => e.target.value !== c.fontFamily && cap({fontFamily: e.target.value})} />
            </div>
            <div className="row" style={{alignItems: 'flex-end', paddingBottom: 8}}>
              <Toggle on={c.uppercase} onChange={(v) => cap({uppercase: v})} />
              <span>Uppercase in TikTok style</span>
            </div>
          </div>
        </div>
        {error && <div className="error-box" style={{marginTop: 12}}>{error}</div>}
      </div>
    </div>
  );
};
