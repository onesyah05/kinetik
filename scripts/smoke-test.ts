/** Smoke test of the agent tools without an LLM: tts → write scene → check → snapshot → render. */
import {runTool} from '../server/agent/tools';
import {createProject, deleteProject} from '../server/projects';

const id = process.argv[2] ?? createProject({name: 'smoke test', width: 1080, height: 1920, fps: 30, seconds: 5}).id;
const ctx = {projectId: id, signal: new AbortController().signal};
const step = async (name: string, args: unknown) => {
  const t = Date.now();
  const r = await runTool(name, JSON.stringify(args), ctx);
  console.log(`\n[${name}] ${r.error ? 'ERROR' : 'ok'} ${Date.now() - t}ms\n${r.content.slice(0, 600)}`);
  if (r.error) process.exitCode = 1;
  return r;
};

const SCENE = `import React from 'react';
import {AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {loadFont} from '@remotion/google-fonts/Montserrat';
import {Rocket} from 'lucide-react';
import {Narration, trackFrames} from '@kit';
import intro from './voiceover/intro';

const {fontFamily} = loadFont('normal', {weights: ['800'], subsets: ['latin']});

const Title: React.FC<{text: string; color: string}> = ({text, color}) => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const s = spring({frame, fps, config: {damping: 200}});
  return (
    <AbsoluteFill style={{background: color, justifyContent: 'center', alignItems: 'center', gap: 40}}>
      <Rocket size={width * 0.2} color="#fff" style={{transform: \`translateY(\${(1 - s) * 80}px)\`}} />
      <div style={{fontFamily, color: '#fff', fontSize: width * 0.1, opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'})}}>{text}</div>
    </AbsoluteFill>
  );
};

export const Video: React.FC = () => {
  const {fps} = useVideoConfig();
  const len = trackFrames(intro, fps, 0.5);
  return (
    <AbsoluteFill>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={Math.ceil(len / 2) + 10}>
          <Title text="Kinetik" color="#16181d" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: 10})} />
        <TransitionSeries.Sequence durationInFrames={Math.ceil(len / 2)}>
          <Title text="Local render" color="#ff6a3d" />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Sequence>
        <Narration track={intro} />
      </Sequence>
    </AbsoluteFill>
  );
};
`;

const main = async () => {
  console.log('project', id);
  const tts = await step('tts', {name: 'intro', text: 'Halo! Ini adalah video pertama yang dibuat oleh Kinetik di laptop kamu.', voice: 'id-ID-GadisNeural'});
  const dur = JSON.parse(tts.content).durationInSeconds;
  await step('write_file', {path: 'src/Video.tsx', content: SCENE});
  await step('update_project', {durationInSeconds: Math.ceil((dur + 0.5) * 10) / 10});
  await step('check_code', {});
  await step('snapshot', {seconds: [0.5, 2, 4]});
  await step('edit_file', {path: 'src/Video.tsx', old_string: '"Kinetik"', new_string: '"Kinetik!"'});
  await step('write_file', {path: 'src/Root.tsx', content: 'x'});
  await step('snapshot', {frames: [45]});
  if (process.argv.includes('--render')) await step('render_video', {quality: 'draft'});
  if (process.argv.includes('--cleanup')) deleteProject(id);
  process.exit();
};
main();
