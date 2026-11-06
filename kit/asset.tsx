/**
 * <AnimatedAsset>: put a PNG/SVG asset on screen with an entrance, smooth looping idle motion,
 * movement between positions (keyframes), an optional exit, and a gentle "talking" bounce synced to a voiceover.
 * All motion is a smooth function of the frame (no hard corners, no on/off jumps), so it never jitters.
 */
import React from 'react';
import {Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {VoiceTrack} from './settings';

export type AssetEnter = 'pop' | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'zoom' | 'drop' | 'spin' | 'none';
export type AssetIdle = 'float' | 'bob' | 'hop' | 'sway' | 'pulse' | 'breathe' | 'spin' | 'wiggle' | 'none';
export type AssetExit = 'fade' | 'shrink' | 'slide-down' | 'slide-up' | 'slide-left' | 'slide-right';

/** A pose at a frame (relative to this component). x/y in px from the resting position, scale 1 = normal, rotate in deg. */
export type AssetKeyframe = {at: number; x?: number; y?: number; scale?: number; rotate?: number};

export type AnimatedAssetProps = {
  /** Path inside public/ (e.g. "assets/avatar.png") or a full URL. */
  src: string;
  width?: number | string;
  height?: number | string;
  /** How it appears. Default "pop". */
  enter?: AssetEnter;
  /** Continuous motion after it appears. Default "float". */
  idle?: AssetIdle;
  /** Frame (relative to this component) when it starts entering. */
  delay?: number;
  /** Entrance length in frames. Default 18. */
  enterDuration?: number;
  /** Move around: smooth eased travel between poses, e.g. walk the host from left to right during a scene. */
  keyframes?: AssetKeyframe[];
  /** Hop (small jump) while travelling between keyframes, like walking. Default true for keyframes. */
  hopWhileMoving?: boolean;
  /** Mirror automatically so it faces the direction it moves. */
  faceMovement?: boolean;
  /** Frame (relative) when it starts leaving; omit to stay. */
  exitAt?: number;
  exit?: AssetExit;
  /** Scales every motion, 0 = still, 1 = default, 2 = lively. */
  intensity?: number;
  /** Bounce gently while this voiceover speaks (mount in the same <Sequence> as its <Narration>). */
  talk?: VoiceTrack;
  /** Mirror horizontally. */
  flip?: boolean;
  /** Soft drop shadow under the asset. */
  shadow?: boolean;
  style?: React.CSSProperties;
};

const resolve = (src: string) => (/^(https?:|data:|\/)/.test(src) ? src : staticFile(src));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Smooth 0→1 step (no sudden start or stop). */
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
/** Smooth 0..1..0 wave with a given frequency (Hz): 0 at t=0, never has sharp corners. */
const wave01 = (t: number, hz: number) => (1 - Math.cos(t * Math.PI * 2 * hz)) / 2;

/** 0..1 how much the voice is speaking at time t, with soft attack/release so the bounce eases in and out. */
export const speakingAmount = (track: VoiceTrack, t: number) => {
  let a = 0;
  for (const w of track.words) {
    if (t < w.start - 0.25 || t > w.end + 0.35) continue;
    const inA = smooth((t - (w.start - 0.12)) / 0.12);
    const outA = 1 - smooth((t - (w.end + 0.05)) / 0.25);
    a = Math.max(a, Math.min(inA, outA));
  }
  return a;
};

/** Pose at frame f from keyframes, with eased travel, plus how fast it is moving (for hops) and direction. */
const poseAt = (kfs: AssetKeyframe[], f: number) => {
  const ks = [...kfs].sort((a, b) => a.at - b.at);
  const get = (k: AssetKeyframe) => ({x: k.x ?? 0, y: k.y ?? 0, scale: k.scale ?? 1, rotate: k.rotate ?? 0});
  if (f <= ks[0].at) return {...get(ks[0]), moving: 0, dir: 0};
  const last = ks[ks.length - 1];
  if (f >= last.at) return {...get(last), moving: 0, dir: 0};
  const i = ks.findIndex((k, j) => f >= k.at && f < ks[j + 1].at);
  const a = get(ks[i]);
  const b = get(ks[i + 1]);
  const span = ks[i + 1].at - ks[i].at;
  const p = (f - ks[i].at) / span;
  const e = Easing.inOut(Easing.cubic)(p);
  const lerp = (u: number, v: number) => u + (v - u) * e;
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    x: lerp(a.x, b.x),
    y: lerp(a.y, b.y),
    scale: lerp(a.scale, b.scale),
    rotate: lerp(a.rotate, b.rotate),
    // 0..1 bell curve over the trip, only when it actually travels.
    moving: dist > 4 ? Math.sin(p * Math.PI) : 0,
    dir: Math.sign(b.x - a.x),
    trip: p,
    dist,
  };
};

export type AssetMotionProps = Omit<AnimatedAssetProps, 'src' | 'width' | 'height' | 'shadow' | 'style'>;

/** Shared motion engine for <AnimatedAsset> and <Puppet>: returns the CSS transform and opacity for this frame. */
export const useAssetMotion = ({
  enter = 'pop',
  idle = 'float',
  delay = 0,
  enterDuration = 18,
  keyframes,
  hopWhileMoving = true,
  faceMovement = false,
  exitAt,
  exit = 'fade',
  intensity = 1,
  talk,
  flip,
}: AssetMotionProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const f = frame - delay;
  const k = intensity;

  // ---- Entrance: p goes 0 → 1 (soft overshoot for pop/drop, never a shake).
  const bouncy = enter === 'pop' || enter === 'drop';
  const p =
    enter === 'none'
      ? 1
      : spring({frame: f, fps, durationInFrames: enterDuration, config: bouncy ? {damping: 14, stiffness: 120, mass: 0.9} : {damping: 200}});
  const linear = interpolate(f, [0, enterDuration * 0.6], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  let tx = 0;
  let ty = 0;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let opacity = enter === 'none' ? 1 : linear;
  const travel = 160 * Math.max(0.5, k);
  switch (enter) {
    case 'pop':
      sx = sy = p;
      break;
    case 'zoom':
      sx = sy = interpolate(p, [0, 1], [1.5, 1]);
      break;
    case 'slide-up':
      ty = (1 - p) * travel;
      break;
    case 'slide-down':
      ty = -(1 - p) * travel;
      break;
    case 'slide-left':
      tx = (1 - p) * travel * 2;
      break;
    case 'slide-right':
      tx = -(1 - p) * travel * 2;
      break;
    case 'drop':
      ty = -(1 - p) * travel * 3;
      break;
    case 'spin':
      rot = (1 - p) * -120;
      sx = sy = p;
      break;
    case 'fade':
      break;
  }

  // ---- Travel between keyframes.
  let facing = 1;
  let moving = 0;
  if (keyframes?.length) {
    const pose = poseAt(keyframes, f);
    tx += pose.x;
    ty += pose.y;
    sx *= pose.scale;
    sy *= pose.scale;
    rot += pose.rotate;
    moving = pose.moving;
    if (faceMovement && pose.dir) facing = pose.dir < 0 ? -1 : 1;
    if (hopWhileMoving && moving > 0 && pose.dist !== undefined) {
      // Little hops while walking: about one hop per 120 px travelled, smooth arcs.
      const hops = Math.max(1, Math.round(pose.dist / 120));
      const phase = (pose.trip ?? 0) * hops;
      const arc = Math.sin((phase % 1) * Math.PI);
      ty -= arc * 22 * k;
      rot += Math.sin(phase * Math.PI * 2) * 3 * k;
    }
  }

  // ---- Idle loop, eased in after the entrance so there is no jump, and calmed while travelling.
  const t = Math.max(0, f) / fps;
  const settle = smooth((f - enterDuration * 0.6) / (enterDuration * 0.8)) * (1 - moving);
  switch (idle) {
    case 'float':
      ty += -wave01(t, 0.35) * 14 * k * settle;
      rot += Math.sin(t * Math.PI * 2 * 0.22) * 1.5 * k * settle;
      break;
    case 'bob':
      // Gentle up-down, rounded at both ends.
      ty += -wave01(t, 0.6) * 12 * k * settle;
      break;
    case 'hop': {
      // A small hop every 1.6 s with squash on landing and stretch in the air.
      const cycle = (t % 1.6) / 1.6;
      const air = cycle < 0.35 ? Math.sin((cycle / 0.35) * Math.PI) : 0;
      const land = cycle >= 0.35 && cycle < 0.5 ? Math.sin(((cycle - 0.35) / 0.15) * Math.PI) : 0;
      ty += -air * 28 * k * settle;
      sy *= 1 + (air * 0.04 - land * 0.06) * k * settle;
      sx *= 1 + (-air * 0.02 + land * 0.05) * k * settle;
      break;
    }
    case 'sway':
      rot += Math.sin(t * Math.PI * 2 * 0.3) * 3.5 * k * settle;
      break;
    case 'pulse':
      sx = sy = sx * (1 + wave01(t, 0.7) * 0.035 * k * settle);
      break;
    case 'breathe':
      sy *= 1 + wave01(t, 0.28) * 0.025 * k * settle;
      sx *= 1 + wave01(t, 0.28) * 0.01 * k * settle;
      break;
    case 'spin':
      rot += t * 40 * k * settle;
      break;
    case 'wiggle': {
      // A short, smooth wiggle every 3 s to draw attention.
      const c = (t % 3) / 3;
      const env = c < 0.25 ? Math.sin((c / 0.25) * Math.PI) : 0;
      rot += Math.sin(t * Math.PI * 2 * 3) * 4 * k * env * settle;
      break;
    }
  }

  // ---- Talking: soft nod/bounce that eases in and out with the words (about 2.3 bounces per second).
  if (talk) {
    const a = speakingAmount(talk, t);
    if (a > 0) {
      ty += -wave01(t, 2.3) * 7 * k * a;
      rot += Math.sin(t * Math.PI * 2 * 1.15) * 1.8 * k * a;
      sy *= 1 + wave01(t, 2.3) * 0.012 * k * a;
    }
  }

  // ---- Exit.
  if (exitAt !== undefined) {
    const e = interpolate(frame, [exitAt, exitAt + 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic)});
    opacity *= 1 - e;
    if (exit === 'shrink') {
      sx *= 1 - e * 0.6;
      sy *= 1 - e * 0.6;
    }
    if (exit === 'slide-down') ty += e * travel;
    if (exit === 'slide-up') ty -= e * travel;
    if (exit === 'slide-left') tx -= e * travel * 2;
    if (exit === 'slide-right') tx += e * travel * 2;
  }

  // Before its delay it is invisible but keeps its space, so the layout never jumps when it appears.
  if (f < 0 && enter !== 'none') opacity = 0;

  const mirror = (flip ? -1 : 1) * facing;
  return {
    opacity,
    transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${sx * mirror}, ${sy})`,
  };
};

export const AnimatedAsset: React.FC<AnimatedAssetProps> = ({src, width, height, shadow, style, ...motion}) => {
  const m = useAssetMotion(motion);
  return (
    <Img
      src={resolve(src)}
      style={{
        width,
        height,
        objectFit: 'contain',
        opacity: m.opacity,
        transform: m.transform,
        transformOrigin: '50% 90%',
        filter: shadow ? 'drop-shadow(0 18px 24px rgba(0,0,0,0.35))' : undefined,
        willChange: 'transform, opacity',
        ...style,
      }}
    />
  );
};

export const resolveAsset = resolve;
