import React, {useEffect, useState} from 'react';
import {Plus, RefreshCw, Trash2, X} from 'lucide-react';
import {api, type Config, type Provider} from '../api';
import SubscriptionLogin from './SubscriptionLogin';

const ProviderCard: React.FC<{
  p: Provider;
  active: boolean;
  onChange: (p: Provider) => void;
  onActivate: () => void;
  onRemove: () => void;
}> = ({p, active, onChange, onActivate, onRemove}) => {
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const set = (k: keyof Provider, v: unknown) => onChange({...p, [k]: v});
  // Subscription providers point at the local gateway, so their model list is always reachable.
  const isSub = p.id.startsWith('sub:');

  const fetchModels = async () => {
    setMsg('Loading…');
    try {
      const r = await api.models({providerId: p.id, baseURL: p.baseURL, apiKey: p.apiKey});
      setModels(isSub ? r.models : [...r.models].sort());
      setMsg(`${r.models.length} models`);
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  useEffect(() => {
    if (isSub) fetchModels();
  }, [p.id]);

  return (
    <div className={`provider ${active ? 'active' : ''}`}>
      <div className="provider-head">
        <input className="input" style={{width: 200, fontWeight: 500}} value={p.name} onChange={(e) => set('name', e.target.value)} />
        <div className="grow" />
        {active ? (
          <span className="chip">Default</span>
        ) : (
          <button className="btn sm" onClick={onActivate}>
            Make default
          </button>
        )}
        <button className="btn ghost icon sm danger" onClick={onRemove} title="Remove">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="grid2">
        <div>
          <label className="label">Base URL</label>
          <input className="input mono" value={p.baseURL} onChange={(e) => set('baseURL', e.target.value)} />
        </div>
        <div>
          <label className="label">API key</label>
          <input className="input mono" type="password" placeholder="sk-…" value={p.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
        </div>
      </div>
      <div className="grid2" style={{marginTop: 16}}>
        <div>
          <label className="label">Model</label>
          <div className="row">
            {isSub && models.length ? (
              <select className="select mono grow" value={p.model} onChange={(e) => set('model', e.target.value)}>
                {!models.includes(p.model) && <option value={p.model}>{p.model}</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input mono" list={`models-${p.id}`} value={p.model} onChange={(e) => set('model', e.target.value)} />
            )}
            <datalist id={`models-${p.id}`}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button className="btn icon" style={{height: 36, width: 36}} title="Fetch model list" onClick={fetchModels}>
              <RefreshCw size={16} />
            </button>
          </div>
          {msg && <div className="hint">{msg}</div>}
        </div>
        <div className="row" style={{alignItems: 'flex-end', gap: 16}}>
          <label className="row small grow" style={{cursor: 'pointer', height: 36}}>
            <input type="checkbox" checked={p.vision} onChange={(e) => set('vision', e.target.checked)} style={{accentColor: '#ff7a45'}} />
            Can see images
          </label>
          <label className="row small grow" style={{cursor: 'pointer', height: 36}} title="For gateways that drop replies with several tool calls. Turned on automatically when detected">
            <input
              type="checkbox"
              checked={!!p.oneToolPerTurn}
              onChange={(e) => set('oneToolPerTurn', e.target.checked)}
              style={{accentColor: '#ff7a45'}}
            />
            One tool per reply
          </label>
          <div style={{width: 110}}>
            <label className="label">Max tokens</label>
            <input
              className="input"
              type="number"
              placeholder="auto"
              value={p.maxTokens ?? ''}
              onChange={(e) => set('maxTokens', e.target.value ? +e.target.value : undefined)}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const GEMINI_VOICES = [
  'Aoede · breezy, female',
  'Leda · youthful, female',
  'Zephyr · bright, female',
  'Kore · firm, female',
  'Sulafat · warm, female',
  'Sadachbia · lively, female',
  'Laomedeia · upbeat, female',
  'Despina · smooth, female',
  'Achernar · soft, female',
  'Puck · upbeat, male',
  'Fenrir · excitable, male',
  'Charon · informative, male',
  'Achird · friendly, male',
  'Zubenelgenubi · casual, male',
  'Umbriel · easy-going, male',
  'Orus · firm, male',
  'Sadaltager · knowledgeable, male',
];

const VoiceSettings: React.FC<{c: Config; setC: (c: Config) => void}> = ({c, setC}) => {
  const t = c.tts;
  const set = (patch: Partial<Config['tts']>) => setC({...c, tts: {...t, ...patch}});
  const [audio, setAudio] = useState('');
  const [msg, setMsg] = useState('');
  const test = async () => {
    setMsg('Generating sample, save settings first if you changed them');
    setAudio('');
    try {
      const url = await api.testVoice();
      setAudio(url);
      setMsg('');
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  return (
    <>
      <div className="presets" style={{marginBottom: 16}}>
        {(
          [
            ['gemini', 'Gemini TTS', 'Expressive, follows tone direction. Needs a Google AI Studio key'],
            ['edge', 'Edge TTS', 'Free and fast, flatter delivery'],
          ] as const
        ).map(([id, title, sub]) => (
          <div key={id} className={`preset ${t.engine === id ? 'active' : ''}`} onClick={() => set({engine: id})} style={{flex: 1}}>
            <div>
              <div className="preset-title">{title}</div>
              <div className="preset-sub">{sub}</div>
            </div>
          </div>
        ))}
      </div>
      {t.engine === 'gemini' ? (
        <>
          <div className="grid2">
            <div>
              <label className="label">Gemini API key</label>
              <input className="input mono" type="password" placeholder="AIza…" value={t.geminiKey} onChange={(e) => set({geminiKey: e.target.value})} />
              <div className="hint">
                Free key at{' '}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                  aistudio.google.com/apikey
                </a>
              </div>
            </div>
            <div>
              <label className="label">Default voice</label>
              <select className="select" value={t.geminiVoice} onChange={(e) => set({geminiVoice: e.target.value})}>
                {GEMINI_VOICES.map((v) => (
                  <option key={v} value={v.split(' ')[0]}>
                    {v}
                  </option>
                ))}
              </select>
              <div className="hint">The agent may pick another voice to fit the style</div>
            </div>
          </div>
          <div className="field" style={{marginTop: 16, maxWidth: 360}}>
            <label className="label">Model</label>
            <input className="input mono" value={t.geminiModel} onChange={(e) => set({geminiModel: e.target.value})} />
          </div>
        </>
      ) : (
        <div className="grid2">
          <div>
            <label className="label">Default voice</label>
            <input className="input mono" value={t.defaultVoice} onChange={(e) => set({defaultVoice: e.target.value})} placeholder="id-ID-GadisNeural" />
            <div className="hint">id-ID-GadisNeural or id-ID-ArdiNeural pronounce Indonesian best</div>
          </div>
          <div>
            <label className="label">Default speed</label>
            <input className="input mono" value={t.rate} onChange={(e) => set({rate: e.target.value})} placeholder="+0%" />
          </div>
        </div>
      )}
      <div className="row" style={{marginTop: 12}}>
        <button className="btn sm" onClick={test}>
          Test voice
        </button>
        {audio && <audio src={audio} controls autoPlay style={{height: 32}} />}
        {msg && <span className="small faint">{msg}</span>}
      </div>
    </>
  );
};

export const SettingsModal: React.FC<{onClose: () => void}> = ({onClose}) => {
  const [c, setC] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.config().then(setC).catch((e) => setError(e.message));
  }, []);

  if (!c) return null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.saveConfig(c);
      window.dispatchEvent(new Event('kinetik:config'));
      onClose();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  const setProvider = (i: number, p: Provider) => setC({...c, providers: c.providers.map((x, j) => (j === i ? p : x))});
  const addProvider = () =>
    setC({
      ...c,
      providers: [
        ...c.providers,
        {id: `custom-${Date.now().toString(36)}`, name: 'Custom', baseURL: 'https://', apiKey: '', model: '', vision: true},
      ],
    });

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <span className="grow">Settings</span>
          <button className="btn ghost icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="section" style={{maxWidth: 'none'}}>
            <h3>LLM providers</h3>
            <p className="small muted" style={{margin: '0 0 16px'}}>
              Any OpenAI-compatible endpoint that ends in <span className="mono">/v1</span> and supports tool calling, like OpenAI,
              OpenRouter, Gemini, DeepSeek, Groq, LM Studio or Ollama. Pick a model that can see images so the agent can check its own
              frames.
            </p>
            <SubscriptionLogin
              onChange={async () => {
                try {
                  // Take the subscription providers from the server but keep unsaved edits to the others.
                  const fresh = await api.config();
                  setC((cur) =>
                    cur
                      ? {
                          ...cur,
                          providers: [
                            ...cur.providers.filter((p) => !p.id.startsWith('sub:')),
                            ...fresh.providers.filter((p) => p.id.startsWith('sub:')),
                          ],
                        }
                      : fresh,
                  );
                  window.dispatchEvent(new Event('kinetik:config'));
                } catch {
                  /* ignore */
                }
              }}
            />
            {c.providers.map((p, i) => (
              <ProviderCard
                key={p.id}
                p={p}
                active={c.activeProvider === p.id}
                onChange={(np) => setProvider(i, np)}
                onActivate={() => setC({...c, activeProvider: p.id})}
                onRemove={() => setC({...c, providers: c.providers.filter((_, j) => j !== i)})}
              />
            ))}
            <button className="btn" onClick={addProvider}>
              <Plus size={16} /> Add provider
            </button>

            <h3>Voiceover</h3>
            <VoiceSettings c={c} setC={setC} />

            <h3>Image generation</h3>
            <div className="grid2" style={{marginBottom: 16}}>
              <div>
                <label className="label">Endpoint</label>
                <select
                  className="select"
                  value={c.imageGen.providerId ?? ''}
                  onChange={(e) => setC({...c, imageGen: {...c.imageGen, providerId: e.target.value || undefined}})}
                >
                  <option value="auto">Same as the chat model (auto: Codex or Antigravity)</option>
                  <option value="">Separate endpoint below</option>
                  {c.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      Same as {p.name} ({p.baseURL.replace(/^https?:\/\//, '')})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Image model</label>
                <input className="input mono" value={c.imageGen.model} onChange={(e) => setC({...c, imageGen: {...c.imageGen, model: e.target.value}})} />
              </div>
            </div>
            <div className="grid2" style={{opacity: c.imageGen.providerId ? 0.45 : 1, pointerEvents: c.imageGen.providerId ? 'none' : 'auto'}}>
              <div>
                <label className="label">Base URL</label>
                <input className="input mono" value={c.imageGen.baseURL} onChange={(e) => setC({...c, imageGen: {...c.imageGen, baseURL: e.target.value}})} />
              </div>
              <div>
                <label className="label">API key</label>
                <input
                  className="input mono"
                  type="password"
                  value={c.imageGen.apiKey}
                  onChange={(e) => setC({...c, imageGen: {...c.imageGen, apiKey: e.target.value}})}
                />
              </div>
              <div>
                <label className="label">Default size</label>
                <input className="input mono" value={c.imageGen.size} onChange={(e) => setC({...c, imageGen: {...c.imageGen, size: e.target.value}})} />
              </div>
            </div>

            <h3>Character rigging</h3>
            <p className="small muted" style={{margin: '0 0 16px'}}>
              Cuts characters into parts (wings, tail, head) so they can move on their own. Precise masks come from Gemini (key under
              Voiceover, about 20 a day free); otherwise a vision model below finds the parts and they are cut locally.
            </p>
            <div className="grid2">
              <div>
                <label className="label">Provider for part detection</label>
                <select
                  className="select"
                  value={c.rig?.providerId ?? ''}
                  onChange={(e) => setC({...c, rig: {...c.rig, providerId: e.target.value || undefined}})}
                >
                  <option value="">Same as the chat model</option>
                  {c.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Vision model</label>
                <input
                  className="input mono"
                  placeholder="e.g. antigravity/gemini-3-flash"
                  value={c.rig?.model ?? ''}
                  onChange={(e) => setC({...c, rig: {...c.rig, model: e.target.value}})}
                />
              </div>
            </div>

            <h3>Stock media</h3>
            <p className="small muted" style={{margin: '0 0 16px'}}>
              Both keys are free from <a href="https://www.pexels.com/api/" target="_blank" rel="noreferrer">Pexels</a> and{' '}
              <a href="https://unsplash.com/developers" target="_blank" rel="noreferrer">Unsplash</a>
            </p>
            <div className="grid2">
              <div>
                <label className="label">Pexels key, photos and video</label>
                <input
                  className="input mono"
                  type="password"
                  value={c.stock.pexelsKey}
                  onChange={(e) => setC({...c, stock: {...c.stock, pexelsKey: e.target.value}})}
                />
              </div>
              <div>
                <label className="label">Unsplash key, photos</label>
                <input
                  className="input mono"
                  type="password"
                  value={c.stock.unsplashKey}
                  onChange={(e) => setC({...c, stock: {...c.stock, unsplashKey: e.target.value}})}
                />
              </div>
            </div>

            <h3>Rendering and agent</h3>
            <div className="grid3">
              <div>
                <label className="label">Render concurrency</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={16}
                  value={c.render.concurrency}
                  onChange={(e) => setC({...c, render: {...c.render, concurrency: +e.target.value}})}
                />
                <div className="hint">Parallel browser tabs, 2 suits 8 GB of RAM</div>
              </div>
              <div>
                <label className="label">Agent steps per message</label>
                <input
                  className="input"
                  type="number"
                  min={5}
                  value={c.agent.maxSteps}
                  onChange={(e) => setC({...c, agent: {...c.agent, maxSteps: +e.target.value}})}
                />
              </div>
              <div>
                <label className="label">Snapshot long side in px</label>
                <input
                  className="input"
                  type="number"
                  min={256}
                  max={1920}
                  value={c.agent.snapshotMaxSide}
                  onChange={(e) => setC({...c, agent: {...c.agent, snapshotMaxSide: +e.target.value}})}
                />
              </div>
            </div>
          </div>
          {error && <div className="error-box" style={{marginTop: 16}}>{error}</div>}
        </div>
        <div className="modal-foot">
          <span className="small faint grow">Saved to data/config.json on this computer.</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
