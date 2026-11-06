import React, {useState} from 'react';
import {Plus, Trash2, X} from 'lucide-react';
import {api, type Project, type VideoEntry} from '../api';

const MAIN = 'main';

/** The project's videos (all share its style and assets), plus "New video". */
export const VideoSwitcher: React.FC<{
  project: Project;
  busy: boolean;
  providerId?: string;
  onProject: (p: Project) => void;
  onError: (msg: string) => void;
}> = ({project, busy, providerId, onProject, onError}) => {
  const [open, setOpen] = useState(false);
  const videos: VideoEntry[] = project.videos?.length
    ? project.videos
    : [{id: MAIN, name: project.name, durationInFrames: project.durationInFrames}];
  const active = project.activeVideo ?? MAIN;

  const run = async (fn: () => Promise<Project | void>) => {
    try {
      const p = await fn();
      if (p) onProject(p);
    } catch (e: any) {
      onError(e.message);
    }
  };

  return (
    <>
      <div className="video-switch">
        <select
          className="select"
          value={active}
          disabled={busy}
          title={busy ? 'Wait for the agent to finish before switching videos' : 'Videos in this project'}
          onChange={(e) => run(() => api.switchVideo(project.id, e.target.value))}
        >
          {videos.map((v, i) => (
            <option key={v.id} value={v.id}>
              {i + 1}. {v.name}
            </option>
          ))}
        </select>
        {active !== MAIN && (
          <button
            className="btn ghost icon sm danger"
            disabled={busy}
            title="Delete this video"
            onClick={() => {
              const v = videos.find((x) => x.id === active);
              if (confirm(`Delete the video "${v?.name}" and its scenes? Shared assets stay.`)) run(() => api.deleteVideo(project.id, active));
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
        <button className="btn sm" disabled={busy} onClick={() => setOpen(true)} title="Add videos in the same style, with the same assets">
          <Plus size={14} /> New video
        </button>
      </div>
      {open && (
        <NewVideoDialog
          project={project}
          providerId={providerId}
          onClose={() => setOpen(false)}
          onDone={(p) => {
            setOpen(false);
            onProject(p);
          }}
          onError={onError}
        />
      )}
    </>
  );
};

const NewVideoDialog: React.FC<{
  project: Project;
  providerId?: string;
  onClose: () => void;
  onDone: (p: Project) => void;
  onError: (msg: string) => void;
}> = ({project, providerId, onClose, onDone, onError}) => {
  const [text, setText] = useState('');
  const [build, setBuild] = useState(true);
  const [saving, setSaving] = useState(false);
  const themes = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20);

  const create = async () => {
    if (!themes.length) return;
    setSaving(true);
    try {
      const {created} = await api.createVideos(
        project.id,
        themes.map((t) => ({name: t.length > 60 ? `${t.slice(0, 57)}…` : t, theme: t})),
      );
      const p = await api.switchVideo(project.id, created[0].id);
      if (build) {
        const list = created.map((v) => `- ${v.id}: ${v.theme ?? v.name}`).join('\n');
        await api.chat(project.id, {
          providerId,
          text:
            created.length === 1
              ? `Make the new video ${created[0].id} about: ${created[0].theme ?? created[0].name}\nUse the same style, voice and assets as the existing video(s) in this project.`
              : `Make these ${created.length} new videos, one per theme, in the same style and with the same voice and assets as the existing video(s) in this project. Build them one at a time with switch_video:\n${list}`,
        });
      }
      onDone(p);
    } catch (e: any) {
      onError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth: 520}}>
        <div className="modal-head">
          <span className="grow">New video</span>
          <button className="btn ghost icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="small muted" style={{margin: '0 0 12px'}}>
            New videos use this project's size, style, voice and assets. Write one theme per line: each line becomes its own video.
          </p>
          <textarea
            className="input"
            autoFocus
            rows={6}
            style={{width: '100%', resize: 'vertical', lineHeight: 1.5}}
            placeholder={'Kenapa kita menguap?\nKenapa kuku tumbuh?\nKenapa perut berbunyi?'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="row small" style={{marginTop: 12, cursor: 'pointer'}}>
            <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} style={{accentColor: '#ff7a45'}} />
            Ask the agent to build them now
          </label>
          <div className="row" style={{marginTop: 16, justifyContent: 'flex-end', gap: 8}}>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!themes.length || saving} onClick={create}>
              {saving ? 'Creating…' : themes.length > 1 ? `Create ${themes.length} videos` : 'Create video'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
