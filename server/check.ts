import path from 'node:path';
import * as esbuild from 'esbuild';
import {KIT} from './paths';
import {activeVideoId, getProject, projectDir, readFile, listSourceFiles, videoEntryRel} from './projects';

export type CheckResult = {ok: boolean; errors: string[]; warnings: string[]};

/** Compile one entry file (and everything it imports) with esbuild. */
export const compileEntry = async (id: string, rel: string) => {
  const dir = projectDir(id);
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const res = await esbuild.build({
      entryPoints: [path.join(dir, rel)],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      logLevel: 'silent',
      absWorkingDir: dir,
      loader: {'.png': 'empty', '.jpg': 'empty', '.svg': 'empty', '.css': 'empty', '.json': 'json'},
      plugins: [
        {
          name: 'kit-alias',
          setup(b) {
            b.onResolve({filter: /^@kit$/}, () => ({path: KIT}));
          },
        },
      ],
    });
    for (const w of res.warnings) warnings.push(fmt(w, dir));
  } catch (e: any) {
    if (e?.errors) for (const er of e.errors) errors.push(fmt(er, dir));
    else errors.push(String(e?.message ?? e));
  }
  return {errors, warnings};
};

/** Fast compile check of the video (syntax, imports, exports) plus Remotion-specific lint rules. */
export const checkProject = async (id: string): Promise<CheckResult> => {
  const {errors, warnings} = await compileEntry(id, videoEntryRel(activeVideoId(getProject(id))));

  // Lint rules that catch the most common Remotion mistakes.
  for (const f of listSourceFiles(id)) {
    if (!/\.(tsx?|jsx?)$/.test(f.path) || f.managed) continue;
    const src = readFile(id, f.path);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const at = `${f.path}:${i + 1}`;
      if (/Math\.random\(/.test(line)) warnings.push(`${at}: Math.random() makes frames non-deterministic. Use random('seed') from remotion.`);
      if (/\b(setTimeout|setInterval|requestAnimationFrame)\(/.test(line))
        warnings.push(`${at}: timers do not work in rendering. Derive everything from useCurrentFrame().`);
      if (/(transition|animation)\s*:\s*['"`]/.test(line) && !/transitionTimingFunction/.test(line))
        warnings.push(`${at}: CSS transitions/animations are not rendered frame-accurately. Use interpolate()/spring().`);
      if (/<(img|video|audio)\b/.test(line))
        warnings.push(`${at}: use <Img>, <OffthreadVideo>/<Html5Video>, <Html5Audio> from remotion instead of raw HTML media tags.`);
      if (/useState\(|useEffect\(/.test(line) && !/delayRender/.test(src))
        warnings.push(`${at}: state/effects usually break frame determinism. Compute from the frame instead.`);
    });
  }
  return {ok: errors.length === 0, errors, warnings: warnings.slice(0, 30)};
};

const fmt = (m: esbuild.Message, dir: string) => {
  const loc = m.location ? `${path.relative(dir, m.location.file).replace(/\\/g, '/')}:${m.location.line}:${m.location.column}: ` : '';
  const line = m.location?.lineText ? `\n    ${m.location.lineText.trim()}` : '';
  return `${loc}${m.text}${line}`;
};
