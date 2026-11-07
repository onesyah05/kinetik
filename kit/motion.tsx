/**
 * Motion-design building blocks: premium entrances, staggers, word reveals, exits, the
 * five-layer scene finish (mesh background, grade, grain, vignette), Ken Burns, counters
 * and timed sound effects. Patterns adapted from claude-remotion-skill (MIT, haidrrrry),
 * tuned for laptops: no large CSS blur filters.
 */
import React from 'react';
import {AbsoluteFill, Easing, Html5Audio, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

// ---------- Curves ----------

/** The easing curves. Linear motion reads cheap: use these instead. */
export const ease = {
  /** easeOutExpo: entrances. */
  out: Easing.bezier(0.16, 1, 0.3, 1),
  /** easeInOutQuint: moves, camera, Ken Burns. */
  inOut: Easing.bezier(0.83, 0, 0.17, 1),
  /** Exits only. */
  in: Easing.bezier(0.7, 0, 0.84, 0),
};

/** Spring presets: snappy for words and UI pops, smooth for big elements, bouncy for playful accents. */
export const springs = {
  snappy: {damping: 14, stiffness: 160, mass: 0.6},
  smooth: {damping: 20, stiffness: 90, mass: 1},
  bouncy: {damping: 11, stiffness: 170, mass: 0.7},
};
type SpringName = keyof typeof springs;

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

/** interpolate() with an easing and clamping built in: tween(frame, [10, 30], [0, 1]). */
export const tween = (frame: number, frames: [number, number], values: [number, number], easing: (t: number) => number = ease.out) =>
  interpolate(frame, frames, values, {...clamp, easing});

/** Idle micro-motion for anything on screen longer than ~2 s: {scale, y} to fold into a transform. */
export const breathe = (frame: number, amount = 1) => ({
  scale: 1 + Math.sin(frame / 22) * 0.015 * amount,
  y: Math.sin(frame / 30) * 3 * amount,
});

/** Style that animates an element out (faster than it came in): fade + lift, eased in. */
export const exitStyle = (frame: number, at: number, frames = 10, distance = 40): React.CSSProperties => {
  if (frame < at) return {};
  const p = tween(frame, [at, at + frames], [0, 1], ease.in);
  return {opacity: 1 - p, transform: `translateY(${-distance * p}px)`};
};

// ---------- Entrances ----------

type Dir = 'up' | 'down' | 'left' | 'right' | 'none';
const offset = (dir: Dir, d: number) =>
  dir === 'up' ? [0, d] : dir === 'down' ? [0, -d] : dir === 'left' ? [d, 0] : dir === 'right' ? [-d, 0] : [0, 0];

export type EntranceProps = {
  /** Frames to wait before entering. */
  delay?: number;
  /** Where it comes from (default 'up' = rises into place). */
  from?: Dir;
  distance?: number;
  /** Starting scale (default 0.94). */
  scale?: number;
  spring?: SpringName;
  /** Frame (in this sequence) to start the exit; omit to stay. */
  exitAt?: number;
  exitFrames?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

/** The workhorse entrance: opacity + travel + scale together on a spring, with an optional faster exit. */
export const Entrance: React.FC<EntranceProps> = ({delay = 0, from = 'up', distance = 40, scale = 0.94, spring: preset = 'smooth', exitAt, exitFrames = 10, style, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: springs[preset]});
  const [dx, dy] = offset(from, distance);
  const out = exitAt !== undefined && frame >= exitAt ? tween(frame, [exitAt, exitAt + exitFrames], [0, 1], ease.in) : 0;
  return (
    <div
      style={{
        ...style,
        opacity: p * (1 - out),
        transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p) - distance * out}px) scale(${scale + (1 - scale) * p})`,
      }}
    >
      {children}
    </div>
  );
};

/** Enters each child in turn, `every` frames apart (words 3, list items 4-5, big blocks 6). */
export const Stagger: React.FC<Omit<EntranceProps, 'children'> & {every?: number; children: React.ReactNode; itemStyle?: React.CSSProperties}> = ({
  every = 4,
  delay = 0,
  style,
  itemStyle,
  children,
  ...entrance
}) => (
  <div style={style}>
    {React.Children.toArray(children).map((child, i) => (
      <Entrance key={i} {...entrance} delay={delay + i * every} style={itemStyle}>
        {child}
      </Entrance>
    ))}
  </div>
);

/**
 * Headline that lands word by word. `highlight` (a word or its index) gets the hero color
 * and a bar that grows under it a few frames after it lands.
 */
export const WordReveal: React.FC<{
  text: string;
  delay?: number;
  per?: number;
  highlight?: string | number;
  highlightColor?: string;
  style?: React.CSSProperties;
}> = ({text, delay = 0, per = 3, highlight, highlightColor = '#ff7a45', style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const words = text.split(/\s+/).filter(Boolean);
  const hi = typeof highlight === 'number' ? highlight : words.findIndex((w) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() === String(highlight ?? '').toLowerCase());
  return (
    <div style={{display: 'flex', flexWrap: 'wrap', columnGap: '0.26em', ...style}}>
      {words.map((word, i) => {
        const at = delay + i * per;
        const p = spring({frame: frame - at, fps, config: springs.snappy});
        const bar = i === hi ? spring({frame: frame - at - 5, fps, config: springs.smooth}) : 0;
        return (
          <span key={i} style={{display: 'inline-block', position: 'relative', opacity: p, transform: `translateY(${(1 - p) * 0.3}em)`, color: i === hi ? highlightColor : undefined}}>
            {word}
            {i === hi ? (
              <span
                style={{position: 'absolute', left: 0, right: 0, bottom: '0.02em', height: '0.09em', borderRadius: '0.05em', background: highlightColor, transform: `scaleX(${bar})`, transformOrigin: 'left'}}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
};

/** Number that counts up with tabular figures (no jitter). */
export const Counter: React.FC<{to: number; from?: number; delay?: number; decimals?: number; prefix?: string; suffix?: string; style?: React.CSSProperties}> = ({
  to,
  from = 0,
  delay = 0,
  decimals = 0,
  prefix = '',
  suffix = '',
  style,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - delay, fps, config: {damping: 30, stiffness: 60}});
  const value = from + (to - from) * p;
  return (
    <span style={{fontVariantNumeric: 'tabular-nums', ...style}}>
      {prefix}
      {value.toLocaleString(undefined, {minimumFractionDigits: decimals, maximumFractionDigits: decimals})}
      {suffix}
    </span>
  );
};

// ---------- The five-layer stack ----------

/** Layer 1: a living background (two slow drifting color fields), never a flat fill. */
export const BgMesh: React.FC<{bg: string; primary: string; accent?: string; strength?: number}> = ({bg, primary, accent = primary, strength = 1}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const size = Math.max(width, height) * 1.1;
  const a = Math.round(0x33 * Math.min(2, strength)).toString(16).padStart(2, '0');
  const b = Math.round(0x22 * Math.min(2, strength)).toString(16).padStart(2, '0');
  return (
    <AbsoluteFill style={{background: bg, overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          width: size,
          height: size,
          left: -size * 0.3 + Math.sin(frame / 55) * size * 0.04,
          top: -size * 0.4 + Math.cos(frame / 80) * size * 0.03,
          background: `radial-gradient(circle, ${primary}${a}, transparent 62%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: size * 0.8,
          height: size * 0.8,
          right: -size * 0.25 - Math.cos(frame / 70) * size * 0.035,
          bottom: -size * 0.35,
          background: `radial-gradient(circle, ${accent}${b}, transparent 65%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Layer 4: color grade that pulls mismatched assets into one look. */
export const Grade: React.FC<{color: string; opacity?: number}> = ({color, opacity = 0.18}) => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <AbsoluteFill style={{backgroundColor: color, mixBlendMode: 'soft-light', opacity}} />
    <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(0,0,0,0.10), transparent 28%, transparent 72%, rgba(0,0,0,0.2))'}} />
  </AbsoluteFill>
);

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

/** Layer 5a: moving film grain, no asset file. Use blend 'multiply' on light themes. */
export const Grain: React.FC<{opacity?: number; blend?: 'overlay' | 'multiply' | 'soft-light'}> = ({opacity = 0.05, blend = 'overlay'}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        backgroundImage: NOISE,
        backgroundSize: '220px',
        backgroundPosition: `${(frame * 7) % 220}px ${(frame * 13) % 220}px`,
        opacity,
        mixBlendMode: blend,
      }}
    />
  );
};

/** Layer 5b: vignette, the topmost layer. */
export const Vignette: React.FC<{strength?: number}> = ({strength = 0.22}) => (
  <AbsoluteFill style={{pointerEvents: 'none', background: `radial-gradient(ellipse at center, transparent 56%, rgba(0,0,0,${strength}) 100%)`}} />
);

/** Layers 4-5 in one: grade, grain and vignette. Put it LAST in a scene (or once over the whole video). */
export const Finish: React.FC<{color: string; grade?: number; grain?: number; vignette?: number; light?: boolean}> = ({
  color,
  grade,
  grain,
  vignette,
  light,
}) => (
  <>
    <Grade color={color} opacity={grade ?? (light ? 0.12 : 0.18)} />
    <Grain opacity={grain} blend={light ? 'multiply' : 'overlay'} />
    <Vignette strength={vignette ?? (light ? 0.14 : 0.22)} />
  </>
);

// ---------- Stills ----------

/** Ken Burns for a still: slow zoom and pan across the sequence. Alternate zoom 'in'/'out' between shots. */
export const KenBurns: React.FC<{
  src: string;
  zoom?: 'in' | 'out';
  amount?: number;
  pan?: number;
  durationInFrames?: number;
  style?: React.CSSProperties;
  imgStyle?: React.CSSProperties;
}> = ({src, zoom = 'in', amount = 0.1, pan = -25, durationInFrames, style, imgStyle}) => {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig();
  const d = Math.max(2, durationInFrames ?? cfg.durationInFrames);
  const range: [number, number] = zoom === 'in' ? [1, 1 + amount] : [1 + amount, 1];
  const scale = tween(frame, [0, d], range, ease.inOut);
  const x = tween(frame, [0, d], [0, pan], ease.inOut);
  const url = /^(https?:|data:|\/)/.test(src) ? src : staticFile(src);
  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden', ...style}}>
      <Img src={url} style={{width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${scale}) translateX(${x}px)`, ...imgStyle}} />
    </div>
  );
};

// ---------- Sound ----------

/**
 * A sound effect from the add_sfx kit (or any audio file), started `lead` frames before
 * `at` so it feels in sync (late sound feels broken).
 */
export const Sfx: React.FC<{name?: string; src?: string; at: number; lead?: number; volume?: number}> = ({name, src, at, lead = 3, volume = 0.6}) => {
  const file = src ?? `sfx/${name ?? 'whoosh'}.wav`;
  return (
    <Sequence from={Math.max(0, at - lead)} layout="none">
      <Html5Audio src={staticFile(file)} volume={volume} />
    </Sequence>
  );
};
