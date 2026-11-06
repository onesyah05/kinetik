import fs from 'node:fs';
import path from 'node:path';
import {DATA} from './paths';

export type Provider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** Model accepts images (needed for snapshot self-check). */
  vision: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Ask for one tool call per reply. Needed for gateways that drop replies with several tool calls. */
  oneToolPerTurn?: boolean;
};

export type Config = {
  providers: Provider[];
  activeProvider: string;
  /** providerId: reuse an LLM provider's base URL and key (e.g. a gateway that also serves image models). */
  imageGen: {baseURL: string; apiKey: string; model: string; size: string; providerId?: string};
  stock: {pexelsKey: string; unsplashKey: string};
  tts: {
    /** edge = free Microsoft voices; gemini = expressive Google voices steered with natural-language direction. */
    engine: 'edge' | 'gemini';
    defaultVoice: string;
    rate: string;
    geminiKey: string;
    geminiModel: string;
    geminiVoice: string;
  };
  render: {concurrency: number; quality: 'draft' | 'standard' | 'high'};
  agent: {maxSteps: number; snapshotMaxSide: number};
  /** Part detection for rig_character fallback: a vision model on one of the LLM providers. */
  rig?: {providerId?: string; model?: string};
  /** Posting renders to a Facebook Page as Reels. trendRegion: Google Trends country for hashtag hints. */
  facebook?: {pageId: string; pageToken: string; trendRegion?: string; aiLabel?: boolean};
};

const FILE = path.join(DATA, 'config.json');

const defaults: Config = {
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-5.1',
      vision: true,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: 'anthropic/claude-sonnet-5.5',
      vision: true,
    },
    {
      id: 'ollama',
      name: 'Ollama (local)',
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5-coder:7b',
      vision: false,
    },
  ],
  activeProvider: 'openai',
  imageGen: {baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1', size: '1024x1024'},
  stock: {pexelsKey: '', unsplashKey: ''},
  tts: {
    engine: 'edge',
    defaultVoice: 'id-ID-GadisNeural',
    rate: '+0%',
    geminiKey: '',
    geminiModel: 'gemini-2.5-flash-preview-tts',
    geminiVoice: 'Aoede',
  },
  render: {concurrency: 2, quality: 'standard'},
  agent: {maxSteps: 80, snapshotMaxSide: 768},
};

let cache: Config | null = null;

export const getConfig = (): Config => {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      ...defaults,
      ...raw,
      imageGen: {...defaults.imageGen, ...raw.imageGen},
      stock: {...defaults.stock, ...raw.stock},
      tts: {...defaults.tts, ...raw.tts},
      render: {...defaults.render, ...raw.render},
      agent: {...defaults.agent, ...raw.agent},
    };
  } catch {
    cache = structuredClone(defaults);
  }
  return cache!;
};

export const saveConfig = (c: Config) => {
  fs.mkdirSync(DATA, {recursive: true});
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2));
  cache = c;
};

export const getProvider = (id?: string): Provider | undefined => {
  const c = getConfig();
  return c.providers.find((p) => p.id === (id || c.activeProvider)) ?? c.providers[0];
};
