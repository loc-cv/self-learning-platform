// execvp(3): how a program runs another one by name. A name with a slash is executed as it is;
// otherwise each PATH entry is tried in order (an empty entry is the working directory, an unset
// PATH is confstr(_CS_PATH), "/bin:/usr/bin"). EACCES from an entry is remembered and the search
// goes on; ENOENT and ENOTDIR go on silently; a file the kernel refuses with ENOEXEC runs as
// `/bin/sh FILE ARGS`.
//   docs: exec(3) "Special semantics for execlp() and execvp()" (man-pages 6.7 on the workstation)

import type { ProcApi } from '../../proc/program.ts';
import { resolveExec, type ExecTarget } from '../../proc/exec.ts';
import type { Errno } from '../../vfs/errno.ts';

export type ExecvpResult = { ok: true; program: string; argv: string[] } | { ok: false; code: Errno };

function target(t: ExecTarget, p: ProcApi): ExecvpResult | undefined {
  if (t.kind === 'program') return { ok: true, program: t.program, argv: t.argv };
  if (t.kind === 'noexec') {
    const sh = resolveExec(p.fs(), '/bin/sh', ['/bin/sh', t.path, ...t.argv.slice(1)]);
    return sh.kind === 'program' ? { ok: true, program: sh.program, argv: sh.argv } : { ok: false, code: 'ENOEXEC' };
  }
  if (t.kind === 'bad-interpreter') return { ok: false, code: t.code === 'EACCES' ? 'EACCES' : 'ENOENT' };
  return undefined;
}

/** Resolves `file` the way execvp(3) would, without replacing the process. */
export function execvp(p: ProcApi, file: string, argv: readonly string[], env: Readonly<Record<string, string>>): ExecvpResult {
  if (file === '') return { ok: false, code: 'ENOENT' };
  if (file.includes('/')) {
    const t = resolveExec(p.fs(), file, argv);
    return target(t, p) ?? { ok: false, code: (t as { code: Errno }).code };
  }
  const path = env['PATH'] ?? '/bin:/usr/bin';
  let eacces = false;
  for (const dir of path.split(':')) {
    const full = `${dir === '' ? '.' : dir}/${file}`;
    const t = resolveExec(p.fs(), full, argv);
    const r = target(t, p);
    if (r) return r;
    const code = (t as { code: Errno }).code;
    if (code === 'EACCES') eacces = true;
    else if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, code };
  }
  return { ok: false, code: eacces ? 'EACCES' : 'ENOENT' };
}
