// Post finished renders to a Facebook Page as Reels (Graph API "video_reels" flow:
// start an upload session, send the file to rupload.facebook.com, then finish with the caption).
// The Page ID and Page access token come from Settings; captions and hashtags are written by
// the project's own LLM, with Google Trends for the region as a hint.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {getConfig, getProvider, type Config} from './config';
import {emit} from './events';
import {DATA, safeJoin} from './paths';
import {activeVideoId, getProject, projectDir, rendersDir, videoDirRel, videosOf} from './projects';

const GRAPH = (process.env.KINETIK_FB_GRAPH || 'https://graph.facebook.com').replace(/\/$/, '');
const VERSION = 'v27.0';
/** Meta allows 30 API-published Reels per Page per rolling 24 hours. */
const DAILY_LIMIT = 30;

export type FacebookSettings = NonNullable<Config['facebook']>;

export type ReelPost = {
  status: 'writing' | 'starting' | 'uploading' | 'processing' | 'publishing' | 'done' | 'error';
  progress: number;
  state: 'PUBLISHED' | 'DRAFT';
  /** The caption and hashtags that were (or are being) posted. */
  description?: string;
  videoId?: string;
  url?: string;
  note?: string;
  error?: string;
  postedAt?: number;
};

/** What Kinetik knows about a rendered file, kept next to it as <file>.json. */
export type RenderMeta = {
  videoId?: string;
  videoName?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationInFrames?: number;
  quality?: string;
  facebook?: ReelPost & {pageId?: string; description?: string};
};

// ---------- Render sidecars ----------

const metaPath = (projectId: string, file: string) => `${safeJoin(rendersDir(projectId), file)}.json`;

export const readRenderMeta = (projectId: string, file: string): RenderMeta => {
  try {
    return JSON.parse(fs.readFileSync(metaPath(projectId, file), 'utf8'));
  } catch {
    return {};
  }
};

export const writeRenderMeta = (projectId: string, file: string, patch: Partial<RenderMeta>) => {
  const next = {...readRenderMeta(projectId, file), ...patch};
  fs.writeFileSync(metaPath(projectId, file), JSON.stringify(next, null, 2));
  return next;
};

/** Which video of the project a render came from (older renders have no sidecar: match the file name). */
const videoOfRender = (projectId: string, file: string) => {
  const p = getProject(projectId);
  const videos = videosOf(p);
  const meta = readRenderMeta(projectId, file);
  const byId = meta.videoId && videos.find((v) => v.id === meta.videoId);
  if (byId) return byId;
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60);
  const byName = videos.find((v) => file.startsWith(clean(`${p.name}-${v.name}`)));
  return byName ?? videos.find((v) => v.id === activeVideoId(p)) ?? videos[0];
};

// ---------- Settings and errors ----------

const settings = (): FacebookSettings => {
  const fb = getConfig().facebook;
  if (!fb?.pageId?.trim() || !fb?.pageToken?.trim())
    throw new Error('Add your Facebook Page ID and Page access token in Settings → Facebook Reels first.');
  return {...fb, pageId: fb.pageId.trim(), pageToken: fb.pageToken.trim()};
};

/** Turn a Graph API error into something a person can act on. */
const graphError = (j: any, status: number, what: string) => {
  const e = j?.error ?? {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const known: Record<number, string> = {
    190: 'The Page access token is invalid or expired. Make a new one and paste it in Settings → Facebook Reels.',
    10: 'The token is missing a permission. It needs pages_show_list, pages_read_engagement and pages_manage_posts.',
    200: 'The token is missing a permission. It needs pages_show_list, pages_read_engagement and pages_manage_posts.',
    4: 'Facebook rate limit reached. Try again later.',
    32: 'Facebook rate limit reached for this Page. Try again later.',
    1363040: 'Facebook only accepts 9:16 (portrait) Reels. Change the project size to 1080×1920 and render again.',
    1363127: 'Resolution not supported. Reels need at least 540×960; render at Standard or High quality.',
    1363128: 'Duration not supported. Reels must be 3 to 90 seconds long.',
    1363129: 'Frame rate not supported. Reels need 24 to 60 fps.',
  };
  // The upload host (rupload) answers {debug_info: {type, message}} instead of {error}.
  const dbg = j?.debug_info;
  const uploadHints: Record<string, string> = {
    NotAuthorizedError: 'Facebook did not accept the token for uploading. Use the Page access token of this Page (not the user token).',
    OffsetInvalidError: 'The upload got out of step with Facebook. Try posting again.',
    PartialRequestError: 'The upload was cut off. Check the internet connection and try again.',
    ProcessingFailedError: 'Facebook could not read this video file. Render it again and retry.',
  };
  const friendly = known[sub] ?? known[code] ?? (dbg?.type ? uploadHints[dbg.type] : undefined);
  const raw =
    e.error_user_msg ||
    e.message ||
    (dbg ? [dbg.type, dbg.message].filter(Boolean).join(': ') : '') ||
    (typeof j?.raw === 'string' && j.raw.trim() ? j.raw.trim().slice(0, 300) : '') ||
    `HTTP ${status}`;
  const err = new Error(`${what}: ${friendly ? `${friendly} (${raw})` : raw}`);
  console.error(`[facebook] ${err.message}`);
  return err;
};

const graphGet = async (pathAndQuery: string, token: string) => {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const r = await fetch(`${GRAPH}/${VERSION}/${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw graphError(j, r.status, 'Facebook');
  return j;
};

const graphPost = async (pathname: string, params: Record<string, string>, what: string) => {
  const r = await fetch(`${GRAPH}/${VERSION}/${pathname}`, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(60_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw graphError(j, r.status, what);
  return j;
};

/** Check the Page ID and token: returns the Page name, or throws a readable error. */
export const testFacebook = async (pageId?: string, pageToken?: string) => {
  const fb = getConfig().facebook;
  const id = (pageId || fb?.pageId || '').trim();
  const token = (pageToken || fb?.pageToken || '').trim();
  if (!id || !token) throw new Error('Fill in both the Page ID and the Page access token.');
  const page = await graphGet(`${encodeURIComponent(id)}?fields=id,name`, token);
  // A user token can read the Page but cannot publish to it.
  const me = await graphGet('me?fields=id,name', token).catch(() => null);
  const isPageToken = me?.id === page.id;
  return {
    id: page.id as string,
    name: page.name as string,
    warning: isPageToken
      ? undefined
      : 'This looks like a user token, not the Page access token. Publishing may fail: get the Page token (Graph API Explorer → choose the Page under "User or Page").',
  };
};

// ---------- Video checks (Reels specs) ----------

export type VideoCheck = {width?: number; height?: number; fps?: number; seconds?: number; hasAudio?: boolean; problems: string[]; warnings: string[]};

export const checkReel = (projectId: string, file: string): VideoCheck => {
  const full = safeJoin(rendersDir(projectId), file);
  let width: number | undefined, height: number | undefined, fps: number | undefined, seconds: number | undefined, hasAudio: boolean | undefined;
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', full],
    {encoding: 'utf8', timeout: 20_000},
  );
  if (probe.status === 0) {
    try {
      const j = JSON.parse(probe.stdout);
      const v = j.streams?.find((s: any) => s.codec_type === 'video');
      width = v?.width;
      height = v?.height;
      const [a, b] = String(v?.r_frame_rate ?? '').split('/').map(Number);
      if (a && b) fps = a / b;
      seconds = Number(j.format?.duration) || undefined;
      hasAudio = !!j.streams?.some((s: any) => s.codec_type === 'audio');
    } catch {
      /* fall back to the sidecar */
    }
  }
  if (!width) {
    const m = readRenderMeta(projectId, file);
    width = m.width;
    height = m.height;
    fps = m.fps;
    seconds = m.durationInFrames && m.fps ? m.durationInFrames / m.fps : undefined;
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  if (width && height) {
    if (Math.abs(width / height - 9 / 16) > 0.01) problems.push(`Size is ${width}×${height}; Reels must be 9:16 portrait (like 1080×1920).`);
    else if (width < 540 || height < 960) problems.push(`Size is ${width}×${height}; Reels need at least 540×960.`);
    else if (width < 1080) warnings.push(`${width}×${height} works, but 1080×1920 looks sharper. Render at Standard or High quality.`);
  }
  if (seconds !== undefined && (seconds < 3 || seconds > 90)) problems.push(`Length is ${seconds.toFixed(1)}s; Reels must be 3 to 90 seconds.`);
  if (fps !== undefined && (fps < 24 || fps > 60)) problems.push(`Frame rate is ${Math.round(fps)} fps; Reels need 24 to 60 fps.`);
  if (hasAudio === false) warnings.push('This video has no sound. Reels without audio get less reach.');
  return {width, height, fps, seconds, hasAudio, problems, warnings};
};

// ---------- Trends and AI caption ----------

let trendCache: {region: string; at: number; topics: string[]} | null = null;

/** Today's top searches for a region from Google Trends (free RSS, no key). Empty when offline. */
export const trendingTopics = async (region = 'ID'): Promise<string[]> => {
  region = region.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'ID';
  if (trendCache && trendCache.region === region && Date.now() - trendCache.at < 60 * 60 * 1000) return trendCache.topics;
  try {
    const r = await fetch(`https://trends.google.com/trending/rss?geo=${region}`, {signal: AbortSignal.timeout(8000)});
    const xml = r.ok ? await r.text() : '';
    const topics = [...xml.matchAll(/<item>\s*<title>([^<]+)<\/title>/g)]
      .map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim())
      .filter(Boolean)
      .slice(0, 25);
    trendCache = {region, at: Date.now(), topics};
    return topics;
  } catch {
    return trendCache?.topics ?? [];
  }
};

/** "#Belajar Sains!" → "#belajarsains". Lowercase, no spaces or punctuation. */
export const toHashtag = (s: string) => {
  const t = s.toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '');
  return t ? `#${t}` : '';
};

/** Every voiceover script used by one video: its narration is the best summary of what it says. */
const scriptOf = (projectId: string, videoId: string) => {
  const root = projectDir(projectId);
  const dir = path.join(root, videoDirRel(videoId));
  const sources: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // The main video's folder (src/) also holds the other videos and the generated voiceovers.
        if (!['videos', 'voiceover', 'node_modules'].includes(e.name)) walk(full);
      } else if (/\.tsx?$/.test(e.name) && e.name !== 'Root.tsx') sources.push(fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  const code = sources.join('\n');
  const names = [...new Set([...code.matchAll(/voiceover\/([\w.-]+?)(?:\.ts)?['"]/g)].map((m) => m[1]))];
  const texts: string[] = [];
  for (const n of names) {
    try {
      const src = fs.readFileSync(path.join(root, 'src', 'voiceover', `${n}.ts`), 'utf8');
      const m = src.match(/"text":\s*"((?:[^"\\]|\\.)*)"/);
      if (m) texts.push(JSON.parse(`"${m[1]}"`));
    } catch {
      /* not a track */
    }
  }
  if (texts.length) return texts.join(' ').slice(0, 4000);
  // No narration: fall back to the words shown on screen.
  const strings = [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n]){12,200})\1/g)]
    .map((m) => m[2])
    .filter((s) => /\s/.test(s) && !/^[./@]|\.(tsx?|png|jpe?g|mp3|svg)$|^#|rgba?\(|px\b/.test(s));
  return [...new Set(strings)].join(' · ').slice(0, 2500);
};

const extractJson = (text: string) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON');
  return JSON.parse(text.slice(start, end + 1));
};

export type CaptionDraft = {caption: string; hashtags: string[]; trends: string[]};

/** Ask the project's LLM for a Reels caption and lowercase hashtags. */
export const draftCaption = async (projectId: string, file: string): Promise<CaptionDraft> => {
  const p = getProject(projectId);
  const video = videoOfRender(projectId, file);
  const script = scriptOf(projectId, video.id);
  const region = getConfig().facebook?.trendRegion || 'ID';
  const trends = await trendingTopics(region);
  const provider = getProvider(p.providerId);
  if (!provider) throw new Error('No AI model is set up. Add one in Settings first.');
  const seconds = Math.round(video.durationInFrames / p.fps);
  const prompt = [
    'Write the caption for a Facebook Reel.',
    `Video title: ${video.name}`,
    p.name !== video.name ? `Series / project: ${p.name}` : '',
    video.theme ? `Theme: ${video.theme}` : '',
    `Length: ${seconds} seconds`,
    script ? `Narration and on-screen text:\n${script}` : '',
    trends.length ? `Searches trending right now in region ${region} (Google Trends):\n${trends.join(', ')}` : '',
    '',
    'Rules:',
    '- Write in the same language as the narration (Indonesian if unsure). Casual, friendly, natural for Reels.',
    '- caption: a scroll-stopping first line (hook), then 1–2 short sentences on what viewers learn or feel, then a short call to action (comment, share or follow). Max 300 characters. At most 2 emoji. No hashtags inside the caption.',
    '- hashtags: 6 to 10, all lowercase, no spaces. Mix: 2–3 broad hashtags that are popular on Reels right now in this region (for example fyp, reels, viral, fypシ, trending, or local ones), 3–5 specific to this video\'s topic, and a trending search from the list ONLY if it truly matches the video.',
    'Reply with JSON only: {"caption": "...", "hashtags": ["#...", "#..."]}',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}`},
    body: JSON.stringify({model: provider.model, stream: false, messages: [{role: 'user', content: prompt}]}),
    signal: AbortSignal.timeout(120_000),
  }).catch((e) => {
    throw new Error(`Cannot reach the AI model (${provider.name}): ${e.message}`);
  });
  const j: any = await res.json().catch(() => ({}));
  const text: string = j?.choices?.[0]?.message?.content ?? '';
  if (!res.ok || !text) throw new Error(`The AI model could not write a caption (${provider.model}): ${j?.error?.message ?? `HTTP ${res.status}`}`);
  let out: {caption?: string; hashtags?: unknown};
  try {
    out = extractJson(text);
  } catch {
    // Not JSON: keep the text and pull hashtags out of it.
    out = {caption: text.replace(/#[\p{L}\p{N}_]+/gu, '').trim(), hashtags: text.match(/#[\p{L}\p{N}_]+/gu) ?? []};
  }
  const hashtags = [...new Set((Array.isArray(out.hashtags) ? out.hashtags : []).map((h) => toHashtag(String(h))).filter(Boolean))].slice(0, 10);
  const caption = String(out.caption ?? '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .trim()
    .slice(0, 1000);
  return {caption, hashtags, trends};
};

// ---------- Publishing ----------

const postsLog = () => path.join(DATA, 'facebook-posts.json');
const recentPosts = (pageId: string) => {
  try {
    const all: {at: number; pageId: string}[] = JSON.parse(fs.readFileSync(postsLog(), 'utf8'));
    return all.filter((x) => x.pageId === pageId && Date.now() - x.at < 24 * 60 * 60 * 1000);
  } catch {
    return [];
  }
};
const logPost = (pageId: string, videoId: string) => {
  let all: {at: number; pageId: string; videoId: string}[] = [];
  try {
    all = JSON.parse(fs.readFileSync(postsLog(), 'utf8'));
  } catch {
    /* first post */
  }
  all = all.filter((x) => Date.now() - x.at < 7 * 24 * 60 * 60 * 1000);
  all.push({at: Date.now(), pageId, videoId});
  fs.mkdirSync(DATA, {recursive: true});
  fs.writeFileSync(postsLog(), JSON.stringify(all, null, 2));
};

const active = new Map<string, ReelPost>();
const key = (projectId: string, file: string) => `${projectId}/${file}`;

export const reelPostState = (projectId: string, file: string) => active.get(key(projectId, file)) ?? readRenderMeta(projectId, file).facebook;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const publishReel = (
  projectId: string,
  file: string,
  /** Without a description the AI writes the caption and hashtags first (one-click posting). */
  opts: {description?: string; state?: 'PUBLISHED' | 'DRAFT'; aiLabel?: boolean} = {},
): ReelPost => {
  const fb = settings();
  const k = key(projectId, file);
  const running = active.get(k);
  if (running && !['done', 'error'].includes(running.status)) throw new Error('This video is already being posted.');
  const full = safeJoin(rendersDir(projectId), file);
  if (!fs.existsSync(full)) throw new Error('The rendered file is gone. Render it again.');
  const check = checkReel(projectId, file);
  if (check.problems.length) throw new Error(check.problems.join(' '));
  if (recentPosts(fb.pageId).length >= DAILY_LIMIT)
    throw new Error(`Facebook allows ${DAILY_LIMIT} Reels per Page every 24 hours through the API, and this Page has reached it. Try again later.`);
  const given = String(opts.description ?? '').trim();
  const state = opts.state === 'DRAFT' ? 'DRAFT' : 'PUBLISHED';
  const aiLabel = opts.aiLabel ?? fb.aiLabel ?? true;
  const post: ReelPost = {status: given ? 'starting' : 'writing', progress: 0, state, ...(given ? {description: given} : {})};
  active.set(k, post);
  const publish = () => emit({type: 'fb_progress', projectId, file, post: {...post}});
  publish();

  (async () => {
    try {
      // 0. One click: let the AI write the caption and lowercase hashtags.
      let description = given;
      if (!description) {
        const d = await draftCaption(projectId, file);
        description = [d.caption, d.hashtags.join(' ')].filter(Boolean).join('\n\n');
        if (!description) throw new Error('The AI returned an empty caption. Try again.');
        post.description = description;
        post.status = 'starting';
        publish();
      }
      description = description.slice(0, 2200);

      // 1. Open an upload session.
      const started = await graphPost(`${encodeURIComponent(fb.pageId)}/video_reels`, {upload_phase: 'start', access_token: fb.pageToken}, 'Could not start the upload');
      const videoId = String(started.video_id ?? '');
      if (!videoId) throw new Error('Facebook did not return a video id.');
      post.videoId = videoId;
      const uploadUrl: string = process.env.KINETIK_FB_UPLOAD
        ? `${process.env.KINETIK_FB_UPLOAD.replace(/\/$/, '')}/video-upload/${VERSION}/${videoId}`
        : started.upload_url || `https://rupload.facebook.com/video-upload/${VERSION}/${videoId}`;

      // 2. Send the file, streamed so a large video doesn't sit in memory.
      post.status = 'uploading';
      publish();
      const size = fs.statSync(full).size;
      const send = async (offset: number) => {
        let sent = offset;
        let last = 0;
        const stream = fs.createReadStream(full, {start: offset});
        stream.on('data', (chunk) => {
          sent += chunk.length;
          if (Date.now() - last > 400) {
            last = Date.now();
            post.progress = sent / size;
            publish();
          }
        });
        // A plain request with Content-Length, like the curl example in Meta's docs:
        // rupload does not take chunked uploads, which is what fetch() sends for a stream.
        const {status, text} = await new Promise<{status: number; text: string}>((resolve, reject) => {
          const u = new URL(uploadUrl);
          const req = (u.protocol === 'http:' ? http : https).request(
            u,
            {
              method: 'POST',
              headers: {
                authorization: `OAuth ${fb.pageToken}`,
                offset: String(offset),
                file_size: String(size),
                'content-type': 'application/octet-stream',
                'content-length': String(size - offset),
              },
              timeout: 10 * 60 * 1000,
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({status: res.statusCode ?? 0, text: body}));
              res.on('error', reject);
            },
          );
          req.on('timeout', () => req.destroy(new Error('Upload timed out')));
          req.on('error', reject);
          stream.on('error', (e) => req.destroy(e));
          stream.pipe(req);
        });
        let j: any;
        try {
          j = JSON.parse(text);
        } catch {
          j = {raw: text};
        }
        if (status < 200 || status >= 300 || j.success === false || j.error || j.debug_info) throw graphError(j, status, 'Upload failed');
      };
      try {
        await send(0);
      } catch (e) {
        // Resume once from where Facebook says it stopped.
        const s = await graphGet(`${videoId}?fields=status`, fb.pageToken).catch(() => null);
        const done = Number(s?.status?.uploading_phase?.bytes_transfered ?? s?.status?.uploading_phase?.bytes_transferred);
        if (!s || !Number.isFinite(done) || done <= 0 || done >= size) throw e;
        await send(done);
      }
      post.progress = 1;

      // 3. Publish with the caption.
      post.status = 'publishing';
      publish();
      await graphPost(
        `${encodeURIComponent(fb.pageId)}/video_reels`,
        {
          access_token: fb.pageToken,
          video_id: videoId,
          upload_phase: 'finish',
          video_state: state,
          description,
          ...(aiLabel ? {is_ai_generated: 'true'} : {}),
        },
        'Could not publish the Reel',
      );
      logPost(fb.pageId, videoId);

      // 4. Wait for Facebook to finish processing (it keeps going if we stop waiting).
      post.status = 'processing';
      publish();
      const deadline = Date.now() + 5 * 60 * 1000;
      let finished = false;
      while (Date.now() < deadline) {
        await sleep(4000);
        const s = await graphGet(`${videoId}?fields=status`, fb.pageToken).catch(() => null);
        const st = s?.status ?? {};
        const failed = st.video_status === 'error' || st.processing_phase?.status === 'error' || st.publishing_phase?.status === 'error';
        if (failed) {
          const why = st.processing_phase?.error?.message ?? st.publishing_phase?.error?.message ?? st.uploading_phase?.errors?.[0]?.message;
          throw new Error(`Facebook could not process the video${why ? `: ${why}` : '.'}`);
        }
        const pub = st.publishing_phase?.publish_status;
        if ((state === 'PUBLISHED' && pub === 'published') || (state === 'DRAFT' && (st.video_status === 'ready' || pub === 'draft'))) {
          finished = true;
          break;
        }
      }
      post.status = 'done';
      post.postedAt = Date.now();
      post.url = `https://www.facebook.com/reel/${videoId}`;
      if (state === 'DRAFT') post.note = 'Saved as a draft. Publish it from Meta Business Suite.';
      else if (!finished) post.note = 'Facebook is still processing it; it appears on the Page in a few minutes.';
      writeRenderMeta(projectId, file, {facebook: {...post, pageId: fb.pageId, description}});
    } catch (e: any) {
      post.status = 'error';
      post.error = String(e?.message ?? e).slice(0, 1000);
    } finally {
      publish();
      if (post.status === 'done') active.delete(k);
    }
  })();
  return {...post};
};
