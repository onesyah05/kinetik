import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {CrashScreen} from './components/CrashScreen';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// After an update the browser can ask for files from the old version; one reload fixes it.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  if (sessionStorage.getItem('kinetik-reloaded')) return;
  sessionStorage.setItem('kinetik-reloaded', '1');
  location.reload();
});
setTimeout(() => sessionStorage.removeItem('kinetik-reloaded'), 10_000);

createRoot(document.getElementById('root')!).render(
  <CrashScreen>
    <App />
  </CrashScreen>,
);
