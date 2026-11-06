/**
 * <Sprite>: plays a frame-by-frame animation made by the generate_sprite tool (e.g. a host flapping its wings),
 * with every <AnimatedAsset> motion prop (enter, idle, keyframes, talk, exit...) on top.
 */
import React from 'react';
import {Img, useCurrentFrame, useVideoConfig} from 'remotion';
import {resolveAsset, useAssetMotion, type AssetMotionProps} from './asset';

export type SpriteData = {
  width: number;
  height: number;
  /** Playback speed of the drawing, independent of the video fps. */
  fps: number;
  mode: 'loop' | 'pingpong' | 'once' | string;
  frames: string[];
};

export type SpriteProps = AssetMotionProps & {
  sprite: SpriteData;
  width: number;
  /** Override the sprite's own drawing speed. */
  fps?: number;
  mode?: 'loop' | 'pingpong' | 'once';
  /** Start on another drawing so several copies are not in sync. */
  offset?: number;
  shadow?: boolean;
  style?: React.CSSProperties;
};

export const Sprite: React.FC<SpriteProps> = ({sprite, width, fps: drawFps, mode, offset = 0, shadow, style, ...motion}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const m = useAssetMotion(motion);
  const n = sprite.frames.length;
  const speed = drawFps ?? sprite.fps;
  const step = Math.floor((Math.max(0, frame - (motion.delay ?? 0)) / fps) * speed) + offset;
  const how = mode ?? sprite.mode;
  let i: number;
  if (how === 'once') i = Math.min(n - 1, step);
  else if (how === 'pingpong' && n > 1) {
    const period = 2 * (n - 1);
    const s = step % period;
    i = s < n ? s : period - s;
  } else i = step % n;

  const height = (width * sprite.height) / sprite.width;
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
      {/* Every drawing stays mounted (hidden) so switching frames never waits for an image to load. */}
      {sprite.frames.map((src, k) => (
        <Img
          key={src}
          src={resolveAsset(src)}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: k === i ? 1 : 0}}
        />
      ))}
    </div>
  );
};
