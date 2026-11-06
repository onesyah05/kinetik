import React, {useEffect, useState} from 'react';
import {Clapperboard, Download, Trash2, X} from 'lucide-react';
import {api, formatBytes, projectUrl, timecode, type Project, type Quality, type RenderFile, type RenderJob} from '../api';
import type {Bus} from './ProjectView';

const QUALITIES: {id: Quality; label: string; sub: string}[] = [
  {id: 'draft', label: 'Draft', sub: 'Half size, fastest'},
  {id: 'standard', label: 'Standard', sub: 'Full size, balanced'},
  {id: 'high', label: 'High', sub: 'Full size, slowest'},
];

export const Renders: React.FC<{project: Project; bus: Bus}> = ({project, bus}) => {
  const [files, setFiles] = useState<RenderFile[]>([]);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [quality, setQuality] = useState<Quality>('standard');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const load = () =>
    api.renders(project.id).then((r) => {
      setFiles(r.files);
      const active = r.jobs.find((j) => j.status === 'bundling' || j.status === 'rendering');
      const latest = r.jobs.sort((a, b) => b.startedAt - a.startedAt)[0];
      setJob(active ?? (latest && latest.status !== 'done' ? latest : null));
    });

  useEffect(() => {
    load();
  }, [project.id]);

  useEffect(
    () =>
      bus.subscribe((e) => {
        if (e.type !== 'render_progress') return;
        setJob(e.job);
        if (e.job.status === 'done') load();
      }),
    [bus],
  );

  const active = job && (job.status === 'bundling' || job.status === 'rendering');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const start = async () => {
    setError('');
    try {
      setJob(await api.render(project.id, quality));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (f: RenderFile) => {
    if (!confirm(`Delete ${f.file}?`)) return;
    await api.deleteRender(project.id, f.file);
    load();
  };

  const elapsed = job ? Math.round(((job.finishedAt ?? now) - job.startedAt) / 1000) : 0;
  const eta = job && job.status === 'rendering' && job.progress > 0.03 ? Math.round((elapsed / job.progress) * (1 - job.progress)) : null;

  return (
    <div className="pad">
      <div className="section" style={{maxWidth: 760}}>
        <h2 className="page-title">Render on this laptop</h2>
        <p className="page-sub">Chrome headless draws each frame and FFmpeg encodes the MP4, nothing leaves this computer</p>
        <div className="presets" style={{marginBottom: 14}}>
          {QUALITIES.map((q) => (
            <div key={q.id} className={`preset ${quality === q.id ? 'active' : ''}`} onClick={() => setQuality(q.id)}>
              <div>
                <div className="preset-title">{q.label}</div>
                <div className="preset-sub">{q.sub}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn primary" style={{height: 40, padding: '0 16px'}} onClick={start} disabled={!!active}>
            <Clapperboard size={16} /> Render MP4
          </button>
          <span className="chip">
            {project.width}×{project.height} · {project.durationInFrames} frames · {timecode(project.durationInFrames, project.fps)}
          </span>
        </div>
        {error && <div className="error-box" style={{marginTop: 12}}>{error}</div>}

        {job && (
          <div className="job">
            <div className="row small" style={{marginBottom: 12}}>
              <span className={`tally ${active ? 'on' : ''}`}>
                <i />
              </span>
              <span className="grow">
                {job.status === 'bundling' && 'Bundling code'}
                {job.status === 'rendering' && `Rendering frames · ${Math.round(job.progress * 100)}%`}
                {job.status === 'error' && 'Render failed'}
                {job.status === 'cancelled' && 'Cancelled'}
                {job.status === 'done' && 'Done'}
              </span>
              <span className="faint mono">
                {elapsed}s{eta !== null ? ` · about ${eta}s left` : ''}
              </span>
              {active && (
                <button className="btn sm" onClick={() => api.cancelRender(job.jobId)}>
                  <X size={16} /> Cancel
                </button>
              )}
            </div>
            {active && (
              <div className="progress">
                <div style={{transform: `scaleX(${job.progress})`}} />
              </div>
            )}
            {job.error && <div className="error-box" style={{marginTop: 8}}>{job.error}</div>}
          </div>
        )}

        <h3>Rendered videos</h3>
        {files.length === 0 && <div className="faint small">Nothing rendered yet</div>}
        {files.map((f) => {
          const url = projectUrl(project.id, `renders/${f.file}`);
          return (
            <div key={f.file} className="render-row">
              <video src={url} controls preload="metadata" />
              <div className="grow">
                <div className="mono small" style={{wordBreak: 'break-all'}}>
                  {f.file}
                </div>
                <div className="small faint mono" style={{marginTop: 4}}>
                  {formatBytes(f.size)} · {new Date(f.createdAt).toLocaleString()}
                </div>
                <div className="row" style={{marginTop: 12}}>
                  <a className="btn sm" href={url} download={f.file}>
                    <Download size={16} /> Download
                  </a>
                  <button className="btn sm ghost danger" onClick={() => remove(f)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div className="hint mono">workspace/{project.id}/renders/</div>
      </div>
    </div>
  );
};
