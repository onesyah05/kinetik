/**
 * Kinetik kit: helpers available to every video project via `import {...} from '@kit'`.
 * Works both in the browser preview (Remotion Player) and in local renders.
 */
import React, {createContext, useContext, useMemo} from 'react';
import {
  AbsoluteFill,
  Html5Audio,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export * from './settings';
export * from './asset';
export * from './puppet';
export * from './sprite';
export * from './motion';
import {defaultCaptions, type CaptionSettings, type ProjectSettings, type VoiceTrack, type Word} from './settings';

// ---------- Context ----------

const KitContext = createContext<ProjectSettings | null>(null);

export const KitRoot: React.FC<{settings: ProjectSettings; children: React.ReactNode}> = ({settings, children}) => {
  return <KitContext.Provider value={settings}>{children}</KitContext.Provider>;
};

export const useProject = (): ProjectSettings | null => useContext(KitContext);

export const useCaptionSettings = (): CaptionSettings => {
  const p = useContext(KitContext);
  return {...defaultCaptions, ...(p?.captions ?? {})};
};

// ---------- Helpers ----------

/** Seconds -> frames (rounded). */
export const useSec = () => {
  const {fps} = useVideoConfig();
  return (seconds: number) => Math.round(seconds * fps);
};

/** Frames needed to play a voice track, plus optional padding in seconds. */
export const trackFrames = (track: VoiceTrack, fps: number, padSeconds = 0) =>
  Math.ceil((track.durationInSeconds + padSeconds) * fps);

/** Opacity that fades in at the start and out at the end of `durationInFrames`. */
export const fadeInOut = (frame: number, durationInFrames: number, fade = 10) =>
  interpolate(frame, [0, fade, Math.max(fade + 1, durationInFrames - fade), durationInFrames], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

// ---------- Captions ----------

type Page = {words: Word[]; start: number; end: number};

const toPages = (words: Word[], perPage: number): Page[] => {
  const pages: Page[] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const bigGap = prev && w.start - prev.end > 0.6;
    if (cur.length >= perPage || bigGap) {
      pages.push({words: cur, start: cur[0].start, end: cur[cur.length - 1].end});
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) pages.push({words: cur, start: cur[0].start, end: cur[cur.length - 1].end});
  return pages;
};

/**
 * Renders word-synced captions for a list of words (times in seconds, relative to where
 * this component is mounted, i.e. use inside the same <Sequence> as the audio).
 * Respects the project's caption settings unless `force` is set.
 */
export const Captions: React.FC<{words: Word[]; force?: boolean; settings?: Partial<CaptionSettings>}> = ({
  words,
  force,
  settings,
}) => {
  const base = useCaptionSettings();
  const s = {...base, ...settings};
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  const perPage = Math.max(1, s.wordsPerPage || (s.style === 'tiktok' ? 3 : 7));
  const pages = useMemo(() => toPages(words, perPage), [words, perPage]);

  if (!s.enabled && !force) return null;

  const idx = pages.findIndex((p, i) => t >= p.start && t < (pages[i + 1]?.start ?? p.end + 0.4));
  if (idx === -1) return null;
  const page = pages[idx];
  if (t > page.end + 0.4) return null;

  const minSide = Math.min(width, height);
  const fontSize = s.fontSize > 0 ? s.fontSize : Math.round(minSide * (s.style === 'tiktok' ? 0.075 : 0.05));
  const portrait = height > width;
  const justify = s.position === 'top' ? 'flex-start' : s.position === 'center' ? 'center' : 'flex-end';
  const pad = s.position === 'center' ? 0 : height * (portrait ? 0.2 : 0.08);
  const pageFrame = Math.max(0, frame - Math.round(page.start * fps));
  const pop = s.style === 'tiktok' ? spring({frame: pageFrame, fps, config: {damping: 14, stiffness: 220}, durationInFrames: 10}) : 1;

  const wordEls = page.words.map((w, i) => {
    const active = t >= w.start && t < (page.words[i + 1]?.start ?? page.end + 0.4);
    const spoken = t >= w.start;
    let color = s.color;
    if (s.style === 'tiktok' && active) color = s.highlightColor;
    if (s.style === 'karaoke' && spoken) color = s.highlightColor;
    const text = s.uppercase && s.style === 'tiktok' ? w.text.toUpperCase() : w.text;
    return (
      <span
        key={i}
        style={{
          color,
          display: 'inline-block',
          margin: `0 ${fontSize * 0.2}px`,
          transform: s.style === 'tiktok' && active ? 'scale(1.06)' : undefined,
        }}
      >
        {text}
      </span>
    );
  });

  const textShadow =
    s.style === 'tiktok'
      ? `0 0 ${fontSize * 0.08}px rgba(0,0,0,0.9), 0 ${fontSize * 0.06}px ${fontSize * 0.12}px rgba(0,0,0,0.8)`
      : undefined;

  return (
    <AbsoluteFill style={{justifyContent: justify, alignItems: 'center', padding: `${pad}px ${width * 0.06}px`, pointerEvents: 'none'}}>
      <div
        style={{
          fontFamily: s.fontFamily,
          fontSize,
          fontWeight: s.style === 'tiktok' ? 900 : 600,
          lineHeight: 1.2,
          textAlign: 'center',
          maxWidth: width * 0.88,
          transform: `scale(${0.85 + 0.15 * pop})`,
          WebkitTextStroke: s.style === 'tiktok' ? `${Math.max(2, fontSize * 0.06)}px black` : undefined,
          paintOrder: 'stroke fill',
          textShadow,
          background: s.style === 'classic' ? 'rgba(0,0,0,0.65)' : undefined,
          borderRadius: s.style === 'classic' ? fontSize * 0.3 : undefined,
          padding: s.style === 'classic' ? `${fontSize * 0.25}px ${fontSize * 0.5}px` : undefined,
        }}
      >
        {wordEls}
      </div>
    </AbsoluteFill>
  );
};

// ---------- Narration ----------

/**
 * Plays a voiceover track generated by the `tts` tool and (if enabled in project settings)
 * shows synced captions. Place it inside a <Sequence from={...}> to control when it starts.
 */
export const Narration: React.FC<{track: VoiceTrack; volume?: number; captions?: boolean}> = ({
  track,
  volume = 1,
  captions = true,
}) => {
  return (
    <>
      <Html5Audio src={staticFile(track.src)} volume={volume} />
      {captions ? <Captions words={track.words} /> : null}
    </>
  );
};
