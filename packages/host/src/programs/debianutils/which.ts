// which — locate a command. debianutils 5.17: on Ubuntu a /bin/sh script, simulated as a program
// that does what the script does.
//   reference: /usr/bin/which.debianutils of debianutils 5.17build1 on the workstation (read
//              2026-11-16) and its output, captured 2026-11-16 (packages/host/transcripts/debianutils/which.t)
// For each name: one with a slash is printed if it is a regular executable file; otherwise each
// PATH entry is tried (an empty one is `.`) and the first match printed, or every match with -a.
// Nothing is printed for a name not found; the status is 1 if any was not found (or none given).
// Options are parsed by dash's getopts, whose messages these are.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { isFsError } from '../../vfs/errno.ts';

/** `[ -f "$1" ] && [ -x "$1" ]` as dash's test evaluates them (stat, then access(X_OK)). */
function isExecutableFile(p: ProcApi, path: string): boolean {
  try {
    const fs = p.fs();
    if (fs.stat(path).type !== 'file') return false;
    fs.access(path, 1);
    return true;
  } catch (e) {
    if (isFsError(e)) return false;
    throw e;
  }
}

/**
 * `IFS=:; for ELEMENT in $PATH`: each colon ends a field and a final empty field is dropped,
 * which is why the script first appends a colon to a PATH ending in one (`*[!:]:`).
 */
function pathElements(path: string): string[] {
  let s = path;
  if (/[^:]:$/.test(s)) s += ':';
  const fields = s.split(':');
  if (fields[fields.length - 1] === '') fields.pop();
  return fields;
}

/**
 * The script's $0, which its usage line prints: the path the shell executed. A name without a
 * slash was found through PATH, so it is the first match there.
 */
function scriptPath(p: ProcApi): string {
  const a0 = p.argv[0] ?? 'which';
  if (a0.includes('/')) return a0;
  for (const dir of pathElements(p.env['PATH'] ?? '')) {
    const full = `${dir === '' ? '.' : dir}/${a0}`;
    if (isExecutableFile(p, full)) return full;
  }
  return a0;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const argv = p.argv.slice(1);
  let all = false;
  let silent = false;
  let i = 0;
  // getopts as: option clusters until the first operand or `--`.
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (const ch of a.slice(1)) {
      if (ch === 'a') all = true;
      else if (ch === 's') silent = true;
      else {
        yield* p.write(2, `Illegal option -${ch}\n`);
        if (!silent) yield* p.write(1, `Usage: ${scriptPath(p)} [-as] args\n`);
        return 2;
      }
    }
  }
  const names = argv.slice(i);
  let status = names.length === 0 ? 1 : 0;
  let out = '';
  const elements = pathElements(p.env['PATH'] ?? '');
  for (const name of names) {
    let found = false;
    if (name.includes('/')) {
      if (isExecutableFile(p, name)) {
        out += `${name}\n`;
        found = true;
      }
    } else {
      for (const el of elements) {
        const full = `${el === '' ? '.' : el}/${name}`;
        if (isExecutableFile(p, full)) {
          out += `${full}\n`;
          found = true;
          if (!all) break;
        }
      }
    }
    if (!found) status = 1;
  }
  if (!silent) yield* p.write(1, out);
  return status;
}

export const whichProgram: ProgramSpec = { name: 'which', main };
