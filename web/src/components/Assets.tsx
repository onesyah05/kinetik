import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Check, Copy, FileAudio, FileText, Film, Folder, Move3d, Trash2, Type, Upload} from 'lucide-react';
import {askAgent} from './Preview';
import {api, formatBytes, publicUrl, type Asset} from '../api';

/** One sprite or rig: every file the tool wrote under public/<kind>/<name>/. */
type AssetFolder = {kind: 'sprites' | 'rigs'; name: string; path: string; files: Asset[]; size: number};

const groupAssets = (assets: Asset[]) => {
  const folders = new Map<string, AssetFolder>();
  const loose: Asset[] = [];
  for (const a of assets) {
    const m = a.path.match(/^(sprites|rigs)\/([^/]+)\/.+/);
    if (!m) {
      loose.push(a);
      continue;
    }
    const key = `${m[1]}/${m[2]}`;
    const f = folders.get(key) ?? {kind: m[1] as AssetFolder['kind'], name: m[2], path: key, files: [], size: 0};
    f.files.push(a);
    f.size += a.size;
    folders.set(key, f);
  }
  const all = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of all) f.files.sort((a, b) => a.path.localeCompare(b.path, undefined, {numeric: true}));
  return {sprites: all.filter((f) => f.kind === 'sprites'), rigs: all.filter((f) => f.kind === 'rigs'), loose};
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export const Assets: React.FC<{projectId: string; version: number}> = ({projectId, version}) => {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = () => api.assets(projectId).then(setAssets);
  useEffect(() => {
    load();
  }, [projectId, version]);
  useEffect(() => setOpenPath(null), [projectId]);

  const {sprites, rigs, loose} = useMemo(() => groupAssets(assets), [assets]);
  const open = [...sprites, ...rigs].find((f) => f.path === openPath);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      await api.upload(projectId, files);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (a: Asset) => {
    navigator.clipboard.writeText(`staticFile('${a.path}')`);
    setCopied(a.path);
    setTimeout(() => setCopied(''), 1200);
  };

  const remove = async (a: Asset) => {
    if (!confirm(`Delete ${a.path}?`)) return;
    await api.deleteAsset(projectId, a.path);
    load();
  };

  const removeFolder = async (f: AssetFolder) => {
    const what = f.kind === 'sprites' ? `sprite "${f.name}" (${f.files.length} frames)` : `rig "${f.name}" (${f.files.length} layers)`;
    if (!confirm(`Delete ${what}? Scenes that still use it will break until the agent changes them.`)) return;
    try {
      await api.deleteAsset(projectId, f.path);
      if (openPath === f.path) setOpenPath(null);
    } catch (e: any) {
      setError(e.message);
    }
    load();
  };

  const card = (a: Asset, label = a.path) => (
    <AssetCard
      key={a.path}
      asset={a}
      label={label}
      url={`${publicUrl(projectId, a.path)}?v=${version}`}
      copied={copied === a.path}
      onCopy={copy}
      onRemove={remove}
    />
  );

  const folderGrid = (title: string, list: AssetFolder[]) =>
    list.length > 0 && (
      <section>
        <h3 className="asset-section">
          {title} <span className="faint">{list.length}</span>
        </h3>
        <div className="asset-grid">
          {list.map((f) => (
            <FolderCard
              key={f.path}
              folder={f}
              projectId={projectId}
              version={version}
              onOpen={() => setOpenPath(f.path)}
              onRemove={() => removeFolder(f)}
            />
          ))}
        </div>
      </section>
    );

  if (open)
    return (
      <div className="pad">
        <div className="asset-crumbs">
          <button className="btn ghost sm" onClick={() => setOpenPath(null)}>
            <ArrowLeft size={16} /> Assets
          </button>
          <span className="faint">/</span>
          <span className="mono">{open.path}</span>
        </div>
        <p className="page-sub">
          {open.kind === 'sprites' ? `Sprite · ${open.files.length} frames` : `Rig · ${open.files.length} layers`} ·{' '}
          {formatBytes(open.size)}
        </p>
        {error && (
          <div className="error-box" style={{marginTop: 12}}>
            {error}
          </div>
        )}
        <div className="asset-grid">{open.files.map((a) => card(a, baseName(a.path)))}</div>
      </div>
    );

  return (
    <div className="pad">
      <h2 className="page-title">Assets</h2>
      <p className="page-sub">Files in public/ that the agent can use in the video</p>
      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload([...e.dataTransfer.files]);
        }}
      >
        <div className="drop-icon">
          <Upload size={16} />
        </div>
        <div>
          <div style={{color: 'var(--text)'}}>{busy ? 'Uploading' : 'Drop images, video, music or fonts, or click to choose'}</div>
          <div className="small faint">Then tell the agent where they go, like “logo.png in the intro, music.mp3 under everything”</div>
        </div>
        <input ref={input} type="file" multiple hidden onChange={(e) => upload([...(e.target.files ?? [])])} />
      </div>
      {error && (
        <div className="error-box" style={{marginTop: 12}}>
          {error}
        </div>
      )}
      {assets.length === 0 && <div className="empty">No assets yet</div>}
      {folderGrid('Sprites', sprites)}
      {folderGrid('Rigs', rigs)}
      {loose.length > 0 && (
        <section>
          {sprites.length + rigs.length > 0 && (
            <h3 className="asset-section">
              Files <span className="faint">{loose.length}</span>
            </h3>
          )}
          <div className="asset-grid">{loose.map((a) => card(a))}</div>
        </section>
      )}
    </div>
  );
};

const AssetCard: React.FC<{
  asset: Asset;
  label: string;
  url: string;
  copied: boolean;
  onCopy: (a: Asset) => void;
  onRemove: (a: Asset) => void;
}> = ({asset: a, label, url, copied, onCopy, onRemove}) => (
  <div className="asset">
    <div className="asset-media">
      {a.kind === 'image' ? (
        <img src={url} loading="lazy" />
      ) : a.kind === 'video' ? (
        <video src={url} muted preload="metadata" />
      ) : a.kind === 'audio' ? (
        <div style={{width: '100%', padding: 8, textAlign: 'center'}}>
          <FileAudio size={20} />
          <audio src={url} controls preload="none" style={{width: '100%', height: 32, marginTop: 8}} />
        </div>
      ) : a.kind === 'font' ? (
        <Type size={20} />
      ) : (
        <FileText size={20} />
      )}
    </div>
    <div className="asset-info">
      <div className="asset-name" title={a.path}>
        {label}
      </div>
      {a.kind === 'image' && !a.path.startsWith('rigs/') && !a.path.startsWith('sprites/') && (
        <div className="asset-actions">
          <button
            className="btn sm"
            title="Draw a frame-by-frame animation of this character (e.g. wings flapping, walking)"
            onClick={() =>
              askAgent(`Buat animasi frame-by-frame dari ${a.path} dengan generate_sprite, lalu pakai <Sprite> di video. Gerakannya: `)
            }
          >
            <Film size={16} /> Animate frames
          </button>
          <button
            className="btn sm"
            title="Cut the character into parts that move on their own (wings flap, tail wags, head nods)"
            onClick={() =>
              askAgent(
                `Animasikan bagian-bagian ${a.path} dengan rig_character (misalnya sayap mengepak, ekor bergoyang, kepala mengangguk saat bicara) lalu pakai <Puppet> di video.`,
              )
            }
          >
            <Move3d size={16} /> Animate parts
          </button>
        </div>
      )}
      <div className="row">
        <span className="faint grow mono" style={{fontSize: 12}}>
          {formatBytes(a.size)}
        </span>
        <button className="btn ghost icon sm" title="Copy staticFile() path" onClick={() => onCopy(a)}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button className="btn ghost icon sm danger" title="Delete" onClick={() => onRemove(a)}>
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  </div>
);

/** A sprite or rig shown as one card. Sprites play their frames while hovered. */
const FolderCard: React.FC<{folder: AssetFolder; projectId: string; version: number; onOpen: () => void; onRemove: () => void}> = ({
  folder: f,
  projectId,
  version,
  onOpen,
  onRemove,
}) => {
  const images = f.files.filter((a) => a.kind === 'image');
  const cover = f.kind === 'rigs' ? (images.find((a) => /-body\.[a-z]+$/i.test(a.path)) ?? images[0]) : images[0];
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (frame < 0 || images.length < 2) return;
    const t = setTimeout(() => setFrame((i) => (i + 1) % images.length), 110);
    return () => clearTimeout(t);
  }, [frame, images.length]);
  const shown = f.kind === 'sprites' && frame >= 0 ? images[frame] : cover;
  const count = f.kind === 'sprites' ? `${f.files.length} frames` : `${f.files.length} ${f.files.length === 1 ? 'layer' : 'layers'}`;

  return (
    <div
      className="asset folder"
      role="button"
      tabIndex={0}
      title={`Open ${f.path}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      onMouseEnter={() => f.kind === 'sprites' && setFrame(0)}
      onMouseLeave={() => setFrame(-1)}
    >
      <div className="asset-media">
        {shown ? <img src={`${publicUrl(projectId, shown.path)}?v=${version}`} loading="lazy" /> : <Folder size={20} />}
        <span className="folder-badge">
          {f.kind === 'sprites' ? <Film size={12} /> : <Move3d size={12} />} {count}
        </span>
      </div>
      <div className="asset-info">
        <div className="row">
          <Folder size={14} className="faint" style={{flex: 'none'}} />
          <span className="asset-name grow" style={{margin: 0}} title={f.path}>
            {f.name}
          </span>
        </div>
        <div className="row">
          <span className="faint grow mono" style={{fontSize: 12}}>
            {formatBytes(f.size)}
          </span>
          <button
            className="btn ghost icon sm danger"
            title={`Delete this ${f.kind === 'sprites' ? 'sprite' : 'rig'}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
