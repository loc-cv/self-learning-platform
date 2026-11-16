// vim (vim.basic and vim.tiny, also run as vi and view) and nano: they open the file in the front
// end's editor through the editor protocol (proc/editor.ts, docs/ARCHITECTURE.md §3.8) instead of
// drawing on the terminal. The web UI shows an editor overlay; the terminal player opens the
// real $EDITOR; headless runs supply the new content. Editing one named file is what is simulated;
// every option, several files, no file, a directory and no terminal print the notice.
//   docs: vim(1) and nano(1) of vim 9.1 and nano 7.2 (Ubuntu 24.04): `view` starts in read-only
//         mode; vim and nano open a file that does not exist as a new, empty buffer
//   reference: vim.tiny 9.1 and nano 7.2 with TERM=xterm-256color switch to the alternate screen
//         (`ESC [?1049h`) and back when they exit (`ESC [?1049l`), so they leave nothing on the
//         terminal; checked on a pty 2026-11-16

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { languageOf, type EditorRequest } from '../../proc/editor.ts';
import { isFsError } from '../../vfs/errno.ts';
import { ACCESS } from '../../vfs/fs.ts';

function absolute(cwd: string, path: string): string {
  if (path.startsWith('/')) return path;
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

function* edit(p: ProcApi, flavor: EditorRequest['flavor'], viewOnly: boolean): Generator<Syscall, number, unknown> {
  const name = p.name;
  const args = p.argv.slice(1);
  let files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    if ((a.startsWith('-') && a !== '-') || a.startsWith('+')) {
      return yield* p.unsupported({ kind: 'flag', what: `the option ${a}` });
    }
    files.push(a);
  }
  files = files.filter((f) => f !== '');
  if (files.length === 0) return yield* p.unsupported({ kind: 'behavior', what: `${name} without a file name`, hints: [`give the file to edit: ${name} FILE`] });
  if (files.length > 1) return yield* p.unsupported({ kind: 'behavior', what: `editing several files at once` });
  if (files[0] === '-') return yield* p.unsupported({ kind: 'behavior', what: `editing standard input` });
  if (!p.isatty(0) || !p.isatty(1)) return yield* p.unsupported({ kind: 'behavior', what: `${name} without a terminal` });
  const given = files[0] as string;
  const path = absolute(p.cwd, given);
  const fs = p.fs();
  let content = '';
  let readOnly = viewOnly;
  let exists = true;
  try {
    const st = fs.stat(path);
    if (st.type === 'dir') return yield* p.unsupported({ kind: 'behavior', what: `editing a directory` });
  } catch (e) {
    if (!isFsError(e, 'ENOENT')) throw e;
    exists = false;
  }
  if (exists) {
    try {
      content = fs.readFile(path);
    } catch (e) {
      if (isFsError(e, 'EACCES')) return yield* p.unsupported({ kind: 'behavior', what: `opening a file this user cannot read` });
      throw e;
    }
  }
  try {
    fs.access(exists ? path : parentOf(path), ACCESS.W_OK);
  } catch {
    readOnly = true;
  }
  const req: EditorRequest = { flavor, path, name: given, content, readOnly };
  if (!exists) req.isNew = true;
  const language = languageOf(path);
  if (language !== undefined) req.language = language;
  yield* p.openEditor(req);
  return 0;
}

/** Names under which the vim binaries run something other than the editor on one file. */
const VIM_MODES: Record<string, string> = {
  ex: 'Ex mode',
  rvim: 'restricted mode (rvim)',
  rview: 'restricted mode (rview)',
  vimdiff: 'diff mode (vimdiff)',
};

export const vimProgram: ProgramSpec = {
  name: 'vim',
  *main(p) {
    const mode = VIM_MODES[p.name];
    if (mode !== undefined) return yield* p.unsupported({ kind: 'behavior', what: `vim's ${mode}` });
    return yield* edit(p, 'vim', p.name === 'view');
  },
};

export const nanoProgram: ProgramSpec = {
  name: 'nano',
  *main(p) {
    return yield* edit(p, 'nano', false);
  },
};

export const PROGRAMS_EDITORS: ProgramSpec[] = [vimProgram, nanoProgram];
