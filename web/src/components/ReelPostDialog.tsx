import React, {useEffect, useState} from 'react';
import {AlertTriangle, Check, ExternalLink, RefreshCw, Send, Sparkles, X} from 'lucide-react';
import {api, type CaptionDraft, type Config, type ReelCheck, type ReelPost, type RenderFile} from '../api';
import type {Bus} from './ProjectView';

/** "#Belajar Sains!" → "#belajarsains": lowercase, no spaces or punctuation (same rule as the server). */
const toTag = (s: string) => {
  const t = s.toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '');
  return t ? `#${t}` : '';
};
const parseTags = (s: string) => [...new Set(s.split(/[\s,]+/).map(toTag).filter(Boolean))];

const STEP: Record<ReelPost['status'], string> = {
  starting: 'Starting upload…',
  uploading: 'Uploading video',
  publishing: 'Publishing…',
  processing: 'Facebook is processing the video…',
  done: 'Done',
  error: 'Posting failed',
};

/** Review the AI caption and hashtags, then post a render to the Facebook Page as a Reel. */
export const ReelPostDialog: React.FC<{
  projectId: string;
  file: RenderFile;
  bus: Bus;
  onClose: () => void;
  onOpenSettings?: () => void;
}> = ({projectId, file, bus, onClose, onOpenSettings}) => {
  const [config, setConfig] = useState<Config | null>(null);
  const [check, setCheck] = useState<ReelCheck | null>(null);
  const [draft, setDraft] = useState<CaptionDraft | null>(null);
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState('');
  const [writing, setWriting] = useState(false);
  const [captionError, setCaptionError] = useState('');
  const [state, setState] = useState<'PUBLISHED' | 'DRAFT'>('PUBLISHED');
  const [aiLabel, setAiLabel] = useState(true);
  const [post, setPost] = useState<ReelPost | null>(file.facebook && file.facebook.status !== 'done' ? file.facebook : null);
  const [error, setError] = useState('');

  const configured = !!(config?.facebook?.pageId && config.facebook.pageToken);
  const posting = post && !['done', 'error'].includes(post.status);
  const previous = file.facebook?.status === 'done' ? file.facebook : null;

  const write = async () => {
    setWriting(true);
    setCaptionError('');
    try {
      const d = await api.reelCaption(projectId, file.file);
      setDraft(d);
      setCaption(d.caption);
      setTags(d.hashtags.join(' '));
    } catch (e: any) {
      setCaptionError(e.message);
    }
    setWriting(false);
  };

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        setAiLabel(c.facebook?.aiLabel ?? true);
        if (c.facebook?.pageId && c.facebook.pageToken) {
          api.reelCheck(projectId, file.file).then(setCheck).catch((e) => setError(e.message));
          write();
        }
      })
      .catch((e) => setError(e.message));
  }, [file.file]);

  useEffect(
    () =>
      bus.subscribe((e) => {
        if (e.type === 'fb_progress' && e.file === file.file) setPost(e.post as ReelPost);
      }),
    [bus, file.file],
  );

  const hashtags = parseTags(tags);
  const description = [caption.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n');
  const blocked = !!check?.problems.length;

  const addTag = (t: string) => {
    const tag = toTag(t);
    if (tag && !hashtags.includes(tag)) setTags([...hashtags, tag].join(' '));
  };

  const submit = async () => {
    setError('');
    try {
      setPost(await api.postReel(projectId, file.file, {description, state, aiLabel}));
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !posting && onClose()}>
      <div className="modal" style={{width: 'min(640px, 100%)'}}>
        <div className="modal-head">
          <span className="grow">Post to Facebook Reels</span>
          {!posting && (
            <button className="btn ghost icon" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">
          <div className="small faint mono" style={{marginBottom: 16, wordBreak: 'break-all'}}>
            {file.videoName ? `${file.videoName} · ` : ''}
            {file.file}
          </div>

          {config && !configured && (
            <div className="reel-note">
              <div>Add your Facebook Page ID and Page access token first.</div>
              {onOpenSettings && (
                <button
                  className="btn sm"
                  onClick={() => {
                    onClose();
                    onOpenSettings();
                  }}
                >
                  Open Settings
                </button>
              )}
            </div>
          )}

          {configured && !post && (
            <>
              {previous && (
                <div className="reel-note">
                  <Check size={16} style={{color: 'var(--ok)'}} />
                  <span className="grow">
                    Already posted {previous.postedAt ? new Date(previous.postedAt).toLocaleString() : ''}. Posting again makes a second Reel.
                  </span>
                  {previous.url && (
                    <a className="btn sm ghost" href={previous.url} target="_blank" rel="noreferrer">
                      View <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              )}
              {check?.problems.map((p) => (
                <div key={p} className="error-box" style={{marginBottom: 8}}>
                  {p}
                </div>
              ))}
              {check?.warnings.map((w) => (
                <div key={w} className="reel-warn">
                  <AlertTriangle size={14} /> {w}
                </div>
              ))}

              <div className="row" style={{marginBottom: 6}}>
                <label className="label grow" style={{margin: 0}}>
                  Caption
                </label>
                <button className="btn sm ghost" onClick={write} disabled={writing}>
                  {writing ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />} {writing ? 'Writing…' : 'Write again'}
                </button>
              </div>
              <textarea
                className="input reel-caption"
                rows={5}
                placeholder={writing ? 'The AI is writing a caption…' : 'Write a caption'}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
              {captionError && (
                <div className="error-box" style={{marginTop: 8}}>
                  {captionError}
                </div>
              )}

              <label className="label" style={{marginTop: 16}}>
                Hashtags
              </label>
              <input
                className="input mono"
                placeholder="#fyp #reels"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                onBlur={() => setTags(hashtags.join(' '))}
              />
              <div className="hint">All lowercase, without spaces. Separate them with spaces.</div>

              {!!draft?.trends.length && (
                <div style={{marginTop: 12}}>
                  <div className="small faint" style={{marginBottom: 6}}>
                    Trending searches now (Google Trends), click to add:
                  </div>
                  <div className="reel-trends">
                    {draft.trends.slice(0, 15).map((t) => {
                      const tag = toTag(t);
                      const on = hashtags.includes(tag);
                      return (
                        <button key={t} className={`reel-chip ${on ? 'on' : ''}`} onClick={() => addTag(t)} disabled={on} title={t}>
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid2" style={{marginTop: 16}}>
                <div>
                  <label className="label">When</label>
                  <select className="select" value={state} onChange={(e) => setState(e.target.value as 'PUBLISHED' | 'DRAFT')}>
                    <option value="PUBLISHED">Publish now</option>
                    <option value="DRAFT">Save as draft (publish later in Meta Business Suite)</option>
                  </select>
                </div>
                <div>
                  <label className="label">Label</label>
                  <label className="row small" style={{minHeight: 40, cursor: 'pointer'}}>
                    <input type="checkbox" checked={aiLabel} onChange={(e) => setAiLabel(e.target.checked)} />
                    Mark as AI-generated
                  </label>
                </div>
              </div>
              {error && (
                <div className="error-box" style={{marginTop: 12}}>
                  {error}
                </div>
              )}
            </>
          )}

          {post && (
            <div className="job" style={{marginTop: 0}}>
              <div className="row small" style={{marginBottom: 12}}>
                <span className={`tally ${posting ? 'on' : ''}`}>
                  <i />
                </span>
                <span className="grow">
                  {STEP[post.status]}
                  {post.status === 'uploading' ? ` · ${Math.round(post.progress * 100)}%` : ''}
                </span>
              </div>
              {posting && (
                <div className={`progress ${post.status === 'uploading' ? '' : 'indeterminate'}`}>
                  <div style={post.status === 'uploading' ? {transform: `scaleX(${post.progress})`} : undefined} />
                </div>
              )}
              {post.status === 'done' && (
                <div className="small">
                  {post.state === 'DRAFT' ? 'Saved as a draft on your Page.' : 'Your Reel is live on the Page.'}
                  {post.note && <div className="faint" style={{marginTop: 4}}>{post.note}</div>}
                </div>
              )}
              {post.error && <div className="error-box">{post.error}</div>}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div className="grow small faint">
            {configured && !post ? `${description.length} characters` : ''}
          </div>
          {post?.status === 'done' && post.url && (
            <a className="btn primary" href={post.url} target="_blank" rel="noreferrer">
              Open on Facebook <ExternalLink size={16} />
            </a>
          )}
          {post?.status === 'error' && (
            <button className="btn" onClick={() => setPost(null)}>
              Back
            </button>
          )}
          {!post && configured && (
            <button className="btn primary" onClick={submit} disabled={blocked || writing || !description || !check}>
              <Send size={16} /> {state === 'DRAFT' ? 'Save draft' : previous ? 'Post again' : 'Post Reel'}
            </button>
          )}
          {(!posting || post?.status === 'done') && post && (
            <button className="btn ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
