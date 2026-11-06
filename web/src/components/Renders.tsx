import React, {useEffect, useRef, useState} from 'react';
import {Check, Clapperboard, Download, ExternalLink, Send, Trash2, X} from 'lucide-react';
import {
  api,
  formatBytes,
  projectUrl,
  timecode,
  type Project,
  type Quality,
  type ReelPost,
  type RenderFile,
  type RenderJob,
  type VideoEntry,
} from '../api';
import type {Bus} from './ProjectView';

const MAIN = 'main';

const QUALITIES: {id: Quality; label: string; sub: string}[] = [
  {id: 'draft', label: 'Draft', sub: 'Half size, fastest'},
  {id: 'standard', label: 'Standard', sub: 'Full size, balanced'},
  {id: 'high', label: 'High', sub: 'Full size, slowest'},
];

export const Renders: React.FC<{project: Project; bus: Bus; onOpenSettings?: () => void}> = ({project, bus, onOpenSettings}) => {
  const [files, setFiles] = useState<RenderFile[]>([]);
  // Live Reels posting state per file (from fb_progress events), plus errors raised before it starts.
  const [reels, setReels] = useState<Record<string, ReelPost>>({});
  const [reelErrors, setReelErrors] = useState<Record<string, string>>({});
  const reelOf = (f: RenderFile) => reels[f.file] ?? f.facebook;
  const reelBusy = (r?: ReelPost) => !!r && !['done', 'error'].includes(r.status);

  /** One click: the server writes the caption and hashtags with AI, uploads and publishes. */
  const postReel = async (f: RenderFile) => {
    if (reelOf(f)?.status === 'done' && !confirm('This video is already on Facebook. Post it again as a new Reel?')) return;
    setReelErrors((m) => ({...m, [f.file]: ''}));
    try {
      const post = await api.postReel(project.id, f.file);
      setReels((m) => ({...m, [f.file]: post}));
    } catch (e: any) {
      setReelErrors((m) => ({...m, [f.file]: e.message}));
    }
  };
  const [job, setJob] = useState<RenderJob | null>(null);
  const [quality, setQuality] = useState<Quality>('standard');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  // Videos in this project; the active one stands in with the live duration.
  const activeId = project.activeVideo ?? MAIN;
  const videos: VideoEntry[] = (project.videos?.length ? project.videos : [{id: MAIN, name: project.name, durationInFrames: project.durationInFrames}]).map(
    (v) => (v.id === activeId ? {...v, durationInFrames: project.durationInFrames} : v),
  );
  const multi = videos.length > 1;
  const [picked, setPicked] = useState<string[]>([activeId]);
  // Drop deleted videos from the selection; fall back to the active one.
  const chosen = videos.filter((v) => picked.includes(v.id));
  const selection = chosen.length ? chosen : videos.filter((v) => v.id === activeId);
  const allPicked = selection.length === videos.length;
  const toggle = (id: string) =>
    setPicked((cur) => {
      const base = cur.filter((x) => videos.some((v) => v.id === x));
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  const totalFrames = selection.reduce((n, v) => n + v.durationInFrames, 0);
  const doneCount = useRef(0);

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
        if (e.type === 'fb_progress') {
          const post = e.post as ReelPost;
          setReels((m) => ({...m, [e.file as string]: post}));
          // Finished: reload so the saved "posted" badge comes from disk.
          if (post.status === 'done') load();
          return;
        }
        if (e.type !== 'render_progress') return;
        setJob(e.job);
        // Show each finished video as soon as it is written, not only at the end.
        const n = e.job.files?.length ?? 0;
        if (e.job.status === 'done' || n !== doneCount.current) load();
        doneCount.current = n;
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
      doneCount.current = 0;
      const ids = selection.map((v) => v.id);
      const started = await api.render(project.id, quality, allPicked && multi ? 'all' : ids);
      // A server started before this feature ignores the selection and renders the current video.
      // The page itself is always fresh (Vite serves it from disk), so check what the server did.
      const ignored = !started.videos || (multi && !allPicked && started.videos.map((v) => v.id).join() !== ids.join());
      if (ignored) {
        await api.cancelRender(started.jobId).catch(() => undefined);
        setJob(null);
        setError('The Kinetik server is still running older code, so it would render the wrong video. Restart Kinetik (close its terminal, then run it again) and render again.');
        return;
      }
      setJob(started);
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
        {multi && (
          <div style={{marginBottom: 14}}>
            <div className="row small" style={{marginBottom: 8}}>
              <span className="grow faint">Which videos? Each one becomes its own MP4.</span>
              <button className="btn sm ghost" onClick={() => setPicked(allPicked ? [activeId] : videos.map((v) => v.id))}>
                {allPicked ? 'Only the current one' : `Select all ${videos.length}`}
              </button>
            </div>
            <div className="presets">
              {videos.map((v) => {
                const on = selection.some((x) => x.id === v.id);
                return (
                  <div key={v.id} className={`preset ${on ? 'active' : ''}`} onClick={() => toggle(v.id)} role="checkbox" aria-checked={on}>
                    <span className={`check-box ${on ? 'on' : ''}`}>{on && <Check size={12} strokeWidth={3} />}</span>
                    <div>
                      <div className="preset-title">
                        {v.name}
                        {v.id === activeId && <span className="faint"> · current</span>}
                      </div>
                      <div className="preset-sub mono">{timecode(v.durationInFrames, project.fps)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn primary" style={{height: 40, padding: '0 16px'}} onClick={start} disabled={!!active}>
            <Clapperboard size={16} /> {selection.length > 1 ? `Render ${selection.length} videos` : 'Render MP4'}
          </button>
          <span className="chip">
            {project.width}×{project.height} · {totalFrames} frames · {timecode(totalFrames, project.fps)}
            {selection.length > 1 ? ' total' : ''}
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
                {job.status === 'rendering' &&
                  ((job.videos?.length ?? 0) > 1
                    ? `Rendering ${(job.current ?? 0) + 1} of ${job.videos!.length} · ${job.videos![job.current ?? 0]?.name} · ${Math.round(job.progress * 100)}%`
                    : `Rendering frames · ${Math.round(job.progress * 100)}%`)}
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
                <ReelStatus
                  post={reelOf(f)}
                  error={reelErrors[f.file]}
                  onOpenSettings={/Settings/.test(reelErrors[f.file] ?? '') ? onOpenSettings : undefined}
                />
                <div className="row" style={{marginTop: 12}}>
                  <a className="btn sm" href={url} download={f.file}>
                    <Download size={16} /> Download
                  </a>
                  <button
                    className="btn sm"
                    onClick={() => postReel(f)}
                    disabled={reelBusy(reelOf(f))}
                    title="AI writes the caption and hashtags, then posts this video to your Facebook Page as a Reel"
                  >
                    <Send size={16} /> {reelBusy(reelOf(f)) ? 'Posting…' : reelOf(f)?.status === 'error' ? 'Try again' : 'Post to Reels'}
                  </button>
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

const REEL_STEP: Record<ReelPost['status'], string> = {
  writing: 'AI is writing the caption and hashtags…',
  starting: 'Starting upload…',
  uploading: 'Uploading to Facebook',
  publishing: 'Publishing…',
  processing: 'Facebook is processing the video…',
  done: '',
  error: '',
};

/** Inline Reels status under a render: progress, the posted link and caption, or the error. */
const ReelStatus: React.FC<{post?: ReelPost; error?: string; onOpenSettings?: () => void}> = ({post, error, onOpenSettings}) => {
  if (error)
    return (
      <div className="reel-status bad">
        <span className="grow">{error}</span>
        {onOpenSettings && (
          <button className="btn sm" onClick={onOpenSettings}>
            Open Settings
          </button>
        )}
      </div>
    );
  if (!post) return null;
  if (post.status === 'error') return <div className="reel-status bad">{post.error}</div>;
  if (post.status === 'done')
    return (
      <div className="reel-status">
        {post.url ? (
          <a className="reel-posted" href={post.url} target="_blank" rel="noreferrer">
            <Check size={14} /> {post.state === 'DRAFT' ? 'Draft on Facebook' : 'Posted to Facebook Reels'}
            {post.postedAt ? ` · ${new Date(post.postedAt).toLocaleString()}` : ''}
            <ExternalLink size={12} />
          </a>
        ) : null}
        {post.note && <div className="faint small">{post.note}</div>}
        {post.description && <div className="reel-desc">{post.description}</div>}
      </div>
    );
  return (
    <div className="reel-status">
      <div className="row small">
        <span className="tally on">
          <i />
        </span>
        <span className="grow">
          {REEL_STEP[post.status]}
          {post.status === 'uploading' ? ` · ${Math.round(post.progress * 100)}%` : ''}
        </span>
      </div>
      <div className={`progress ${post.status === 'uploading' ? '' : 'indeterminate'}`}>
        <div style={post.status === 'uploading' ? {transform: `scaleX(${post.progress})`} : undefined} />
      </div>
      {post.description && <div className="reel-desc">{post.description}</div>}
    </div>
  );
};
