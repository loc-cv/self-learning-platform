// The editor kubectl edit runs: chosen from KUBE_EDITOR, then EDITOR, else vi; a value with a space
// is split at spaces, or, with a quote or a backslash in it, run through `$SHELL -c` (default
// /bin/bash) with the file appended in Go's %q. The editor is a child process found on PATH
// (os/exec LookPath), on the same terminal, and kubectl waits for it.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/editor/editor.go defaultEnvEditor,
//             defaultEnvShell, LaunchTempFile (os.CreateTemp("", "kubectl-edit-*.yaml"));
//             launcher_others.go args, Launch ("unable to launch the editor %q" when the program is
//             not found, "there was a problem with the editor %q" when it fails or exits non-zero)
//   upstream: .upstream/go src/os/exec/lp_unix.go LookPath, findExecutable (a regular file with an
//             execute bit; an empty PATH entry is "."); src/os/tempfile.go CreateTemp, nextRandom (a
//             decimal uint32), os.TempDir ($TMPDIR, else /tmp)

import type { Op, ProcApi } from '@simlab/host';
import { FsError, type Inode } from '@simlab/host';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote } from '../../cli/flagset.ts';

export interface Editor {
  args: string[];
  shell: boolean;
}

/** NewDefaultEditor(["KUBE_EDITOR", "EDITOR"]) */
export function defaultEditor(env: Readonly<Record<string, string>>): Editor {
  let editor = '';
  for (const name of ['KUBE_EDITOR', 'EDITOR']) {
    editor = env[name] ?? '';
    if (editor.length > 0) break;
  }
  if (editor.length === 0) editor = 'vi';
  if (!editor.includes(' ')) return { args: [editor], shell: false };
  if (!/["'\\]/.test(editor)) return { args: editor.split(' '), shell: false };
  const shell = env.SHELL ?? '';
  return { args: [shell.length > 0 ? shell : '/bin/bash', '-c', editor], shell: true };
}

/** Editor.args: the command line for a file. */
function argsFor(e: Editor, path: string): string[] {
  const args = [...e.args];
  if (e.shell) args[args.length - 1] = `${args[args.length - 1] as string} ${goQuote(path)}`;
  else args.push(path);
  return args;
}

/** exec.LookPath: the path to run, or undefined (exec.ErrNotFound). */
function lookPath(p: ProcApi, file: string): string | undefined {
  if (file.includes('/')) return file;
  const fs = p.fs();
  for (const dir of (p.env.PATH ?? '').split(':')) {
    const path = `${dir === '' ? '.' : dir}/${file}`;
    try {
      const st = fs.stat(path);
      if (st.type !== 'dir' && (st.mode & 0o111) !== 0) return path;
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
    }
  }
  return undefined;
}

/** What execve(2) runs for a path: a program stub, or a `#!` script's interpreter. */
function execTarget(p: ProcApi, path: string, argv: string[]): { program: string; argv: string[] } | undefined {
  const fs = p.fs();
  let ino: Inode;
  try {
    ino = fs.checkExec(path);
  } catch (e) {
    if (e instanceof FsError) return undefined;
    throw e;
  }
  if (ino.type === 'program') return { program: ino.program, argv };
  if (ino.type !== 'file' || !ino.data.startsWith('#!')) return undefined;
  const line = (ino.data.slice(2).split('\n')[0] ?? '').trim();
  const m = /^(\S+)(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return undefined;
  let interp: Inode;
  try {
    interp = fs.checkExec(m[1] as string);
  } catch (e) {
    if (e instanceof FsError) return undefined;
    throw e;
  }
  if (interp.type !== 'program') return undefined;
  return { program: interp.program, argv: [m[1] as string, ...(m[2] ? [m[2]] : []), path, ...argv.slice(1)] };
}

/** Editor.Launch: undefined when the editor exited 0, else the error. */
export function* launch(p: ProcApi, e: Editor, path: string): Op<KubectlError | undefined> {
  const shown = e.args.join(' ');
  const args = argsFor(e, path);
  const found = lookPath(p, args[0] as string);
  if (found === undefined) return messageError(`unable to launch the editor ${goQuote(shown)}`);
  const target = execTarget(p, found, args);
  if (!target) return messageError(`there was a problem with the editor ${goQuote(shown)}`);
  const pid = p.spawn({ program: target.program, argv: target.argv, env: { ...p.env } });
  const status = yield* p.waitpid(pid);
  if (!('code' in status) || status.code !== 0) return messageError(`there was a problem with the editor ${goQuote(shown)}`);
  return undefined;
}

/** os.CreateTemp(os.TempDir(), "<prefix>*<suffix>"): the new file's path (mode 0600, empty). */
export function createTemp(p: ProcApi, prefix: string, suffix: string, content: string): string | KubectlError {
  const tmp = p.env.TMPDIR ?? '';
  const dir = tmp !== '' ? tmp : '/tmp';
  const rnd = p.random('kubectl.edit.tempfile');
  for (let i = 0; i < 10000; i++) {
    const path = `${dir}/${prefix}${String(rnd.int(2 ** 32))}${suffix}`;
    try {
      const fd = p.open(path, { write: true, create: true, exclusive: true, mode: 0o600 });
      p.close(fd);
      p.fs().writeFile(path, content);
      return path;
    } catch (err) {
      if (err instanceof FsError && err.code === 'EEXIST') continue;
      if (err instanceof FsError) return { type: 'notSimulated', what: `kubectl edit when its temporary file cannot be created (${err.code} in ${dir})` };
      throw err;
    }
  }
  return messageError(`createtemp ${dir}/${prefix}*${suffix}: file already exists`);
}
