import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ArrowUp, ChevronRight, Eraser, ImagePlus, Loader2, Pencil, RotateCcw, Square, X} from 'lucide-react';
import {api, projectUrl, type Config, type Message, type Project, type ToolCall} from '../api';
import type {Bus} from './ProjectView';
import {StylePicker} from './StylePicker';
import {AskUser} from './AskUser';

type ToolMsg = Extract<Message, {role: 'tool'}>;

const SUGGESTIONS: [string, string][] = [
  ['Explainer', 'A 20-second explainer about how solar panels work, flat illustration style, with an Indonesian voiceover'],
  ['Social 9:16', 'A TikTok promo for a coffee shop called "Kopi Senja" with bold captions and upbeat motion'],
  ['Math', 'Animate the Pythagorean theorem: draw a right triangle, squares on each side, then show a² + b² = c²'],
  ['Data', 'A bar chart race of the 5 most populous countries from 1960 to 2020, approximate data is fine'],
];

const parseArgs = (s: string) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

const summarize = (name: string, args: any): string => {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return args.path ?? '';
    case 'snapshot':
      return args.frames?.length ? `frames ${args.frames.join(', ')}` : args.seconds?.length ? `${args.seconds.join('s, ')}s` : 'auto';
    case 'tts': {
      const said = String(args.text || (args.segments ?? []).map((s: {text: string}) => s.text).join(' '));
      return `${args.name}: “${said.slice(0, 50)}${said.length > 50 ? '…' : ''}”`;
    }
    case 'present_styles':
      return `${args.options?.length ?? 0} options`;
    case 'ask_user':
      return args.questions?.[0]?.question ?? '';
    case 'create_vector_asset':
      return args.filename ?? '';
    case 'update_project':
      return Object.keys(args).join(', ');
    case 'search_stock':
      return `${args.type ?? 'photo'}: ${args.query}`;
    case 'generate_image':
    case 'download_asset':
      return args.filename ?? '';
    case 'view_image':
      return args.path ?? '';
    case 'render_video':
      return args.quality ?? '';
    default:
      return '';
  }
};

type Seg = {text: string; style?: string; rate?: string; pitch?: string; volume?: string; pause?: number};

const num = (v?: string) => Number(String(v ?? '0').replace(/[^\d.+-]/g, '')) || 0;

/** The delivery the agent directed, as readable notation: pitch contour, speed, loudness and pauses. */
const VoiceNotation: React.FC<{args: any; result: ToolMsg; projectId: string}> = ({args, result, projectId}) => {
  const segs: Seg[] = args.segments?.length ? args.segments : [{text: args.text ?? ''}];
  let audio = '';
  try {
    audio = JSON.parse(result.content).audio ?? '';
  } catch {
    /* ignore */
  }
  return (
    <div className="voice">
      {audio && <audio className="voice-audio" src={`${projectUrl(projectId, `public/${audio}`)}?v=${result.ts}`} controls preload="none" />}
      {segs.map((s, i) => {
        const p = num(s.pitch);
        const r = num(s.rate);
        const v = num(s.volume);
        // Without a pitch value (Gemini), read the contour from the style words.
        const st = (s.style ?? '').toLowerCase();
        const up = p >= 6 || (!p && /naik|tanya|semangat|antusias|kaget|excited|rising/.test(st));
        const down = p <= -3 || (!p && /pelan|tenang|turun|lembut|calm|soft/.test(st));
        const arrow = up ? '↗' : down ? '↘' : '→';
        const marks = [
          s.style?.trim() || '',
          p ? `nada ${p > 0 ? '+' : ''}${p}Hz` : '',
          r ? `${r > 0 ? 'cepat' : 'pelan'} ${r > 0 ? '+' : ''}${r}%` : '',
          v ? `${v > 0 ? 'keras' : 'lembut'} ${v > 0 ? '+' : ''}${v}%` : '',
        ].filter(Boolean);
        return (
          <div key={i} className="voice-seg">
            <span className={`voice-arrow ${up ? 'up' : down ? 'down' : ''}`}>{arrow}</span>
            <span className="grow">
              <span className="voice-text">{s.text}</span>
              <span className="voice-marks">
                {marks.join(' · ')}
                {s.pause ? ` · jeda ${s.pause}s ‖` : ''}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
};

const ToolCard: React.FC<{
  call: ToolCall;
  result?: ToolMsg;
  running: boolean;
  projectId: string;
  project: Project;
  onZoom: (src: string) => void;
  onSend: (text: string, images?: string[]) => void;
  /** True for cards after the last user message: interactive pickers stay live only there. */
  latest: boolean;
}> = ({call, result, running, projectId, project, onZoom, onSend, latest}) => {
  const [open, setOpen] = useState(false);
  const args = parseArgs(call.arguments);
  const pending = !result;
  const status = pending ? (running ? 'run' : 'err') : result.error ? 'err' : 'ok';
  const images = result?.images ?? [];
  return (
    <div className={`tool ${result?.error ? 'err' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${status}`} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-sum">
          {summarize(call.name, args)}
          {result?.display ? ` · ${result.display}` : ''}
        </span>
        <ChevronRight size={16} className={`tool-chevron ${open ? 'open' : ''}`} />
      </div>
      {images.length > 0 && (
        <div className="filmstrip">
          {images.map((src) => {
            const url = `${projectUrl(projectId, src)}?v=${result?.ts ?? ''}`;
            const frame = src.match(/-f(\d+)\.jpg$/)?.[1];
            return (
              <div key={src} className={`film-frame ${src.startsWith('public/') ? 'asset' : ''}`} onClick={() => onZoom(url)}>
                <img src={url} alt="" />
                {frame && <span>f{frame}</span>}
              </div>
            );
          })}
        </div>
      )}
      {call.name === 'tts' && result && !result.error ? <VoiceNotation args={args} result={result} projectId={projectId} /> : null}
      {result?.questions?.length ? <AskUser questions={result.questions} disabled={running || !latest} onAnswer={onSend} /> : null}
      {result?.styles?.length ? (
        <StylePicker
          project={project}
          options={result.styles}
          disabled={running || !latest}
          live={latest}
          onPick={(o) =>
            o.image
              ? onSend(`Use the "${o.name}" style. Its frame is attached (public/${o.image}); follow it as the art direction and continue building the video.`, [`public/${o.image}`])
              : onSend(`Use the "${o.name}" style (${o.file}).`)
          }
          onSwitch={(to) => {
            // Remember the form for this project so later style rounds use it too.
            if (to !== 'regenerate') void api.updateProject(project.id, {styleFrames: to}).catch(() => {});
            onSend(
              to === 'code'
                ? 'Show these style options as live code samples instead.'
                : to === 'regenerate'
                  ? 'Generate 3 new AI style frames (different looks) for this video.'
                  : 'Generate these style options as AI frames instead.',
            );
          }}
        />
      ) : null}
      {open && (
        <div className="tool-body">
          <pre>{call.name === 'write_file' ? `${args.path}\n\n${args.content ?? ''}` : JSON.stringify(args, null, 2)}</pre>
          {result && (
            <>
              <div className="label" style={{marginTop: 10}}>
                Result
              </div>
              <pre>{result.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const ToolCardMemo = React.memo(ToolCard);

/** Markdown parsing is the expensive part of re-rendering; skip it when the text is unchanged. */
const Markdown = React.memo(({text}: {text: string}) => <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>);

/** A user message with Edit and Resend. Both replace this message and drop everything after it. */
const UserMessage: React.FC<{
  m: Extract<Message, {role: 'user'}>;
  projectId: string;
  running: boolean;
  onZoom: (src: string) => void;
  onResend: (id: string, text: string, images: string[]) => void;
}> = ({m, projectId, running, onZoom, onResend}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const images = m.images ?? [];
  const submit = () => {
    if (!draft.trim()) return;
    setEditing(false);
    onResend(m.id, draft, images);
  };
  return (
    <div className="msg msg-user-wrap">
      <div className={`msg-user ${editing ? 'editing' : ''}`}>
        {images.length ? (
          <div className="attach-list">
            {images.map((src) => (
              <div className="attach" key={src}>
                <img src={projectUrl(projectId, src)} onClick={() => onZoom(projectUrl(projectId, src))} />
              </div>
            ))}
          </div>
        ) : null}
        {editing ? (
          <>
            <textarea
              className="input msg-edit"
              autoFocus
              value={draft}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="msg-edit-actions">
              <span className="small faint grow">Messages after this one are removed. Files stay as they are.</span>
              <button className="btn ghost sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn primary sm" disabled={running || !draft.trim()} onClick={submit}>
                Send
              </button>
            </div>
          </>
        ) : (
          m.content
        )}
      </div>
      {!editing && (
        <div className="msg-tools">
          <button
            className="btn ghost icon sm"
            disabled={running}
            title="Edit and send again"
            onClick={() => {
              setDraft(m.content);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </button>
          <button className="btn ghost icon sm" disabled={running} title="Send again" onClick={() => onResend(m.id, m.content, images)}>
            <RotateCcw size={14} />
          </button>
        </div>
      )}
    </div>
  );
};

type ListProps = {
  messages: Message[];
  running: boolean;
  projectId: string;
  project: Project;
  onZoom: (src: string) => void;
  onSend: (text: string, images?: string[]) => void;
  onResend: (id: string, text: string, images: string[]) => void;
};

/** The conversation. Memoised so typing or pasting in the composer never re-renders it. */
const MessageList = React.memo(({messages, running, projectId, project, onZoom, onSend, onResend}: ListProps) => {
  const results = useMemo(() => {
    const m = new Map<string, ToolMsg>();
    for (const x of messages) if (x.role === 'tool') m.set(x.tool_call_id, x);
    return m;
  }, [messages]);
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && !m.hidden) lastUser = i;
  });
  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'user' && m.hidden) return null;
        if (m.role === 'user')
          return <UserMessage key={m.id} m={m} projectId={projectId} running={running} onZoom={onZoom} onResend={onResend} />;
        if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return null;
        if (m.role === 'assistant')
          return (
            <div key={m.id} className="msg msg-assistant">
              {m.content && <Markdown text={m.content} />}
              {m.tool_calls?.map((tc) => (
                <ToolCardMemo
                  key={tc.id}
                  call={tc}
                  result={results.get(tc.id)}
                  running={running}
                  projectId={projectId}
                  project={project}
                  onZoom={onZoom}
                  onSend={onSend}
                  latest={i > lastUser}
                />
              ))}
            </div>
          );
        if (m.role === 'error')
          return (
            <div key={m.id} className="msg">
              <div className="error-box">{m.content}</div>
            </div>
          );
        return null;
      })}
    </>
  );
});

/** Text box + attachments. Owns its own state so keystrokes and paste stay instant. */
const Composer: React.FC<{
  projectId: string;
  running: boolean;
  onSend: (text: string, images: string[]) => Promise<boolean>;
  onClear: () => void;
  prefill: {text: string; n: number} | null;
}> = ({projectId, running, onSend, onClear, prefill}) => {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setDraft((d) => (d ? `${d}\n${prefill.text}` : prefill.text));
    setTimeout(() => input.current?.focus(), 0);
  }, [prefill]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || running) return;
    const imgs = attachments;
    setDraft('');
    setAttachments([]);
    setError('');
    const ok = await onSend(text, imgs);
    if (!ok) {
      setDraft(text);
      setAttachments(imgs);
    }
  };

  const attach = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    try {
      const saved = await api.upload(
        projectId,
        imgs.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.png`, {type: f.type}))),
        'chat',
      );
      setAttachments((a) => [...a, ...saved.map((p) => `public/${p}`)]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <>
      {error && (
        <div className="error-box" style={{marginBottom: 8}}>
          {error}
        </div>
      )}
      <div className="composer-box">
        {attachments.length > 0 && (
          <div className="attach-list">
            {attachments.map((a) => (
              <div className="attach" key={a}>
                <img src={projectUrl(projectId, a)} />
                <button onClick={() => setAttachments((x) => x.filter((y) => y !== a))}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          rows={2}
          placeholder={running ? 'The agent is working' : 'Describe a video or ask for a change'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (e.ctrlKey || e.metaKey) {
              // Ctrl+Enter inserts a new line (browsers don't do this by themselves).
              e.preventDefault();
              const el = e.currentTarget;
              const {selectionStart: a, selectionEnd: b} = el;
              const next = `${draft.slice(0, a)}\n${draft.slice(b)}`;
              setDraft(next);
              requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
              return;
            }
            if (!e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            // Only images become attachments; text pastes go straight into the box.
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              attach(files);
            }
          }}
        />
        <div className="row">
          <button className="btn ghost icon sm" title="Attach image" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={16} />
          </button>
          <button className="btn ghost icon sm" title="Clear conversation" onClick={onClear} disabled={running}>
            <Eraser size={16} />
          </button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => attach([...(e.target.files ?? [])])} />
          <div className="grow faint" style={{fontSize: 12}}>
            Enter to send, Shift+Enter or Ctrl+Enter for a new line
          </div>
          {running ? (
            <button className="btn sm" onClick={() => api.stop(projectId)}>
              <Square size={16} /> Stop
            </button>
          ) : (
            <button className="btn primary icon sm" onClick={submit} disabled={!draft.trim()} title="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </>
  );
};

export const Chat: React.FC<{
  projectId: string;
  project: Project;
  bus: Bus;
  providerId?: string;
  config: Config | null;
  onOpenSettings: () => void;
}> = ({
  projectId,
  project,
  bus,
  providerId,
  config,
  onOpenSettings,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamReasoning, setStreamReasoning] = useState('');
  const [activeTool, setActiveTool] = useState<{name: string; chars: number} | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{text: string; n: number} | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api.messages(projectId).then((r) => {
      setMessages(r.messages);
      setRunning(r.running);
    });
  }, [projectId]);

  useEffect(
    () =>
      bus.subscribe((e) => {
        if (e.type !== 'agent') return;
        switch (e.event) {
          case 'history':
            // An edit or resend cut the conversation back.
            setMessages(e.messages);
            break;
          case 'message':
            setMessages((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message]));
            if (e.message.role === 'assistant') {
              setStreamText('');
              setStreamReasoning('');
              setActiveTool(null);
            }
            break;
          case 'assistant_start':
            setStreamText('');
            setStreamReasoning('');
            break;
          case 'delta':
            setStreamText((t) => t + e.text);
            break;
          case 'reasoning':
            setStreamReasoning((t) => (t + e.text).slice(-600));
            break;
          case 'tool_progress':
            setActiveTool({name: e.name, chars: e.chars});
            break;
          case 'retry':
            setActiveTool({name: `retry ${e.attempt}/2 after a gateway error`, chars: 0});
            break;
          case 'status':
            setRunning(e.running);
            if (!e.running) {
              setStreamText('');
              setStreamReasoning('');
              setActiveTool(null);
            }
            break;
        }
      }),
    [bus],
  );

  // Requests from the preview ("Ask agent to fix", "Comment on this frame").
  useEffect(() => {
    const on = (ev: Event) => {
      const {text, send: now} = (ev as CustomEvent).detail as {text: string; send: boolean};
      if (now) sendRef.current(text, []);
      else setPrefill({text, n: Date.now()});
    };
    window.addEventListener('kinetik:ask', on);
    return () => window.removeEventListener('kinetik:ask', on);
  });

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, activeTool, running]);

  // Stable callbacks so the memoised message list does not re-render on unrelated changes.
  const runningRef = useRef(running);
  runningRef.current = running;
  const sendRef = useRef(async (_t: string, _i: string[], _e?: string) => false);
  sendRef.current = async (text: string, images: string[], editFrom?: string) => {
    if (!text.trim() || runningRef.current) return false;
    setError('');
    try {
      setRunning(true);
      await api.chat(projectId, {text: text.trim(), images, providerId, editFrom});
      return true;
    } catch (e: any) {
      setRunning(false);
      setError(e.message);
      return false;
    }
  };
  const sendText = useCallback((text: string, images: string[] = []) => void sendRef.current(text, images), []);
  const sendFromComposer = useCallback((text: string, images: string[]) => sendRef.current(text, images), []);
  const resend = useCallback((id: string, text: string, images: string[]) => void sendRef.current(text, images, id), []);
  const zoomTo = useCallback((src: string) => setZoom(src), []);

  const clear = async () => {
    if (!confirm('Clear the conversation? Files are kept.')) return;
    await api.clearMessages(projectId);
    setMessages([]);
  };

  const provider = config?.providers.find((p) => p.id === providerId);
  const needsKey = provider && !provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL);

  return (
    <>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && !running && (
          <div className="intro">
            <h2>Describe your video</h2>
            <div className="muted small">Topic, style, length, voiceover language, colors or music. Attach a logo or reference images if you have them.</div>
            <div className="suggestions">
              {SUGGESTIONS.map(([kind, text]) => (
                <button key={text} className="suggestion" onClick={() => setPrefill({text, n: Date.now()})}>
                  <small>{kind}</small>
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        <MessageList messages={messages} running={running} projectId={projectId} project={project} onZoom={zoomTo} onSend={sendText} onResend={resend} />

        {running && (
          <div className="msg msg-assistant">
            {streamReasoning && !streamText && <div className="reasoning">{streamReasoning}</div>}
            {streamText && <Markdown text={streamText} />}
            <div className="working">
              <Loader2 size={16} className="spin" />
              {activeTool ? `Writing ${activeTool.name}${activeTool.chars > 200 ? ` · ${(activeTool.chars / 1000).toFixed(1)}k chars` : ''}` : 'Thinking'}
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        {needsKey && (
          <div className="notice">
            <span>{provider!.name} needs an API key</span>
            <button className="btn sm" onClick={onOpenSettings}>
              Add key
            </button>
          </div>
        )}
        {error && (
          <div className="error-box" style={{marginBottom: 8}}>
            {error}
          </div>
        )}
        <Composer projectId={projectId} running={running} onSend={sendFromComposer} onClear={clear} prefill={prefill} />
      </div>

      {zoom && (
        <div className="overlay lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} />
        </div>
      )}
    </>
  );
};
