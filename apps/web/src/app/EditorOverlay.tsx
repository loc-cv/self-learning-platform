// The editor overlay (docs/ARCHITECTURE.md §3.8, DIV-014): vim, vi, nano and kubectl edit ask the
// page to edit a file. CodeMirror 6 edits it, with vim keys for the vim flavor unless the
// settings ask for plain keys. `:w` saves (one editor.save input), `:q` closes (editor.close),
// `:wq`, `:x` and ZZ do both, `:q!` and ZQ close without saving. Messages on the bottom line are
// vim's own words (vimref.ts); Ex commands vim has but the overlay does not are `[sim]` notices
// and gap records, never vim's E492.

import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { yaml } from '@codemirror/lang-yaml';
import { tags as t } from '@lezer/highlight';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import type { OpenEditor } from '../protocol.ts';
import { exArgs, toBuffer, toFile } from './editorText.ts';
import { E37, E45, E492, fileInfo, isVimCommand, MODES, written } from './vimref.ts';

export interface SaveResult {
  ok: boolean;
  message?: string;
}

interface Props {
  editor: OpenEditor;
  keys: 'vim' | 'plain';
  save(content: string): Promise<SaveResult>;
  close(): void;
  /** Something the overlay does not simulate: a `[sim]` notice was shown, record the gap. */
  gap(what: string, commandLine: string): void;
}

interface Controller {
  write(opts: { bang: boolean; thenClose: boolean; onlyIfModified?: boolean }): void;
  quit(bang: boolean): void;
  notSimulated(command: string, input: string): void;
  message(text: string, error?: boolean): void;
}

/** Ex commands find their overlay through the view (the vim emulation's Ex table is global). */
const controllers = new WeakMap<EditorView, Controller>();

interface VimCm {
  cm6: EditorView;
  on(event: string, fn: (e: { mode: string; subMode?: string }) => void): void;
  openNotification?: (template: Node, options?: unknown) => () => void;
}

const controllerOf = (cm: unknown): Controller | undefined => controllers.get((cm as VimCm).cm6);

let exDefined = false;
function defineEx(): void {
  if (exDefined) return;
  exDefined = true;
  type Params = { argString?: string; input?: string };
  const ex = (name: string, prefix: string, fn: (c: Controller, bang: boolean, arg: string, input: string) => void): void =>
    Vim.defineEx(name, prefix, (cm: unknown, params: Params) => {
      const c = controllerOf(cm);
      if (!c) return;
      const a = exArgs(name, params.argString);
      fn(c, a.bang, a.arg, params.input ?? name);
    });
  const withFile = (go: (c: Controller, bang: boolean) => void) => (c: Controller, bang: boolean, arg: string, input: string) => {
    if (arg !== '') c.notSimulated(`:${input.replace(/^:/, '')}`, input);
    else go(c, bang);
  };
  ex('write', 'w', withFile((c, bang) => c.write({ bang, thenClose: false })));
  ex('wall', 'wa', withFile((c, bang) => c.write({ bang, thenClose: false })));
  ex('update', 'up', withFile((c, bang) => c.write({ bang, thenClose: false, onlyIfModified: true })));
  ex('wq', 'wq', withFile((c, bang) => c.write({ bang, thenClose: true })));
  ex('wqall', 'wqa', withFile((c, bang) => c.write({ bang, thenClose: true })));
  ex('xit', 'x', withFile((c, bang) => c.write({ bang, thenClose: true, onlyIfModified: true })));
  ex('xall', 'xa', withFile((c, bang) => c.write({ bang, thenClose: true, onlyIfModified: true })));
  ex('exit', 'exi', withFile((c, bang) => c.write({ bang, thenClose: true, onlyIfModified: true })));
  ex('quit', 'q', (c, bang) => c.quit(bang));
  ex('qall', 'qa', (c, bang) => c.quit(bang));
  ex('quitall', 'quita', (c, bang) => c.quit(bang));
  ex('close', 'clo', (c, bang) => c.quit(bang));
  Vim.map('ZZ', ':x<CR>', 'normal');
  Vim.map('ZQ', ':q!<CR>', 'normal');
}

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.content], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-atom)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.meta, t.processingInstruction, t.labelName], color: 'var(--syn-keyword)' },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: 'var(--syn-punct)' },
  { tag: [t.typeName, t.tagName], color: 'var(--syn-type)' },
]);

const chrome = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--term-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-code)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--term-bg)', color: 'var(--text-faint)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine': { backgroundColor: 'var(--line-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-fat-cursor': { background: 'var(--accent) !important', color: 'var(--term-bg) !important' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: '1px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', border: 'none' },
  '.cm-panels input': { fontFamily: 'var(--font-code)', color: 'var(--text)', background: 'transparent', border: 'none', outline: 'none' },
  '.cm-vim-panel': { padding: '3px 10px', fontFamily: 'var(--font-code)', fontSize: '13px' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--search-match)', color: 'inherit' },
});

export function EditorOverlay(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const props = useRef(p);
  props.current = p;
  const req = p.editor.request;
  const vimKeys = req.flavor === 'vim' && p.keys === 'vim';
  const [line, setLine] = useState<{ text: string; error: boolean }>({ text: vimKeys ? fileInfo(req.name, p.editor.content, { isNew: req.isNew === true && !p.editor.saved, readOnly: req.readOnly }) : '', error: false });
  const [mode, setMode] = useState('');
  const [pos, setPos] = useState('1,1');
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    defineEx();
    let savedDoc = toBuffer(p.editor.content);
    let isNew = req.isNew === true && !p.editor.saved;
    let saving = false;
    const message = (text: string, error = false): void => setLine({ text, error });
    const modified = (v: EditorView): boolean => v.state.doc.toString() !== savedDoc;

    const write = async (v: EditorView, o: { bang: boolean; thenClose: boolean; onlyIfModified?: boolean }): Promise<void> => {
      if (o.onlyIfModified && !modified(v)) {
        if (o.thenClose) props.current.close();
        return;
      }
      if (req.readOnly && !o.bang && vimKeys) return message(E45, true);
      if (saving) return;
      saving = true;
      const doc = v.state.doc.toString();
      const text = toFile(doc);
      const r = await props.current.save(text);
      saving = false;
      if (!r.ok) return message(r.message ?? 'The file could not be written.', true);
      savedDoc = doc;
      setDirty(modified(v));
      message(vimKeys ? written(req.name, text, isNew) : `Saved ${req.path}`);
      isNew = false;
      if (o.thenClose) props.current.close();
    };

    const c: Controller = {
      write: (o) => void write(view.current as EditorView, o),
      quit(bang) {
        const v = view.current as EditorView;
        if (!bang && modified(v)) return message(E37, true);
        props.current.close();
      },
      notSimulated(command, input) {
        message(`[sim] vim: ${command} is not simulated yet`, true);
        props.current.gap(command, input);
      },
      message,
    };

    const plainKeys = keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (c.write({ bang: true, thenClose: false }), true) },
      // nano's keys for write out and exit.
      { key: 'Ctrl-o', preventDefault: true, run: () => (c.write({ bang: true, thenClose: false }), true) },
      {
        key: 'Ctrl-x',
        preventDefault: true,
        run: (v) => {
          if (modified(v)) setConfirmClose(true);
          else props.current.close();
          return true;
        },
      },
    ]);

    const extensions: Extension[] = [
      ...(vimKeys ? [vim({ status: false })] : [plainKeys]),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      history(),
      bracketMatching(),
      highlightSelectionMatches(),
      EditorState.tabSize.of(2),
      indentUnit.of('  '),
      keymap.of([...(vimKeys ? [] : [indentWithTab]), ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      syntaxHighlighting(highlight),
      // vim's 'wrap' is on by default: long lines (last-applied-configuration) wrap.
      EditorView.lineWrapping,
      chrome,
      ...(req.language === 'yaml' ? [yaml()] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(modified(u.view));
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const l = u.state.doc.lineAt(head);
          setPos(`${l.number},${head - l.from + 1}`);
        }
      }),
    ];
    const v = new EditorView({ parent: host.current as HTMLDivElement, state: EditorState.create({ doc: savedDoc, extensions }) });
    view.current = v;
    controllers.set(v, c);
    if (vimKeys) {
      const cm = getCM(v) as unknown as VimCm | null;
      cm?.on('vim-mode-change', (e) => {
        // A new mode clears the message line, as in vim.
        setMode(e.mode === 'visual' && e.subMode ? `visual-${e.subMode}` : e.mode);
        setLine({ text: '', error: false });
      });
      if (cm) {
        // The emulation's own messages go to the bottom line; its unknown-command text becomes vim's.
        cm.openNotification = (template: Node) => {
          const text = template.textContent ?? '';
          const unknown = /^Not an editor command ":(.*)"$/s.exec(text);
          if (unknown) {
            const input = (unknown[1] as string).trim();
            const name = /^[A-Za-z]+|^./.exec(input.replace(/^[\d%.,$'<>\s]+/, ''))?.[0] ?? '';
            if (isVimCommand(name)) c.notSimulated(`:${name}`, `:${input}`);
            else message(E492(input), true);
          } else message(text, true);
          return () => undefined;
        };
      }
    }
    v.focus();
    return () => {
      controllers.delete(v);
      v.destroy();
      view.current = null;
    };
  }, [p.editor.session, vimKeys]);

  const modeText = MODES[mode] ?? '';
  return (
    <div className="editor-overlay" role="dialog" aria-label={`Editing ${req.path}`}>
      <div className="editor-head">
        <span className="editor-file" title={req.path}>
          {req.path}
          {dirty ? <span className="editor-dirty" title="Modified since the last write"> ●</span> : null}
        </span>
        {req.readOnly ? <span className="pill">read-only</span> : null}
        <span className="editor-help">
          {vimKeys ? (
            <>
              <kbd>:w</kbd> write <kbd>:q</kbd> quit <kbd>:wq</kbd> both <kbd>:q!</kbd> discard
            </>
          ) : (
            <>
              <kbd>Ctrl+S</kbd> save <kbd>Ctrl+X</kbd> close
            </>
          )}
        </span>
        {!vimKeys ? (
          <span className="editor-actions">
            <button type="button" className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => controllers.get(view.current as EditorView)?.write({ bang: true, thenClose: false })}>
              Save
            </button>
            <button type="button" className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => (dirty ? setConfirmClose(true) : p.close())}>
              Close
            </button>
          </span>
        ) : null}
      </div>
      <div className="editor-body" ref={host} />
      <div className="editor-status">
        <span className={line.error ? 'editor-msg is-error' : 'editor-msg'}>{modeText !== '' ? <strong>{modeText}</strong> : line.text}</span>
        <span className="editor-pos">{pos}</span>
      </div>
      {confirmClose ? (
        <div className="editor-confirm" role="alertdialog">
          <span>The file has changes that are not saved.</span>
          <button type="button" className="btn btn-small btn-primary" onClick={() => controllers.get(view.current as EditorView)?.write({ bang: true, thenClose: true })}>
            Save and close
          </button>
          <button type="button" className="btn btn-small" onClick={() => p.close()}>
            Discard changes
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setConfirmClose(false);
              view.current?.focus();
            }}
          >
            Keep editing
          </button>
        </div>
      ) : null}
    </div>
  );
}
