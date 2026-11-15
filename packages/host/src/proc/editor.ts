// The editor protocol (docs/ARCHITECTURE.md §3.8). `vim`, `vi`, `nano` and later `kubectl edit`
// do not draw a terminal UI: they ask the front end to edit a file's content. The request leaves
// through the output port; the front end answers with `editor.save` inputs (each one writes the
// file with the program's credentials) and one `editor.close`, which resumes the program. Both
// inputs carry everything, so a replay needs no front end, and headless runs answer in the same
// two inputs.

import { put, remove, type Ctx, type Json } from '@simlab/kernel';
import { getMachine, hostSlice } from '../machine.ts';
import { isFsError } from '../vfs/errno.ts';
import { createFs } from '../vfs/fs.ts';

export interface EditorRequest {
  /** As the program was invoked: decides key bindings in the UI. */
  flavor: 'vim' | 'nano';
  /** Absolute path of the file. */
  path: string;
  /** The file name as given on the command line: what the editor calls the buffer. */
  name: string;
  /** The file's content when the editor opens (empty for a new file). */
  content: string;
  /** The file cannot be written by this user, or the program was asked to view only. */
  readOnly: boolean;
  /** Highlighting hint from the file name: `yaml`, `json`, `shell`, … */
  language?: string;
}

export interface EditorResult {
  /** At least one save was written. */
  saved: boolean;
}

/** An open editor session: world data, so a snapshot or replay keeps it. */
export interface EditorSession {
  id: string;
  machine: string;
  pid: string;
  tty?: string;
  path: string;
  name: string;
  state: 'open' | 'closed';
  saved: boolean;
}

export const editorTopic = (id: string): string => `host.editor:${id}`;

/** Starts a session for a blocked `openEditor` call and sends the request out. */
export function openEditorSession(ctx: Ctx, machine: string, pid: string, req: EditorRequest): string {
  const id = `ed${ctx.nextId('host.editor')}`;
  const p = getMachine(ctx, machine).procs[pid];
  const session: EditorSession = { id, machine, pid, path: req.path, name: req.name, state: 'open', saved: false };
  if (p?.tty !== undefined) session.tty = p.tty;
  put(hostSlice(ctx).editors, id, session);
  const record = { kind: 'editor.open' as const, session: id, request: req as unknown as Json };
  ctx.output(session.tty !== undefined ? { ...record, tty: session.tty } : record);
  return id;
}

/** What the program's `openEditor` returns once the session is closed, or undefined while open. */
export function takeEditorResult(ctx: Ctx, id: string): EditorResult | undefined {
  const s = hostSlice(ctx).editors[id];
  if (!s) return { saved: false };
  if (s.state === 'open') return undefined;
  remove(hostSlice(ctx).editors, id);
  return { saved: s.saved };
}

function live(ctx: Ctx, id: string): EditorSession | undefined {
  const s = hostSlice(ctx).editors[id];
  if (!s || s.state !== 'open') return undefined;
  const p = getMachine(ctx, s.machine).procs[s.pid];
  if (!p || p.state !== 'running') {
    remove(hostSlice(ctx).editors, id);
    return undefined;
  }
  return s;
}

/**
 * `editor.save`: writes the file as the program's process would (its credentials, working
 * directory and umask); a failure goes back to the front end in the words vim uses.
 *   reference: vim 9.1 (vim.tiny 2:9.1.0016-1ubuntu7.20) `:w ro/f` in a directory the user cannot
 *   write prints `"ro/f" E212: Can't open file for writing`, captured 2026-11-16
 */
export function editorSave(ctx: Ctx, id: string, content: string): void {
  const s = live(ctx, id);
  if (!s) return;
  const p = getMachine(ctx, s.machine).procs[s.pid];
  if (!p) return;
  const fs = createFs(ctx, s.machine, { cred: { uid: p.uid, gid: p.gid, groups: p.groups }, cwd: p.cwd, umask: p.umask });
  try {
    fs.writeFile(s.path, content);
  } catch (e) {
    if (!isFsError(e)) throw e;
    ctx.output({ kind: 'editor.status', session: id, ok: false, message: `"${s.name}" E212: Can't open file for writing` });
    return;
  }
  put(hostSlice(ctx).editors, id, { ...s, saved: true });
  ctx.output({ kind: 'editor.status', session: id, ok: true });
}

/** `editor.close`: the program continues. */
export function editorClose(ctx: Ctx, id: string): void {
  const s = live(ctx, id);
  if (!s) return;
  put(hostSlice(ctx).editors, id, { ...s, state: 'closed' });
  ctx.publish(editorTopic(id));
}

/** A highlighting hint from a file name. */
export function languageOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  const byExt: Record<string, string> = { yaml: 'yaml', yml: 'yaml', json: 'json', sh: 'shell', bash: 'shell', py: 'python', conf: 'properties', ini: 'properties', toml: 'toml', md: 'markdown', service: 'properties' };
  if (byExt[ext]) return byExt[ext];
  if (base === '.bashrc' || base === '.profile' || base === '.bash_aliases') return 'shell';
  return undefined;
}
