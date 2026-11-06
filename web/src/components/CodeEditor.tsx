import React, {useCallback, useEffect, useRef, useState} from 'react';
import CodeMirror from '@uiw/react-codemirror';
import {javascript} from '@codemirror/lang-javascript';
import {oneDark} from '@codemirror/theme-one-dark';
import {EditorView} from '@codemirror/view';

// One Dark syntax colors on the navy glass surface instead of its grey background.
const navy = EditorView.theme(
  {
    '&': {backgroundColor: 'transparent', height: '100%'},
    '.cm-gutters': {backgroundColor: 'transparent', borderRight: '1px solid rgba(226,232,255,0.08)', color: '#5d6884'},
    '.cm-activeLine': {backgroundColor: 'rgba(226,232,255,0.04)'},
    '.cm-activeLineGutter': {backgroundColor: 'transparent', color: '#a4adc4'},
    '.cm-content': {fontFamily: "'Geist Mono Variable', Consolas, monospace"},
    '.cm-scroller': {fontFamily: "'Geist Mono Variable', Consolas, monospace", lineHeight: '20px'},
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {backgroundColor: 'rgba(255,122,69,0.22) !important'},
  },
  {dark: true},
);
import {FileCode2, Lock, Save} from 'lucide-react';
import {api, type FileEntry} from '../api';

export const CodeEditor: React.FC<{projectId: string; version: number}> = ({projectId, version}) => {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [active, setActive] = useState('src/Video.tsx');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.files(projectId).then(setFiles);
  }, [projectId, version]);

  const dirty = content !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Reload the open file when it changes on disk, unless the user has unsaved edits.
  useEffect(() => {
    api
      .file(projectId, active)
      .then((r) => {
        setSaved(r.content);
        if (!dirtyRef.current) setContent(r.content);
      })
      .catch(() => {
        setContent('');
        setSaved('');
      });
  }, [projectId, active, version]);

  const managed = files.find((f) => f.path === active)?.managed ?? false;

  const save = useCallback(async () => {
    if (!dirty || managed) return;
    try {
      await api.saveFile(projectId, active, content);
      setSaved(content);
      setStatus('Saved');
      const c = await api.check(projectId);
      setStatus(c.ok ? 'Saved, compiles' : `Saved with ${c.errors.length} error${c.errors.length > 1 ? 's' : ''}: ${c.errors[0]}`);
    } catch (e: any) {
      setStatus(e.message);
    }
  }, [dirty, managed, projectId, active, content]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [save]);

  const open = (p: string) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setContent('');
    setSaved('');
    setStatus('');
    setActive(p);
  };

  const byPath = (a: FileEntry, b: FileEntry) => a.path.localeCompare(b.path);
  const groups: [string, FileEntry[]][] = [
    ['Scenes', files.filter((f) => !f.managed).sort(byPath)],
    ['Managed by Kinetik', files.filter((f) => f.managed).sort(byPath)],
  ];

  return (
    <div className="code">
      <div className="file-list">
        {groups.map(([label, list]) =>
          list.length ? (
            <React.Fragment key={label}>
              <div className="file-group">{label}</div>
              {list.map((f) => (
                <div key={f.path} className={`file ${f.path === active ? 'active' : ''}`} onClick={() => open(f.path)} title={f.path}>
                  {f.managed ? <Lock size={16} /> : <FileCode2 size={16} />}
                  {f.path.replace(/^src\//, '')}
                </div>
              ))}
            </React.Fragment>
          ) : null,
        )}
      </div>
      <div className="editor-wrap">
        <div className="editor-bar">
          <span className="mono small">{active}</span>
          {managed && <span className="chip">read-only</span>}
          {dirty && <span className="chip warn">unsaved</span>}
          <span className="small muted grow" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
            {status}
          </span>
          <button className="btn sm" onClick={save} disabled={!dirty || managed}>
            <Save size={16} /> Save
          </button>
        </div>
        <div className="editor">
          <CodeMirror
            value={content}
            onChange={setContent}
            theme={[oneDark, navy]}
            readOnly={managed}
            extensions={[javascript({jsx: true, typescript: true})]}
            height="100%"
            style={{height: '100%', fontSize: 13}}
            basicSetup={{foldGutter: true, highlightActiveLine: true}}
          />
        </div>
      </div>
    </div>
  );
};
