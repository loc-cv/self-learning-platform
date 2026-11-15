// touch — change file timestamps. GNU coreutils 9.4.
//   docs: touch --help and touch(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/touch.c main, touch
//   reference: coreutils 9.4 touch, captured 2026-11-16 (packages/host/transcripts/coreutils/touch.t)
// The VFS keeps a modification and a change time but no access time, so changing only the access
// time (-a, --time=atime) has no model and gets the notice; -m is exact. Symbolic links' own
// times (-h on a link) are not modeled either.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, UnsupportedError, type Errno } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt } from '../lib/fsutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quote, quoteaf } from '../lib/quote.ts';
import { parseTouchDate, parseTouchStamp } from '../lib/touchdate.ts';

/** `touch --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: touch [OPTION]... FILE...\nUpdate the access and modification times of each FILE to the current time.\n\nA FILE argument that does not exist is created empty, unless -c or -h\nis supplied.\n\nA FILE argument string of - is handled specially and causes touch to\nchange the times of the file associated with standard output.\n\nMandatory arguments to long options are mandatory for short options too.\n  -a                     change only the access time\n  -c, --no-create        do not create any files\n  -d, --date=STRING      parse STRING and use it instead of current time\n  -f                     (ignored)\n  -h, --no-dereference   affect each symbolic link instead of any referenced\n                         file (useful only on systems that can change the\n                         timestamps of a symlink)\n  -m                     change only the modification time\n  -r, --reference=FILE   use this file's times instead of current time\n  -t STAMP               use [[CC]YY]MMDDhhmm[.ss] instead of current time\n      --time=WORD        change the specified time:\n                           WORD is access, atime, or use: equivalent to -a\n                           WORD is modify or mtime: equivalent to -m\n      --help        display this help and exit\n      --version     output version information and exit\n\nNote that the -d and -t options accept different time-date formats.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/touch>\nor available locally via: info '(coreutils) touch invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', id: 'a' },
  { short: 'c', long: 'no-create' },
  { short: 'd', long: 'date', arg: 'required' },
  { short: 'f', id: 'f' },
  { short: 'h', long: 'no-dereference' },
  { short: 'm', id: 'm' },
  { short: 'r', long: 'reference', arg: 'required' },
  { short: 't', id: 't', arg: 'required' },
  { long: 'time', arg: 'required' },
  { long: 'help' },
  { long: 'version' },
];

const ATIME = 1;
const MTIME = 2;

/** --time's words. upstream: touch.c time_args, time_masks */
const TIME_ARGS: [string, number][] = [
  ['atime', ATIME],
  ['access', ATIME],
  ['use', ATIME],
  ['mtime', MTIME],
  ['modify', MTIME],
];

/** argmatch: an exact word, or an abbreviation all of whose matches mean the same. */
function matchTime(arg: string): number | undefined {
  const exact = TIME_ARGS.find(([w]) => w === arg);
  if (exact) return exact[1];
  const cands = TIME_ARGS.filter(([w]) => w.startsWith(arg));
  if (cands.length === 0 || arg === '') return undefined;
  const v = (cands[0] as [string, number])[1];
  return cands.every(([, x]) => x === v) ? v : undefined;
}

/**
 * open(O_WRONLY|O_CREAT). The VFS refuses to open an executable stub or a generated file for
 * writing after its checks pass; touch writes nothing, so that counts as opened.
 */
function openForTouch(fs: Fs, file: string): void {
  try {
    fs.open(file, { write: true, create: true, mode: 0o666 });
  } catch (e) {
    if (!(e instanceof UnsupportedError)) throw e;
  }
}

/** Local time is UTC on the simulated machines; another TZ has no model yet. */
const utcTz = (tz: string | undefined): boolean => tz === undefined || /^:?(UTC0?|Etc\/UTC|UTC\+?0|GMT0?|Etc\/GMT|Universal|Zulu)?$/.test(tz);

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let change = 0;
  let noCreate = false;
  let noDeref = false;
  let flexDate: string | undefined;
  let refFile: string | undefined;
  let stamp: number | undefined;
  for (const o of args.options) {
    switch (o.id) {
      case 'a':
        change |= ATIME;
        break;
      case 'm':
        change |= MTIME;
        break;
      case 'no-create':
        noCreate = true;
        break;
      case 'no-dereference':
        noDeref = true;
        break;
      case 'date':
        flexDate = o.value as string;
        break;
      case 'reference':
        refFile = o.value as string;
        break;
      case 't': {
        const t = parseTouchStamp(o.value as string, p.now);
        if (t === null) {
          yield* warn(p, `invalid date format ${quote(o.value as string)}`);
          return 1;
        }
        stamp = t;
        break;
      }
      case 'time': {
        const v = matchTime(o.value as string);
        if (v === undefined) {
          // argmatch's diagnostic. reference: coreutils 9.4 touch --time=x, captured 2026-11-16
          const valid = 'Valid arguments are:\n  - ‘atime’, ‘access’, ‘use’\n  - ‘mtime’, ‘modify’';
          yield* p.write(2, `${p.name}: invalid argument ${quote(o.value as string)} for ${quote('--time')}\n${valid}\n`);
          yield* p.write(2, `Try '${p.name} --help' for more information.\n`);
          return 1;
        }
        change |= v;
        break;
      }
    }
  }
  if (change === 0) change = ATIME | MTIME;
  if (stamp !== undefined && (refFile !== undefined || flexDate !== undefined)) {
    return yield* usageError(p, 'cannot specify times from more than one source');
  }
  if (change === ATIME) return yield* p.unsupported({ kind: 'behavior', what: 'changing only the access time', hints: ['access times are not modeled; -m and the default change the modification time'] });
  if ((flexDate !== undefined || stamp !== undefined) && !utcTz(p.env['TZ'])) {
    return yield* p.unsupported({ kind: 'behavior', what: `local time in the time zone ${p.env['TZ'] as string}` });
  }
  const fs = p.fs();
  let time: number | undefined = stamp;
  if (refFile !== undefined) {
    const ref = refFile;
    const st = attempt(() => (noDeref ? fs.lstat(ref) : fs.stat(ref)));
    if (!st.ok) {
      yield* warn(p, `failed to get attributes of ${quoteaf(ref)}: ${strerror(st.code)}`);
      return 1;
    }
    time = st.value.mtime;
  }
  if (flexDate !== undefined) {
    const d = parseTouchDate(flexDate);
    if (!d.ok && 'invalid' in d) {
      yield* warn(p, `invalid date format ${quote(flexDate)}`);
      return 1;
    }
    if (!d.ok) return yield* p.unsupported({ kind: 'behavior', what: `the date string ${quote(flexDate)}`, hints: ["supported: 'YYYY-MM-DD [HH:MM[:SS]]', 'YYYY-MM-DDTHH:MM:SS[Z]', '@EPOCH'"] });
    time = d.ms;
  }
  if (args.operands.length === 0) return yield* usageError(p, 'missing file operand');

  // Checked before any file is touched, so a notice never follows a partial run.
  for (const file of args.operands) {
    if (file === '-') return yield* p.unsupported({ kind: 'behavior', what: 'the operand - (the file on standard output)' });
    if (noDeref) {
      const l = attempt(() => fs.lstat(file));
      if (l.ok && l.value.type === 'symlink') return yield* p.unsupported({ kind: 'behavior', what: 'changing the times of a symbolic link itself (-h)' });
    }
  }
  let ok = true;
  for (const file of args.operands) {
    let openErr: Errno | undefined;
    if (!(noCreate || noDeref)) {
      const o = attempt(() => openForTouch(fs, file));
      // open(2) with O_CREAT fails with EISDIR on any name that ends in a slash.
      if (!o.ok) openErr = /\/$/.test(file) ? 'EISDIR' : o.code;
    }
    const t = time;
    const u = attempt(() => fs.utimes(file, t));
    if (u.ok) continue;
    let dirFallback = false;
    if (openErr === 'EINVAL') {
      const st = attempt(() => fs.stat(file));
      dirFallback = st.ok && st.value.type === 'dir';
    }
    if (openErr !== undefined && openErr !== 'EISDIR' && !dirFallback) {
      yield* warn(p, `cannot touch ${quoteaf(file)}: ${strerror(openErr)}`);
    } else {
      if (noCreate && u.code === 'ENOENT') continue;
      yield* warn(p, `setting times of ${quoteaf(file)}: ${strerror(u.code)}`);
    }
    ok = false;
  }
  return ok ? 0 : 1;
}

export const touchProgram: ProgramSpec = { name: 'touch', main };
