import React, {useEffect, useRef, useState} from 'react';
import {Check, Copy, FileAudio, FileText, Film, Move3d, Trash2, Type, Upload} from 'lucide-react';
import {askAgent} from './Preview';
import {api, formatBytes, publicUrl, type Asset} from '../api';

export const Assets: React.FC<{projectId: string; version: number}> = ({projectId, version}) => {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = () => api.assets(projectId).then(setAssets);
  useEffect(() => {
    load();
  }, [projectId, version]);

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
      <div className="asset-grid">
        {assets.map((a) => {
          const url = `${publicUrl(projectId, a.path)}?v=${version}`;
          return (
            <div key={a.path} className="asset">
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
                  {a.path}
                </div>
                {a.kind === 'image' && !a.path.startsWith('rigs/') && !a.path.startsWith('sprites/') && (
                  <div className="asset-actions">
                    <button
                      className="btn sm"
                      title="Draw a frame-by-frame animation of this character (e.g. wings flapping, walking)"
                      onClick={() =>
                        askAgent(
                          `Buat animasi frame-by-frame dari ${a.path} dengan generate_sprite, lalu pakai <Sprite> di video. Gerakannya: `,
                        )
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
                  <button className="btn ghost icon sm" title="Copy staticFile() path" onClick={() => copy(a)}>
                    {copied === a.path ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  <button className="btn ghost icon sm danger" title="Delete" onClick={() => remove(a)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
