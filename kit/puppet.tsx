/**
 * <Puppet>: a character cut into layers by the rig_character tool, with each part animated around its joint
 * (wings flap, tail wags, head nods, arm waves). The whole puppet also accepts every <AnimatedAsset> motion
 * prop (enter, idle, keyframes, talk, exit...), so it can walk around the frame while its parts move.
 */
import React from 'react';
import {Img, useCurrentFrame, useVideoConfig} from 'remotion';
import {resolveAsset, speakingAmount, useAssetMotion, type AssetMotionProps} from './asset';

export type PartMotion = 'flap' | 'wag' | 'nod' | 'wave' | 'sway' | 'none';

export type RigPart = {
  name: string;
  src: string;
  /** Joint in image pixels (where the part attaches to the body). */
  pivot: [number, number];
  box: [number, number, number, number];
  /** Drawn behind or in front of the body. */
  z: 'back' | 'front';
  motion: PartMotion | string;
};

export type Rig = {width: number; height: number; body: string; parts: RigPart[]};

export type PartOverride = {motion?: PartMotion; amount?: number; speed?: number; z?: 'back' | 'front'} | 'none';

export type PuppetProps = AssetMotionProps & {
  rig: Rig;
  width: number;
  /** Per-part tweaks by part name, e.g. {"tail": {amount: 1.5}, "head": "none"}. */
  parts?: Record<string, PartOverride>;
  /** Global speed for part motions (1 = default). */
  partSpeed?: number;
  shadow?: boolean;
  style?: React.CSSProperties;
};

const DEG: Record<string, {deg: number; hz: number}> = {
  flap: {deg: 20, hz: 1.7},
  wag: {deg: 12, hz: 2.2},
  nod: {deg: 3.5, hz: 0.5},
  wave: {deg: 16, hz: 1.4},
  sway: {deg: 5, hz: 0.6},
};

export const Puppet: React.FC<PuppetProps> = ({rig, width, parts: overrides, partSpeed = 1, shadow, style, talk, ...motion}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const hasHead = rig.parts.some((p) => p.motion === 'nod');
  // With a head layer, the head does the talking; otherwise the whole puppet nods.
  const m = useAssetMotion({...motion, talk: hasHead ? undefined : talk});
  const t = Math.max(0, frame - (motion.delay ?? 0)) / fps;
  const height = (width * rig.height) / rig.width;
  const speaking = talk ? speakingAmount(talk, t) : 0;

  const layer = (p: RigPart, i: number) => {
    const o = overrides?.[p.name];
    if (o === 'none') return <Img key={p.name} src={resolveAsset(p.src)} style={full} />;
    const kind = (o?.motion ?? p.motion) as PartMotion;
    const cfg = DEG[kind];
    let rotate = 0;
    let scaleX = 1;
    if (cfg) {
      const amt = cfg.deg * (o?.amount ?? 1);
      const hz = cfg.hz * (o?.speed ?? 1) * partSpeed;
      // Which side of the joint the part extends to: left parts rotate the other way so pairs move together.
      const side = (p.box[0] + p.box[2]) / 2 < p.pivot[0] ? -1 : 1;
      const phase = kind === 'flap' ? 0 : i * 0.7;
      const w = Math.sin(t * Math.PI * 2 * hz + phase);
      if (kind === 'flap') {
        rotate = -side * amt * w;
        // Perspective fold: the wing looks narrower on the downstroke.
        scaleX = 1 - 0.14 * ((1 - w) / 2);
      } else if (kind === 'wave') {
        rotate = -side * amt * w;
      } else if (kind === 'nod') {
        rotate = amt * w + speaking * 6 * Math.sin(t * Math.PI * 2 * 2.3);
      } else {
        rotate = amt * w;
      }
    }
    const ox = (p.pivot[0] / rig.width) * 100;
    const oy = (p.pivot[1] / rig.height) * 100;
    return (
      <Img
        key={p.name}
        src={resolveAsset(p.src)}
        style={{...full, transformOrigin: `${ox}% ${oy}%`, transform: `rotate(${rotate}deg) scaleX(${scaleX})`}}
      />
    );
  };

  const zOf = (p: RigPart) => {
    const o = overrides?.[p.name];
    return o && o !== 'none' && o.z ? o.z : p.z;
  };
  const back = rig.parts.filter((p) => zOf(p) === 'back');
  const front = rig.parts.filter((p) => zOf(p) !== 'back');

  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        opacity: m.opacity,
        transform: m.transform,
        transformOrigin: '50% 90%',
        filter: shadow ? 'drop-shadow(0 18px 24px rgba(0,0,0,0.35))' : undefined,
        ...style,
      }}
    >
      {back.map((p) => layer(p, rig.parts.indexOf(p)))}
      <Img src={resolveAsset(rig.body)} style={full} />
      {front.map((p) => layer(p, rig.parts.indexOf(p)))}
    </div>
  );
};

const full: React.CSSProperties = {position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain'};
