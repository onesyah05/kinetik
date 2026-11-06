import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {DATA, WORKSPACE} from './server/paths';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'web'),
  // Cache next to the user's data: an npm install folder may be read-only.
  cacheDir: path.join(DATA, 'vite'),
  plugins: [react()],
  resolve: {
    alias: {'@kit': path.join(root, 'kit', 'index.tsx')},
    dedupe: ['react', 'react-dom', 'remotion'],
  },
  server: {
    // Project code lives in the workspace (next to the code, or ~/Kinetik for npm installs) and is imported via /@fs/.
    fs: {allow: [root, WORKSPACE]},
    watch: {ignored: ['**/data/**', '**/renders/**', '**/.snapshots/**', '**/chat.json']},
  },
  optimizeDeps: {
    // Pre-bundle everything agent code commonly imports so the preview doesn't reload mid-session.
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'remotion',
      '@remotion/player',
      '@remotion/shapes',
      '@remotion/paths',
      '@remotion/noise',
      '@remotion/transitions',
      '@remotion/transitions/fade',
      '@remotion/transitions/slide',
      '@remotion/transitions/wipe',
      '@remotion/transitions/flip',
      '@remotion/transitions/clock-wipe',
      '@remotion/transitions/iris',
      '@remotion/transitions/none',
      'lucide-react',
      'katex',
      'prism-react-renderer',
    ],
    // Fonts are many small ESM modules; serve them as-is instead of pre-bundling.
    exclude: ['@remotion/google-fonts'],
  },
});
