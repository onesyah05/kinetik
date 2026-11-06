import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowLeft, Clapperboard, Code2, Film, FolderOpen, Settings, SlidersHorizontal} from 'lucide-react';
import {api, timecode, useEvents, type Config, type Project, type ServerEvent} from '../api';
import {go} from '../App';
import {Brand} from './Home';
import {Chat} from './Chat';
import {Preview} from './Preview';
import {CodeEditor} from './CodeEditor';
import {Assets} from './Assets';
import {Renders} from './Renders';
import {ProjectSettingsPanel} from './ProjectSettings';
import {VideoSwitcher} from './VideoSwitcher';
import {UpdateButton} from './UpdateButton';

export type Bus = {subscribe: (fn: (e: ServerEvent) => void) => () => void};

type Tab = 'preview' | 'code' | 'assets' | 'renders' | 'settings';

export const ProjectView: React.FC<{id: string; onOpenSettings: () => void}> = ({id, onOpenSettings}) => {
  const [project, setProject] = useState<Project | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [videoError, setVideoError] = useState('');
  const [tab, setTab] = useState<Tab>('preview');
  const [codeVersion, setCodeVersion] = useState(0);
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [renderActive, setRenderActive] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const [name, setName] = useState('');
  const listeners = useRef(new Set<(e: ServerEvent) => void>());

  const bus: Bus = {
    subscribe: useCallback((fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    }, []),
  };

  useEffect(() => {
    api
      .project(id)
      .then((p) => {
        setProject(p);
        setName(p.name);
        setAgentActive(!!p.running);
      })
      .catch((e) => setError(e.message));
    api.config().then(setConfig);
  }, [id]);

  // staticFile() in the preview resolves against this project's public folder. The version segment changes
  // whenever assets change, so replaced images are fetched again instead of coming from the browser cache.
  (window as any).remotion_staticBase = `/ws/${id}/v/${assetsVersion}/public`;

  // Re-read config when the settings modal saves (cheap; providers list may change).
  useEffect(() => {
    const on = () => api.config().then(setConfig);
    window.addEventListener('kinetik:config', on);
    return () => window.removeEventListener('kinetik:config', on);
  }, []);

  useEvents(id, (e) => {
    if (e.type === 'files_changed') setCodeVersion((v) => v + 1);
    if (e.type === 'assets_changed') setAssetsVersion((v) => v + 1);
    if (e.type === 'project_updated') {
      setProject((p) => ({...p, ...e.project}));
      setName(e.project.name);
    }
    if (e.type === 'agent' && e.event === 'status') setAgentActive(e.running);
    if (e.type === 'render_progress') setRenderActive(e.job.status === 'bundling' || e.job.status === 'rendering');
    for (const fn of listeners.current) fn(e);
  });

  const saveName = async () => {
    if (project && name.trim() && name !== project.name) setProject(await api.updateProject(id, {name: name.trim()}));
  };

  const providerId = project?.providerId ?? config?.activeProvider;
  const setProvider = async (pid: string) => setProject(await api.updateProject(id, {providerId: pid}));

  if (error)
    return (
      <div className="pad">
        <div className="error-box">{error}</div>
        <button className="btn" style={{marginTop: 12}} onClick={() => go(null)}>
          Back
        </button>
      </div>
    );
  if (!project) return <div className="empty">Loading project</div>;

  const tabs: [Tab, string, React.ReactNode][] = [
    ['preview', 'Preview', <Film size={16} />],
    ['code', 'Code', <Code2 size={16} />],
    ['assets', 'Assets', <FolderOpen size={16} />],
    ['renders', 'Renders', <Clapperboard size={16} />],
    ['settings', 'Video settings', <SlidersHorizontal size={16} />],
  ];

  return (
    <div className="project">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => go(null)} title="All projects">
          <ArrowLeft size={16} />
        </button>
        <Brand />
        <div className="divider" />
        <input
          className="title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="chip">
          {project.width}×{project.height} · {project.fps} fps · {timecode(project.durationInFrames, project.fps)}
        </span>
        <div className="divider" />
        <VideoSwitcher
          project={project}
          busy={agentActive}
          providerId={providerId}
          onProject={(p) => setProject((cur) => ({...cur, ...p}))}
          onError={setVideoError}
        />
        {videoError && (
          <span className="chip video-error" title={videoError} onClick={() => setVideoError('')}>
            {videoError.slice(0, 80)} ✕
          </span>
        )}
        <div className="grow" />
        <span className={`tally ${agentActive || renderActive ? 'on' : ''}`} title="Lit while the agent works or a render runs">
          <i />
          {renderActive ? 'Rendering' : agentActive ? 'Agent working' : 'Idle'}
        </span>
        <div className="divider" />
        <select className="select" style={{width: 232, height: 32}} value={providerId} onChange={(e) => setProvider(e.target.value)} title="Model">
          {config?.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model}
            </option>
          ))}
        </select>
        <UpdateButton />
        <button className="btn ghost icon" onClick={onOpenSettings} title="Settings">
          <Settings size={16} />
        </button>
        <button className="btn primary" onClick={() => setTab('renders')}>
          <Clapperboard size={16} /> Render
        </button>
      </div>

      <div className="workbench">
        <aside className="side">
          <Chat projectId={id} project={project} bus={bus} providerId={providerId} config={config} onOpenSettings={onOpenSettings} />
        </aside>
        <main className="main">
          <div className="tabs">
            {tabs.map(([k, label, icon]) => (
              <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
                {icon} {label}
              </button>
            ))}
          </div>
          <div className="tab-body">
            {/* Preview stays mounted so playback position survives tab switches. */}
            <div style={{display: tab === 'preview' ? 'block' : 'none', height: '100%'}}>
              <Preview project={project} version={codeVersion + assetsVersion} />
            </div>
            {tab === 'code' && <CodeEditor projectId={id} version={codeVersion} />}
            {tab === 'assets' && <Assets projectId={id} version={assetsVersion} />}
            {tab === 'renders' && <Renders project={project} bus={bus} onOpenSettings={onOpenSettings} />}
            {tab === 'settings' && <ProjectSettingsPanel project={project} onChange={setProject} />}
          </div>
        </main>
      </div>
    </div>
  );
};
