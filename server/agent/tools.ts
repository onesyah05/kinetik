import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  activeVideoId,
  assertWritable,
  createVideos,
  deleteFile,
  getProject,
  listAssets,
  listSourceFiles,
  projectDir,
  readFile,
  switchVideo,
  updateProject,
  videoDirRel,
  videoEntryRel,
  videosOf,
  writeFile,
} from '../projects';
import {safeJoin} from '../paths';
import {checkProject, compileEntry} from '../check';
import {renderSnapshots, startRender, waitForJob} from '../render';
import {listVoices, synthesize} from '../tts';
import {createVectorAsset, downloadAsset, generateImage, searchStock} from '../media';
import {rigCharacter} from '../rig';
import {generateSprite} from '../sprites';

/** A style choice: either live code (`file`) or an AI-generated still (`image`, a path inside public/). */
export type StyleOption = {id: string; name: string; description: string; file?: string; image?: string; voice?: string};
export type AskQuestion = {
  id: string;
  question: string;
  multiSelect?: boolean;
  options: {id: string; label: string; description?: string; recommended?: boolean}[];
};
export type ToolResult = {
  content: string;
  images?: string[];
  display?: string;
  /** Style samples shown as a picker in the chat. */
  styles?: StyleOption[];
  /** Questions shown as clickable choices in the chat. */
  questions?: AskQuestion[];
  /** Stop the agent loop after this tool so the user can answer. */
  endTurn?: boolean;
};
type Ctx = {projectId: string; signal: AbortSignal};

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any, ctx: Ctx) => Promise<ToolResult>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const str = (description: string) => ({type: 'string', description});
const num = (description: string) => ({type: 'number', description});

const json = (v: unknown): ToolResult => ({content: JSON.stringify(v, null, 1)});

const MAX_READ = 60_000;

export const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description: 'List source files and public assets of the project.',
    parameters: obj({}),
    run: async (_a, {projectId}) =>
      json({source: listSourceFiles(projectId).map((f) => f.path), assets: listAssets(projectId).map((a) => `${a.path} (${a.kind})`)}),
  },
  {
    name: 'read_file',
    description: 'Read a project file (e.g. src/Video.tsx).',
    parameters: obj({path: str('Project-relative path, e.g. src/Video.tsx')}, ['path']),
    run: async ({path: p}, {projectId}) => {
      const c = readFile(projectId, p);
      return {content: c.length > MAX_READ ? c.slice(0, MAX_READ) + '\n…(truncated)' : c, display: `${c.split('\n').length} lines`};
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file under src/ (code) or public/ (text assets like .json/.svg). Always write the complete file content.',
    parameters: obj({path: str('Project-relative path, e.g. src/scenes/Intro.tsx'), content: str('Full file content')}, ['path', 'content']),
    run: async ({path: p, content}, {projectId}) => {
      const r = writeFile(projectId, p, content);
      return {content: `Wrote ${r} (${content.split('\n').length} lines).`};
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact snippet in a file. old_string must match the current file exactly (including whitespace) and be unique unless replace_all is true.',
    parameters: obj(
      {
        path: str('Project-relative path'),
        old_string: str('Exact text to replace'),
        new_string: str('Replacement text'),
        replace_all: {type: 'boolean', description: 'Replace every occurrence'},
      },
      ['path', 'old_string', 'new_string'],
    ),
    run: async ({path: p, old_string, new_string, replace_all}, {projectId}) => {
      assertWritable(p);
      const cur = readFile(projectId, p);
      const count = cur.split(old_string).length - 1;
      if (!old_string || count === 0) throw new Error('old_string not found. Read the file again and copy the snippet exactly.');
      if (count > 1 && !replace_all) throw new Error(`old_string occurs ${count} times. Add more context or set replace_all.`);
      const next = replace_all ? cur.split(old_string).join(new_string) : cur.replace(old_string, () => new_string);
      writeFile(projectId, p, next);
      return {content: `Edited ${p} (${count} replacement${count > 1 ? 's' : ''}).`};
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file under src/ or public/.',
    parameters: obj({path: str('Project-relative path')}, ['path']),
    run: async ({path: p}, {projectId}) => ({content: `Deleted ${deleteFile(projectId, p)}.`}),
  },
  {
    name: 'update_project',
    description:
      'Change project settings: name, width, height, fps, duration (durationInFrames or durationInSeconds) and caption settings. Returns the new settings.',
    parameters: obj({
      name: str('Project name'),
      width: num('Width in px (even)'),
      height: num('Height in px (even)'),
      fps: num('Frames per second (24/25/30/60)'),
      durationInFrames: num('Total length in frames'),
      durationInSeconds: num('Total length in seconds (alternative to durationInFrames)'),
      captions: obj({
        enabled: {type: 'boolean'},
        style: {type: 'string', enum: ['tiktok', 'classic', 'karaoke']},
        position: {type: 'string', enum: ['bottom', 'center', 'top']},
        fontSize: num('px, 0 = auto'),
        color: str('CSS color'),
        highlightColor: str('CSS color'),
        fontFamily: str('CSS font-family'),
        wordsPerPage: num('Words shown at once'),
        uppercase: {type: 'boolean'},
      }),
    }),
    run: async (a, {projectId}) => {
      const cur = getProject(projectId);
      const patch: any = {};
      for (const k of ['name', 'width', 'height', 'fps', 'durationInFrames'] as const) if (a[k] !== undefined) patch[k] = a[k];
      if (a.durationInSeconds !== undefined) patch.durationInFrames = Math.round(a.durationInSeconds * (a.fps ?? cur.fps));
      if (a.captions) patch.captions = a.captions;
      const p = updateProject(projectId, patch);
      const {createdAt, updatedAt, ...rest} = p;
      return json(rest);
    },
  },
  {
    name: 'create_video',
    description:
      'Add one or more new videos to THIS project. They share its size, captions, src/lib code and public/ assets, so they keep the same style. Each gets its own folder src/videos/<id>/ with a starter Video.tsx. Use when the user wants another video, or gives several themes (one video per theme). Does not switch; call switch_video before building each one.',
    parameters: obj(
      {
        videos: {
          type: 'array',
          description: 'One entry per video',
          items: obj({name: str('Short title in the user language'), theme: str('What this video is about')}, ['name']),
        },
      },
      ['videos'],
    ),
    run: async ({videos}, {projectId}) => {
      const list = ((videos ?? []) as {name: string; theme?: string}[]).filter((v) => v?.name || v?.theme);
      if (!list.length) throw new Error('Give at least one video.');
      const {created} = createVideos(projectId, list.slice(0, 20));
      return {
        content: `Created ${created.length} video(s):\n${created.map((v) => `- ${v.id}: "${v.name}" → ${videoEntryRel(v.id)}`).join('\n')}\nBuild them one at a time: switch_video, then write scenes in that video's folder, reusing src/lib and public/ assets.`,
        display: created.map((v) => v.name).join(' · '),
      };
    },
  },
  {
    name: 'switch_video',
    description:
      "Make another video of this project the active one. Preview, check_code, snapshot, update_project's duration and render_video then work on it.",
    parameters: obj({id: str('Video id from the project info or create_video')}, ['id']),
    run: async ({id}, {projectId}) => {
      const p = switchVideo(projectId, String(id));
      const v = videosOf(p).find((x) => x.id === activeVideoId(p))!;
      return {
        content: `Active video: ${v.id} "${v.name}"${v.theme ? ` (theme: ${v.theme})` : ''}. Entry: ${videoEntryRel(v.id)}; put its scenes in ${videoDirRel(v.id)}/scenes/. Duration ${(v.durationInFrames / p.fps).toFixed(1)}s.`,
        display: v.name,
      };
    },
  },
  {
    name: 'check_code',
    description: 'Compile-check the project (syntax, imports, missing exports) and lint for common Remotion mistakes. Run after writing code.',
    parameters: obj({}),
    run: async (_a, {projectId}) => {
      const r = await checkProject(projectId);
      const text = r.ok
        ? `OK: compiles.${r.warnings.length ? `\nWarnings:\n- ${r.warnings.join('\n- ')}` : ''}`
        : `ERRORS:\n- ${r.errors.join('\n- ')}${r.warnings.length ? `\nWarnings:\n- ${r.warnings.join('\n- ')}` : ''}`;
      return {content: text, display: r.ok ? `ok${r.warnings.length ? `, ${r.warnings.length} warnings` : ''}` : `${r.errors.length} errors`};
    },
  },
  {
    name: 'snapshot',
    description:
      'Render still frames of the current video with the real renderer and attach them as images so you can visually check the result. Also reports runtime errors and console errors. Pass frames or seconds (max 8). Default: 4 evenly spaced frames.',
    parameters: obj({
      frames: {type: 'array', items: {type: 'number'}, description: 'Frame numbers to render'},
      seconds: {type: 'array', items: {type: 'number'}, description: 'Timestamps in seconds (alternative to frames)'},
    }),
    run: async (a, {projectId}) => {
      const p = getProject(projectId);
      let frames: number[] = a.frames ?? [];
      if (!frames.length && a.seconds?.length) frames = a.seconds.map((s: number) => Math.round(s * p.fps));
      if (!frames.length) {
        const d = p.durationInFrames;
        frames = [0.12, 0.38, 0.62, 0.88].map((x) => Math.floor(d * x));
      }
      const r = await renderSnapshots(projectId, frames);
      const names = r.files.map((f) => f.match(/-f(\d+)\.jpg$/)?.[1]).map((f) => `frame ${f} (${(Number(f) / p.fps).toFixed(2)}s)`);
      return {
        content: `Rendered ${r.files.length} snapshots at ${r.width}x${r.height}: ${names.join(', ')}.${
          r.logs.length ? `\nBrowser console:\n${r.logs.join('\n')}` : '\nNo console errors.'
        }`,
        images: r.files,
        display: names.join(', '),
      };
    },
  },
  {
    name: 'view_image',
    description: 'Look at an image asset from public/ (e.g. an uploaded logo) to understand its content, colors and aspect ratio.',
    parameters: obj({path: str('Path inside public/, e.g. images/logo.png')}, ['path']),
    run: async ({path: p}, {projectId}) => {
      const rel = `public/${String(p).replace(/^\/?(public\/)?/, '')}`;
      const abs = safeJoin(projectDir(projectId), rel);
      if (!fs.existsSync(abs)) throw new Error(`Not found: ${rel}`);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(abs)) throw new Error('Only png/jpg/webp/gif can be viewed.');
      return {content: `Attached ${rel}.`, images: [rel]};
    },
  },
  {
    name: 'tts',
    description:
      'Generate a directed voiceover. Split the script into `segments` (one phrase each) and direct each one like a voice director: `style` (natural-language delivery, used by the Gemini engine) plus rate/pitch/volume (used by the Edge engine) and a pause after it. Give `direction` for the overall performance. Creates public/voiceover/<name>.mp3 and src/voiceover/<name>.ts (default export VoiceTrack with word timings for captions). Returns duration in seconds.',
    parameters: obj(
      {
        name: str('Short id, e.g. scene1'),
        voice: str('Voice name for the active engine (see the Voiceover section of the system prompt). Omit to use the default.'),
        direction: str(
          'Overall performance note in the user language, e.g. "food vlogger Jakarta yang antusias, santai, senyum saat bicara" or "narator dokumenter yang tenang dan hangat"',
        ),
        segments: {
          type: 'array',
          description: 'Phrases in order, each spoken with its own delivery',
          items: obj(
            {
              text: str('One sentence or phrase, exactly as it should be spoken'),
              style: str('How to say it, e.g. "penasaran, nada naik di akhir", "berbisik penuh rahasia", "tegas dan bangga", "tertawa kecil"'),
              rate: str('Speed, e.g. "+8%" for energy, "-10%" for weight. Default +0%'),
              pitch: str('Pitch, e.g. "+12Hz" to lift a hook or question, "-4Hz" for calm authority. Default +0Hz'),
              volume: str('Loudness, e.g. "+10%" for emphasis. Default +0%'),
              pause: num('Silence after this phrase in seconds, e.g. 0.3 between ideas, 0.6 before a reveal'),
            },
            ['text'],
          ),
        },
        text: str('Plain text, only if you do not use segments (sounds flatter)'),
      },
      ['name'],
    ),
    run: async (a, {projectId}) => json(await synthesize(projectId, a)),
  },
  {
    name: 'list_voices',
    description: 'List Edge TTS voices for a locale prefix (e.g. "id", "en-US", "ja"). Multilingual voices are always included.',
    parameters: obj({locale: str('Locale prefix')}, ['locale']),
    run: async ({locale}) => {
      const v = await listVoices(locale);
      return {
        content:
          v.map((x) => `${x.name} (${x.gender}${x.personality ? `, ${x.personality}` : ''}${x.multilingual ? ', multilingual' : ''})`).join('\n') ||
          'No voices found.',
      };
    },
  },
  {
    name: 'present_styles',
    description:
      'Show the user 2-4 contrasting styles and wait for them to pick one. Each option is EITHER an AI style frame (`image_prompt`: a full-frame still of the opening shot, generated for you in parallel into public/styles/<id>.png, ~30 s total) OR live code (`file`: a file under src/styles/ exporting `export const Sample: React.FC`, a ~3 s looping sample at the project size). Use one kind for all options. This ends your turn.',
    parameters: obj(
      {
        options: {
          type: 'array',
          description: '2 to 4 clearly different styles',
          items: obj(
            {
              id: str('Short id, e.g. "a"'),
              name: str('Short style name in the user language, e.g. "Sinematik gelap"'),
              description: str('One line: look, motion, typography and voice tone, in the user language'),
              image_prompt: str(
                'For an AI style frame: detailed English prompt for one full-frame still of the opening shot of THIS video: subject and scene, the real title text in quotes, art style/medium, palette with hex codes, typography, layout, lighting and mood',
              ),
              file: str('For a live code sample: path of the sample, e.g. src/styles/Cinematic.tsx'),
              voice: str('Voice you would use for this style'),
            },
            ['id', 'name', 'description'],
          ),
        },
      },
      ['options'],
    ),
    run: async ({options}, {projectId}) => {
      const list = ((options ?? []) as Array<StyleOption & {image_prompt?: string}>).map((o) => ({
        ...o,
        id: String(o.id).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || Math.random().toString(36).slice(2, 6),
      }));
      if (list.length < 2) throw new Error('Give at least 2 options.');

      if (list.some((o) => o.image_prompt)) {
        if (list.some((o) => !o.image_prompt)) throw new Error('Give every option an image_prompt (or use `file` for all of them).');
        const p = getProject(projectId);
        const size = p.width > p.height * 1.2 ? '1536x1024' : p.height > p.width * 1.2 ? '1024x1536' : '1024x1024';
        const orientation = p.width > p.height ? 'landscape' : p.height > p.width ? 'portrait' : 'square';
        // All frames at once: each takes ~20-30 s on the image model.
        const results = await Promise.allSettled(
          list.map((o) =>
            generateImage(projectId, {
              prompt: `Style frame for a ${orientation} ${p.width}x${p.height} video: the opening shot, filling the whole frame edge to edge.\n\n${o.image_prompt}`,
              filename: `styles/${o.id}.png`,
              size,
              transparent: false,
            }),
          ),
        );
        const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${list[i].id}: ${r.reason?.message ?? r.reason}`] : []));
        if (failed.length === list.length) throw new Error(`Image generation failed, use live code samples (file) instead:\n- ${failed.join('\n- ')}`);
        const shown: StyleOption[] = list.flatMap((o, i) => {
          const r = results[i];
          return r.status === 'fulfilled' ? [{id: o.id, name: o.name, description: o.description, voice: o.voice, image: r.value.path}] : [];
        });
        return {
          content: `Showing ${shown.length} AI style frames to the user${failed.length ? ` (${failed.length} failed: ${failed.join('; ')})` : ''}. Stop now and wait for their choice; the chosen frame will be attached to their reply.`,
          display: shown.map((o) => o.name).join(' · '),
          styles: shown,
          endTurn: true,
        };
      }

      const problems: string[] = [];
      for (const o of list) {
        if (!o.file) {
          problems.push(`${o.id}: needs \`file\` or \`image_prompt\``);
          continue;
        }
        const file = o.file;
        const src = (() => {
          try {
            return readFile(projectId, file);
          } catch {
            return null;
          }
        })();
        if (src === null) {
          problems.push(`${file}: file not found`);
          continue;
        }
        if (!/export\s+(const|function)\s+Sample\b/.test(src)) problems.push(`${file}: must export \`Sample\``);
        const r = await compileEntry(projectId, file);
        problems.push(...r.errors.map((e) => `${file}: ${e}`));
      }
      if (problems.length) throw new Error(`Fix these before presenting:\n- ${problems.join('\n- ')}`);
      return {
        content: `Showing ${list.length} style samples to the user. Stop now and wait for their choice; then build the full video in that style.`,
        display: list.map((o) => o.name).join(' · '),
        styles: list,
        endTurn: true,
      };
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user 1-3 questions as clickable choices in the chat (checkboxes when multiSelect, otherwise single choice; the user can also type something else). Use it to offer asset menus or decisions you cannot make yourself. This ends your turn; the answer arrives as the next user message.',
    parameters: obj(
      {
        questions: {
          type: 'array',
          items: obj(
            {
              id: str('Short id'),
              question: str('The question, in the user language'),
              multiSelect: {type: 'boolean', description: 'Allow several answers'},
              options: {
                type: 'array',
                description: '2 to 8 options',
                items: obj(
                  {
                    id: str('Short id'),
                    label: str('Short label in the user language'),
                    description: str('One line explaining it'),
                    recommended: {type: 'boolean', description: 'Pre-select this option'},
                  },
                  ['id', 'label'],
                ),
              },
            },
            ['id', 'question', 'options'],
          ),
        },
      },
      ['questions'],
    ),
    run: async ({questions}) => {
      const qs = (questions ?? []) as AskQuestion[];
      if (!qs.length || qs.some((q) => (q.options?.length ?? 0) < 2)) throw new Error('Each question needs at least 2 options.');
      return {
        content: 'Questions shown to the user. Stop now and wait for the answer.',
        display: qs.map((q) => q.question).join(' · '),
        questions: qs,
        endTurn: true,
      };
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate a PNG with the AI image model and save it into public/. With transparent=true (default) the background is removed automatically, for avatars, characters, icons, objects and stickers you will animate. Use transparent=false for full-frame backgrounds. Takes ~30 s per image; the result is attached so you can check it.',
    parameters: obj(
      {
        prompt: str(
          'Detailed prompt: subject, pose/expression, art style shared by all assets of this video (palette, line weight, shading), framing',
        ),
        filename: str('Destination inside public/, e.g. assets/avatar.png'),
        size: str('1024x1024 (default), 1536x1024 landscape, 1024x1536 portrait'),
        transparent: {type: 'boolean', description: 'Remove the background (default true)'},
        reference: str(
          'Optional existing asset in public/ (e.g. assets/host-wave.png) to keep the same character for a new pose or expression',
        ),
      },
      ['prompt', 'filename'],
    ),
    run: async (a, {projectId}) => {
      const r = await generateImage(projectId, a);
      return {
        content: `Saved public/${r.path}${r.note ? ` (${r.note})` : ''}. Use staticFile('${r.path}'), e.g. <AnimatedAsset src="${r.path}" />.`,
        images: [`public/${r.path}`],
        display: r.note || undefined,
      };
    },
  },
  {
    name: 'generate_sprite',
    description:
      'Frame-by-frame animation of a character (a real drawn cycle: wings flapping, walking, jumping, cheering, cooking...). The image model draws all frames in one sprite sheet so the character stays consistent, then the frames are cut and aligned. Takes ~60-90 s. Creates public/sprites/<name>/*.png and src/sprites/<name>.ts (default export SpriteData); play it with <Sprite sprite={...} width={600} /> from @kit. A preview strip of the frames is attached.',
    parameters: obj(
      {
        name: str('Short id, e.g. wolf-flap'),
        action: str('What moves during the cycle, in English, e.g. "flaps its wings up and down while the body stays still"'),
        reference: str('Existing character image in public/ to copy, e.g. assets/wolf-wave.png'),
        description: str('Character description, only when there is no reference'),
        frames: num('Number of frames, 4-12 (default 6). 6-8 is smooth for most cycles'),
        poses: {type: 'array', items: {type: 'string'}, description: 'Optional pose note per frame, in order'},
        fps: num('Drawing speed in frames per second (default 10; 8-12 looks hand-drawn)'),
        mode: {type: 'string', enum: ['loop', 'pingpong', 'once']},
      },
      ['name', 'action'],
    ),
    run: async (a, {projectId}) => {
      const r = await generateSprite(projectId, a);
      return {
        content: `Made ${r.frames} frames (${r.sprite.width}x${r.sprite.height}, ${r.sprite.fps} fps, ${r.sprite.mode}). Import with \`import ${a.name.replace(/\W+/g, '')}Sprite from '${r.importPath}';\` (relative to the importing file) and render <Sprite sprite={...} width={600} enter="pop" keyframes={[...]} />. Check the attached strip: the character must look the same in every frame.`,
        images: [r.preview],
        display: `${r.frames} frames · ${r.sprite.fps} fps`,
      };
    },
  },
  {
    name: 'rig_character',
    description:
      'Cut a character image into puppet layers so its parts move on their own: wings flap, tail wags, head nods (and talks), arms wave. Uses automatic segmentation (~10 s). Creates public/rigs/<name>/*.png and src/rigs/<name>.ts (default export Rig). Use it with <Puppet rig={...} /> from @kit. A debug image with the joints marked is attached so you can check the cut.',
    parameters: obj(
      {
        src: str('Image asset inside public/, e.g. assets/host-wave.png'),
        name: str('Short id for the rig, e.g. host-wave'),
        parts: {
          type: 'array',
          items: {type: 'string'},
          description:
            'Parts to animate, in plain English, e.g. ["left wing", "right wing", "tail", "head"]. Only parts that are clearly visible and separate. Left/right = side of the image.',
        },
      },
      ['src', 'name', 'parts'],
    ),
    run: async (a, {projectId}) => {
      const r = await rigCharacter(projectId, a);
      const list = r.rig.parts.map((p: any) => `${p.name} (${p.motion}, ${p.z}, joint ${p.pivot.map(Math.round).join(',')})`).join('; ');
      return {
        content: `Rigged ${a.src}: ${list}.${r.missing.length ? ` Not found: ${r.missing.join(', ')}.` : ''} Import with \`import ${a.name.replace(/\W+/g, '')}Rig from '${r.importPath}';\` (relative to the importing file) and render <Puppet rig={...} width={600} idle="breathe" talk={track} />.`,
        images: r.debug ? [r.debug] : undefined,
        display: `${r.rig.parts.map((p: any) => `${p.name}: ${p.motion}`).join(' · ')} (${r.method})`,
      };
    },
  },
  {
    name: 'create_vector_asset',
    description:
      'Draw an asset yourself as SVG (icons, simple avatars, badges, shapes, diagrams). Free and instant. Saves public/<name>.svg and a transparent public/<name>.png and attaches the PNG so you can check it. For assets whose parts must move separately (blinking eyes, waving arm), write a React component in src/assets/ instead.',
    parameters: obj(
      {
        filename: str('Destination inside public/ without extension, e.g. assets/icon-camera'),
        svg: str('Complete <svg> document with viewBox, flat shapes, no external references or fonts'),
        width: num('PNG width in px (default 1024)'),
      },
      ['filename', 'svg'],
    ),
    run: async (a, {projectId}) => {
      const r = await createVectorAsset(projectId, a);
      return {content: `Saved public/${r.svg} and public/${r.png}. Use staticFile('${r.png}') or the SVG.`, images: [`public/${r.png}`]};
    },
  },
  {
    name: 'search_stock',
    description: 'Search free stock photos/videos (Pexels, Unsplash). Returns candidates with download URLs; then call download_asset.',
    parameters: obj(
      {
        query: str('Search terms in English'),
        type: {type: 'string', enum: ['photo', 'video']},
        orientation: {type: 'string', enum: ['landscape', 'portrait', 'square']},
        count: num('Results (max 15)'),
      },
      ['query'],
    ),
    run: async (a) => {
      const r = await searchStock(a);
      return json({
        results: r.results.map(({preview, ...x}) => x),
        errors: r.errors.length ? r.errors : undefined,
      });
    },
  },
  {
    name: 'download_asset',
    description: 'Download a file from a URL into public/ (stock media, fonts, icons, etc.).',
    parameters: obj({url: str('http(s) URL'), filename: str('Destination inside public/, e.g. stock/city.jpg')}, ['url', 'filename']),
    run: async ({url, filename}, {projectId}) => {
      const r = await downloadAsset(projectId, url, filename);
      const isImg = /\.(png|jpe?g|webp)$/i.test(r.path);
      return {
        content: `Saved public/${r.path} (${Math.round(r.bytes / 1024)} KB). Use staticFile('${r.path}').`,
        images: isImg ? [`public/${r.path}`] : undefined,
      };
    },
  },
  {
    name: 'render_video',
    description:
      'Render the final MP4 locally. Only call this when the user explicitly asks for the final render. By default it renders the current video; pass videos: ["all"] for every video of the project, or a list of video ids. Each video becomes its own MP4.',
    parameters: obj({
      quality: {type: 'string', enum: ['draft', 'standard', 'high']},
      videos: {type: 'array', items: {type: 'string'}, description: 'Video ids to render, or ["all"]. Default: the current video.'},
    }),
    run: async ({quality, videos}, {projectId, signal}) => {
      const pick = Array.isArray(videos) && videos.length ? (videos.includes('all') ? 'all' : videos.map(String)) : undefined;
      const job = startRender(projectId, quality, pick);
      const done = await waitForJob(job.jobId, signal);
      const made = (done.files ?? []).map((f) => `renders/${f}`).join(', ');
      if (done.status !== 'done') throw new Error(`Render ${done.status}: ${done.error ?? ''}${made ? ` (finished before that: ${made})` : ''}`);
      const secs = ((done.finishedAt! - done.startedAt) / 1000).toFixed(1);
      return {content: `Rendered ${made} in ${secs}s.`};
    },
  },
];

export const toolSchemas = () =>
  TOOLS.map((t) => ({type: 'function' as const, function: {name: t.name, description: t.description, parameters: t.parameters}}));

export const runTool = async (name: string, rawArgs: string, ctx: Ctx): Promise<ToolResult & {error?: boolean}> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return {content: `Unknown tool: ${name}`, error: true};
  let args: any = {};
  try {
    args = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return {content: `Invalid JSON arguments for ${name}. Send valid JSON.`, error: true};
  }
  const required = ((tool.parameters as {required?: string[]}).required ?? []).filter((k) => args?.[k] === undefined || args[k] === null);
  if (required.length) {
    const msg = `Missing required argument${required.length > 1 ? 's' : ''}: ${required.join(', ')}. Call ${name} again with all of them.`;
    return {content: `Error: ${msg}`, error: true, display: msg};
  }
  try {
    return await tool.run(args, ctx);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return {content: `Error: ${msg.slice(0, 4000)}`, error: true, display: msg.split('\n')[0].slice(0, 160)};
  }
};

export const imageToDataUrl = (projectId: string, rel: string) => {
  let abs = safeJoin(projectDir(projectId), rel);
  // Large images are downscaled before being sent to the model to save tokens and bandwidth.
  if (fs.statSync(abs).size > 400_000) {
    const dir = path.join(projectDir(projectId), '.snapshots');
    fs.mkdirSync(dir, {recursive: true});
    const thumb = path.join(dir, `view-${createHash('sha1').update(abs + fs.statSync(abs).mtimeMs).digest('hex').slice(0, 12)}.jpg`);
    if (!fs.existsSync(thumb)) {
      spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', abs, '-vf', "scale='min(1024,iw)':-2", '-frames:v', '1', '-q:v', '4', thumb], {windowsHide: true});
    }
    if (fs.existsSync(thumb)) abs = thumb;
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
};
