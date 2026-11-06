import React, {useEffect, useState} from 'react';
import {Home} from './components/Home';
import {ProjectView} from './components/ProjectView';
import {SettingsModal} from './components/SettingsModal';

const parse = () => {
  const m = location.hash.match(/^#\/p\/([a-z0-9-]+)/);
  return m ? m[1] : null;
};

export const App: React.FC = () => {
  const [projectId, setProjectId] = useState<string | null>(parse);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    const on = () => setProjectId(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  return (
    <>
      {projectId ? (
        <ProjectView key={projectId} id={projectId} onOpenSettings={() => setSettings(true)} />
      ) : (
        <Home onOpenSettings={() => setSettings(true)} />
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </>
  );
};

export const go = (projectId: string | null) => {
  location.hash = projectId ? `#/p/${projectId}` : '#/';
};
