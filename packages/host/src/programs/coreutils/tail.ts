// tail — output the last part of files. GNU coreutils 9.4.
//   docs: tail --help and tail(1) of coreutils 9.4
//   upstream: coreutils src/tail.c (parse_obsolete_option, parse_options, tail_file, tail_forever,
//             recheck, write_header)
//   reference: coreutils 9.4 tail, captured 2026-11-16 (packages/host/transcripts/coreutils/tail.t;
//              follow-mode messages from the real tail in the background, see tail.test.ts)
//
// Following (-f, -F) reads the followed inode through the descriptor tail holds open and waits on
// the file-change topic. With one file followed by descriptor it wakes exactly when the file
// changes; otherwise it also re-checks every second, as tail does when it polls (its default
// --sleep-interval of 1.0), so a rename or a second file is noticed within a second.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getMachine } from '../../machine.ts';
import { utf8Length } from '../../utf8.ts';
import { isFsError, strerror, UnsupportedError, type FsError } from '../../vfs/errno.ts';
import { fileTopic, readInode } from '../../vfs/fs.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { warn } from '../lib/io.ts';
import { splitOctets } from '../lib/octets.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';
import { chooseArg, parseArgv, readSome, splitLines } from '../lib/textio.ts';
import { EOVERFLOW_TEXT, toCount, xstrtoumax } from '../lib/xstrtol.ts';

/** `tail --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: tail [OPTION]... [FILE]...\nPrint the last 10 lines of each FILE to standard output.\nWith more than one FILE, precede each with a header giving the file name.\n\nWith no FILE, or when FILE is -, read standard input.\n\nMandatory arguments to long options are mandatory for short options too.\n  -c, --bytes=[+]NUM       output the last NUM bytes; or use -c +NUM to\n                             output starting with byte NUM of each file\n  -f, --follow[={name|descriptor}]\n                           output appended data as the file grows;\n                             an absent option argument means 'descriptor'\n  -F                       same as --follow=name --retry\n  -n, --lines=[+]NUM       output the last NUM lines, instead of the last 10;\n                             or use -n +NUM to skip NUM-1 lines at the start\n      --max-unchanged-stats=N\n                           with --follow=name, reopen a FILE which has not\n                             changed size after N (default 5) iterations\n                             to see if it has been unlinked or renamed\n                             (this is the usual case of rotated log files);\n                             with inotify, this option is rarely useful\n      --pid=PID            with -f, terminate after process ID, PID dies\n  -q, --quiet, --silent    never output headers giving file names\n      --retry              keep trying to open a file if it is inaccessible\n  -s, --sleep-interval=N   with -f, sleep for approximately N seconds\n                             (default 1.0) between iterations;\n                             with inotify and --pid=P, check process P at\n                             least once every N seconds\n  -v, --verbose            always output headers giving file names\n  -z, --zero-terminated    line delimiter is NUL, not newline\n      --help        display this help and exit\n      --version     output version information and exit\n\nNUM may have a multiplier suffix:\nb 512, kB 1000, K 1024, MB 1000*1000, M 1024*1024,\nGB 1000*1000*1000, G 1024*1024*1024, and so on for T, P, E, Z, Y, R, Q.\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\n\nWith --follow (-f), tail defaults to following the file descriptor, which\nmeans that even if a tail'ed file is renamed, tail will continue to track\nits end.  This default behavior is not desirable when you really want to\ntrack the actual name of the file, not the file descriptor (e.g., log\nrotation).  Use --follow=name in that case.  That causes tail to track the\nnamed file in a way that accommodates renaming, removal and creation.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/tail>\nor available locally via: info '(coreutils) tail invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'bytes', arg: 'required' },
  { short: 'f', long: 'follow', arg: 'optional' },
  { short: 'F', id: 'F' },
  { short: 'n', long: 'lines', arg: 'required' },
  { long: 'max-unchanged-stats', arg: 'required', supported: false },
  { long: 'pid', arg: 'required', supported: false },
  { short: 'q', long: 'quiet', id: 'quiet' },
  { long: 'silent', id: 'quiet' },
  { long: 'retry', supported: false },
  { short: 's', long: 'sleep-interval', arg: 'required', supported: false },
  { short: 'v', long: 'verbose' },
  { short: 'z', long: 'zero-terminated', supported: false },
  { long: 'help' },
  { long: 'version' },
  ...[...'0123456789'].map((d): OptionSpec => ({ short: d, id: 'digit' })),
];

const SUFFIXES = 'bkKmMGTPEZYRQ0';
/** glibc strerror(ERANGE). reference: `tail -99999999999999999999999 a`, captured 2026-11-16 */
const ERANGE_TEXT = 'Numerical result out of range';

interface Settings {
  lines: boolean;
  n: number;
  fromStart: boolean;
  headers: 'auto' | 'always' | 'never';
  follow?: 'descriptor' | 'name';
  retry: boolean;
}

/** A file tail keeps following after its first output. */
interface Followed {
  name: string;
  shown: string;
  fd: number | undefined;
  ino: string | undefined;
  /** How much of the inode's text has been output (UTF-16 code units, as stored). */
  offset: number;
  /** "has become inaccessible" was reported and the file has not come back. */
  gone: boolean;
  /** Not a regular file: never read again. */
  untailable: boolean;
  dropped: boolean;
}

/**
 * upstream: tail.c parse_obsolete_option — `-NUM[bcl][f]` or `+NUM…` as the only option, before
 * at most one file operand.
 */
function obsolete(argv: string[], st: Settings): 'none' | 'ok' | { error: string } {
  const a = argv[0];
  const okShape = argv.length === 1 || (argv.length === 2 && !((argv[1] as string).startsWith('-') && (argv[1] as string).length > 1)) || ((argv.length === 2 || argv.length === 3) && argv[1] === '--');
  if (a === undefined || !okShape) return 'none';
  let i = 1;
  if (a[0] === '+') st.fromStart = true;
  else if (a[0] === '-') {
    // In the standard form "-" alone and "-c" are not obsolete options.
    if ((a[1] === 'c' ? a[2] : a[1]) === undefined) return 'none';
  } else return 'none';
  const digitsStart = i;
  while (i < a.length && (a[i] as string) >= '0' && (a[i] as string) <= '9') i++;
  const digitsEnd = i;
  let lines = true;
  let defaultCount = 10;
  if (a[i] === 'b') {
    defaultCount *= 512;
    lines = false;
    i++;
  } else if (a[i] === 'c') {
    lines = false;
    i++;
  } else if (a[i] === 'l') i++;
  let forever = false;
  if (a[i] === 'f') {
    forever = true;
    i++;
  }
  if (i < a.length) {
    if (a[0] === '+') st.fromStart = false;
    return 'none';
  }
  let n = defaultCount;
  if (digitsEnd > digitsStart) {
    // xstrtoumax(n_string, NULL, 10, &n, "b"), an invalid suffix character being ignored.
    const digits = a.slice(digitsStart, digitsEnd);
    const v = BigInt(digits) * (a[digitsEnd] === 'b' ? 512n : 1n);
    if (v >= 1n << 64n) return { error: `invalid number: ${quote(a)}: ${ERANGE_TEXT}` };
    n = toCount(v);
  }
  st.lines = lines;
  st.n = n;
  if (forever) st.follow = 'descriptor';
  return 'ok';
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const argv = p.argv.slice(1);
  const st: Settings = { lines: true, n: 10, fromStart: false, headers: 'auto', retry: false };
  const obs = obsolete(argv, st);
  if (typeof obs === 'object') {
    yield* warn(p, obs.error);
    return 1;
  }
  if (obs === 'ok') argv.shift();
  const args = yield* parseArgv(p, argv, { options: OPTIONS });
  if (typeof args === 'number') return args;
  for (const o of args.options) {
    switch (o.id) {
      case 'bytes':
      case 'lines': {
        st.lines = o.id === 'lines';
        let v = o.value as string;
        if (v.startsWith('+')) st.fromStart = true;
        else if (v.startsWith('-')) v = v.slice(1);
        const what = st.lines ? 'invalid number of lines' : 'invalid number of bytes';
        const r = xstrtoumax(v, SUFFIXES);
        if (r.kind !== 'ok') {
          yield* warn(p, r.kind === 'overflow' ? `${what}: ${quote(v)}: ${EOVERFLOW_TEXT}` : `${what}: ${quote(v)}`);
          return 1;
        }
        st.n = toCount(r.value);
        break;
      }
      case 'follow':
        if (o.value === undefined) st.follow = 'descriptor';
        else {
          // upstream: tail.c follow_mode_string, matched with argmatch.
          const r = yield* chooseArg(p, '--follow', o.value, [['descriptor', 'descriptor'], ['name', 'name']] as const);
          if (typeof r === 'number') return r;
          st.follow = r.value;
        }
        break;
      case 'F':
        st.follow = 'name';
        st.retry = true;
        break;
      case 'quiet':
        st.headers = 'never';
        break;
      case 'verbose':
        st.headers = 'always';
        break;
      case 'digit':
        // upstream: tail.c parse_options, no "Try" line.
        yield* warn(p, `option used in invalid context -- ${o.name.slice(1)}`);
        return 1;
      case 'help':
        yield* p.write(1, HELP);
        return 0;
      case 'version':
        return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
    }
  }
  // 'tail -n +0' is 'tail -n +1': skip N-1 items.
  if (st.fromStart && st.n > 0) st.n--;
  const files = args.operands.length > 0 ? args.operands : ['-'];
  // upstream: tail.c main, nothing is read when nothing would be output.
  if (st.n === 0 && st.follow === undefined && !st.fromStart) return 0;
  const headers = st.headers === 'always' || (st.headers === 'auto' && files.length > 1);

  let status = 0;
  let firstHeader = true;
  const header = function* (shown: string): Op<void> {
    yield* p.write(1, `${firstHeader ? '' : '\n'}==> ${shown} <==\n`);
    firstHeader = false;
  };
  const followed: Followed[] = [];
  let anyFollowable = false;
  let last: Followed | undefined;

  for (const name of files) {
    const shown = name === '-' ? 'standard input' : name;
    let fd: number;
    if (name === '-') fd = 0;
    else {
      try {
        fd = p.open(name, { read: true });
      } catch (e) {
        if (!isFsError(e)) throw e;
        yield* warn(p, `cannot open ${quoteaf(name)} for reading: ${strerror(e.code)}`);
        status = 1;
        if (st.follow !== undefined) {
          anyFollowable = true;
          // Only -F keeps trying a file it could not open.
          const keep = st.follow === 'name' && st.retry;
          followed.push({ name, shown, fd: undefined, ino: undefined, offset: 0, gone: true, untailable: false, dropped: !keep });
        }
        continue;
      }
    }
    const desc = p.fd(fd);
    if (st.follow !== undefined && name === '-' && desc?.kind === 'tty') {
      return yield* p.unsupported({ kind: 'behavior', what: 'following a terminal on standard input' });
    }
    if (headers) yield* header(shown);
    const entry: Followed = { name, shown, fd, ino: undefined, offset: 0, gone: false, untailable: false, dropped: false };
    try {
      yield* tailFd(p, fd, st);
      if (desc?.kind === 'file') {
        const ino = getMachine(p.ctx, p.machine).files[desc.file]?.inode;
        if (ino !== undefined) {
          entry.ino = ino;
          entry.offset = content(p, ino).length;
        }
      }
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* warn(p, `error reading ${quoteaf(shown)}: ${strerror(e.code)}`);
      status = 1;
      entry.untailable = true;
    }
    last = entry;
    if (st.follow === undefined || desc?.kind === 'stream') {
      if (fd !== 0) p.close(fd);
      continue;
    }
    anyFollowable = true;
    if (entry.untailable) {
      const giveUp = !(st.follow === 'name' && st.retry);
      yield* warn(p, `${quotef(shown)}: cannot follow end of this type of file${giveUp ? '; giving up on this name' : ''}`);
      entry.dropped = giveUp;
      if (fd !== 0) p.close(fd);
      entry.fd = undefined;
    }
    followed.push(entry);
  }
  if (st.follow === undefined || !anyFollowable) return status;
  return yield* follow(p, followed, st, headers, last, header);
}

/** The first output of one input: its last (or from-start) lines or bytes. */
function* tailFd(p: ProcApi, fd: number, st: Settings): Op<void> {
  if (st.fromStart) {
    // Skip N items, then copy the rest as it arrives.
    let skip = st.n;
    for (;;) {
      const chunk = yield* readSome(p, fd, st.lines && skip > 0 ? { line: true } : {});
      if (chunk === null) return;
      if (skip === 0) {
        yield* p.write(1, chunk);
        continue;
      }
      if (st.lines) {
        if (chunk.endsWith('\n')) skip--;
        continue;
      }
      const size = utf8Length(chunk);
      if (size <= skip) {
        skip -= size;
        continue;
      }
      yield* p.write(1, splitOctets(chunk, skip)[1]);
      skip = 0;
    }
  }
  let data = '';
  for (;;) {
    const chunk = yield* readSome(p, fd);
    if (chunk === null) break;
    data += chunk;
  }
  yield* p.write(1, lastPart(data, st));
}

function lastPart(data: string, st: Settings): string {
  if (st.n === 0) return '';
  if (st.lines) {
    const lines = splitLines(data);
    return lines.slice(Math.max(0, lines.length - st.n)).join('');
  }
  const size = utf8Length(data);
  return size <= st.n ? data : splitOctets(data, size - st.n)[1];
}

/** The text of an inode tail holds open, read as through its descriptor. */
function content(p: ProcApi, ino: string): string {
  try {
    return readInode(p.ctx, getMachine(p.ctx, p.machine), ino);
  } catch (e) {
    if (e instanceof UnsupportedError || isFsError(e)) return '';
    throw e;
  }
}

function* follow(
  p: ProcApi,
  files: Followed[],
  st: Settings,
  headers: boolean,
  lastShown: Followed | undefined,
  header: (shown: string) => Op<void>,
): Op<number> {
  let last = lastShown;
  const byName = st.follow === 'name';
  for (;;) {
    for (const f of files) {
      if (f.dropped) continue;
      if (byName) {
        const r = yield* recheck(p, f, st);
        if (r === 'skip') continue;
      }
      if (f.ino === undefined || f.untailable) continue;
      const text = content(p, f.ino);
      if (text.length < f.offset) {
        yield* warn(p, `${quotef(f.shown)}: file truncated`);
        f.offset = 0;
      }
      if (text.length > f.offset) {
        if (headers && last !== f) yield* header(f.shown);
        yield* p.write(1, text.slice(f.offset));
        f.offset = text.length;
        last = f;
      }
    }
    const live = files.filter((f) => !f.dropped);
    if (live.length === 0) {
      yield* warn(p, 'no files remaining');
      return 1;
    }
    const watched = live.find((f) => f.ino !== undefined && !f.untailable);
    if (watched?.ino === undefined) yield* p.sleep(1000);
    else if (!byName && live.length === 1) yield* p.wait(fileTopic(p.machine, watched.ino));
    else yield* p.wait(fileTopic(p.machine, watched.ino), 1000);
  }
}

/** --follow=name: notices the name now pointing at another file, or at none. upstream: tail.c recheck */
function* recheck(p: ProcApi, f: Followed, st: Settings): Op<'ok' | 'skip'> {
  let ino: string;
  try {
    const s = p.fs().stat(f.name);
    ino = s.ino;
  } catch (e) {
    if (!isFsError(e)) throw e;
    if (!f.gone) {
      // reference: real tail — -F reports the name as inaccessible and keeps trying;
      // --follow=name alone prints the error and gives the name up.
      const why = strerror((e as FsError).code);
      yield* warn(p, st.retry ? `${quoteaf(f.shown)} has become inaccessible: ${why}` : `${quotef(f.shown)}: ${why}`);
      f.gone = true;
      if (f.fd !== undefined) p.close(f.fd);
      f.fd = undefined;
      f.ino = undefined;
      if (!st.retry) f.dropped = true;
    }
    return 'skip';
  }
  if (ino === f.ino) return 'ok';
  let fd: number;
  try {
    fd = p.open(f.name, { read: true });
  } catch (e) {
    if (!isFsError(e)) throw e;
    return 'skip';
  }
  const appeared = f.ino === undefined;
  yield* warn(p, `${quoteaf(f.shown)} has ${appeared ? 'appeared' : 'been replaced'};  following new file`);
  if (f.fd !== undefined) p.close(f.fd);
  f.fd = fd;
  f.ino = ino;
  f.offset = 0;
  f.gone = false;
  f.untailable = p.fs().stat(f.name).type !== 'file';
  if (f.untailable) yield* warn(p, `${quotef(f.shown)}: cannot follow end of this type of file`);
  return 'ok';
}

export const tailProgram: ProgramSpec = { name: 'tail', main };
