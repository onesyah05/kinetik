import React, {useState} from 'react';
import {Check} from 'lucide-react';

export type AskQuestion = {
  id: string;
  question: string;
  multiSelect?: boolean;
  options: {id: string; label: string; description?: string; recommended?: boolean}[];
};

/** Clickable answers for the agent's ask_user tool. Sends one message with every answer. */
export const AskUser: React.FC<{questions: AskQuestion[]; disabled: boolean; onAnswer: (text: string) => void}> = ({
  questions,
  disabled,
  onAnswer,
}) => {
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.options.filter((o) => o.recommended).map((o) => o.id).slice(0, q.multiSelect ? 99 : 1)])),
  );
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const toggle = (q: AskQuestion, id: string) =>
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      if (!q.multiSelect) return {...p, [q.id]: [id]};
      return {...p, [q.id]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]};
    });

  const complete = questions.every((q) => (picked[q.id]?.length ?? 0) > 0 || other[q.id]?.trim());

  const submit = () => {
    const lines = questions.map((q) => {
      const labels = q.options.filter((o) => picked[q.id]?.includes(o.id)).map((o) => o.label);
      if (other[q.id]?.trim()) labels.push(other[q.id].trim());
      return `${q.question} → ${labels.join(', ')}`;
    });
    setSent(true);
    onAnswer(lines.join('\n'));
  };

  const locked = disabled || sent;
  return (
    <div className="ask">
      {questions.map((q) => (
        <div key={q.id} className="ask-q">
          <div className="ask-title">
            {q.question}
            {q.multiSelect && <span className="faint"> · choose any</span>}
          </div>
          {q.options.map((o) => {
            const on = picked[q.id]?.includes(o.id) ?? false;
            return (
              <button key={o.id} className={`ask-opt ${on ? 'on' : ''}`} disabled={locked} onClick={() => toggle(q, o.id)}>
                <span className={`ask-box ${q.multiSelect ? '' : 'round'}`}>{on && <Check size={12} />}</span>
                <span className="grow">
                  <span className="ask-label">{o.label}</span>
                  {o.description && <span className="ask-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          <input
            className="input ask-other"
            placeholder="Something else"
            disabled={locked}
            value={other[q.id] ?? ''}
            onChange={(e) => setOther((x) => ({...x, [q.id]: e.target.value}))}
          />
        </div>
      ))}
      <button className="btn primary sm" style={{width: '100%'}} disabled={locked || !complete} onClick={submit}>
        {sent ? 'Sent' : 'Send answer'}
      </button>
    </div>
  );
};
