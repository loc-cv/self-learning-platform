// ls — list directory contents. GNU coreutils 9.4.
//   docs: ls --help and ls(1) of coreutils 9.4
//   upstream: coreutils src/ls.c main, decode_switches, gobble_file, print_dir,
//             extract_dirs_from_files, file_ignored, file_failure
//   reference: coreutils 9.4 ls, captured 2026-11-16 (packages/host/transcripts/coreutils/ls*.t)
//
// Modeling choices (docs/COVERAGE.md):
// - Allocated blocks (-s, `total`) are derived from sizes as ext4 with 4 KiB blocks allocates
//   them: a regular file takes ceil(size / 4096) blocks of 8 sectors, a directory one block, a
//   symbolic link none while its target is shorter than 60 bytes (a "fast" symlink stored in the
//   inode) and one block otherwise, a device none. The VFS allocates no blocks itself.
// - "Directory order" (-U, -f) is the simulated file system's order, which is name order.
// - Times are shown in UTC, the simulated machines' zone; another TZ prints the notice.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getMachine } from '../../machine.ts';
import { groupByGid, userByUid } from '../../users.ts';
import { isFsError, strerror, type Errno } from '../../vfs/errno.ts';
import type { DirInode, Stat } from '../../vfs/types.ts';
import { globMatch, type PatChar } from '../../shell/glob.ts';
import { argmatch, argmatchError, type ArgChoice } from '../lib/argmatch.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { parseBlockSize, type HumanOptions } from '../lib/human.ts';
import { parseArgs } from '../lib/io.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';
import { isColored, setupColors } from './ls-color.ts';
import { accumulateWidths, fileNameWidth, modeOf, needsQuoting, printFiles, quoteName, restoreColor, totalLine, type LsWorld, type Out } from './ls-format.ts';
import { LS_HELP } from './ls-help.ts';
import { QUOTING_STYLES, type QuotingStyle } from './ls-quote.ts';
import { sortEntries, type SortKey } from './ls-sort.ts';
import { LOCALE_FORMATS, parseTimeStyle } from './ls-time.ts';
import { emptyWidths, type Deref, type FileInfo, type FileType, type Format, type IndicatorStyle, type Listing, type LsConfig } from './ls-types.ts';

// Long options in the order of ls.c's long_options, which is the order getopt lists ambiguous
// abbreviations in; then the options that are only short.
const OPTIONS: OptionSpec[] = [
  { short: 'a', long: 'all' },
  { short: 'b', long: 'escape' },
  { short: 'd', long: 'directory' },
  { short: 'D', long: 'dired', supported: false },
  { long: 'full-time' },
  { long: 'group-directories-first' },
  { short: 'h', long: 'human-readable' },
  { short: 'i', long: 'inode' },
  { short: 'k', long: 'kibibytes' },
  { short: 'n', long: 'numeric-uid-gid' },
  { short: 'G', long: 'no-group' },
  { short: 'q', long: 'hide-control-chars' },
  { short: 'r', long: 'reverse' },
  { short: 's', long: 'size' },
  { short: 'w', long: 'width', arg: 'required' },
  { short: 'A', long: 'almost-all' },
  { short: 'B', long: 'ignore-backups' },
  { long: 'classify', arg: 'optional' },
  { long: 'file-type' },
  { long: 'si' },
  { short: 'H', long: 'dereference-command-line' },
  { long: 'dereference-command-line-symlink-to-dir' },
  { long: 'hide', arg: 'required' },
  { short: 'I', long: 'ignore', arg: 'required' },
  { long: 'indicator-style', arg: 'required' },
  { short: 'L', long: 'dereference' },
  { short: 'N', long: 'literal' },
  { short: 'Q', long: 'quote-name' },
  { long: 'quoting-style', arg: 'required' },
  { short: 'R', long: 'recursive' },
  { long: 'format', arg: 'required' },
  { long: 'show-control-chars' },
  { long: 'sort', arg: 'required' },
  { short: 'T', long: 'tabsize', arg: 'required' },
  { long: 'time', arg: 'required' },
  { long: 'time-style', arg: 'required' },
  { long: 'zero', supported: false },
  { long: 'color', arg: 'optional' },
  { long: 'hyperlink', arg: 'optional' },
  { long: 'block-size', arg: 'required' },
  { short: 'Z', long: 'context' },
  { long: 'author' },
  { long: 'help' },
  { long: 'version' },
  { short: 'c', id: 'c' },
  { short: 'C', id: 'C' },
  { short: 'f', id: 'f' },
  // -F takes no argument; --classify takes an optional one.
  { short: 'F', id: 'classify' },
  { short: 'g', id: 'g' },
  { short: 'l', id: 'l' },
  { short: 'm', id: 'm' },
  { short: 'o', id: 'o' },
  { short: 'p', id: 'p' },
  { short: 'S', id: 'S' },
  { short: 't', id: 't' },
  // Access times are not kept by the VFS.
  { short: 'u', id: 'u', supported: false },
  { short: 'U', id: 'U' },
  { short: 'v', id: 'v' },
  { short: 'x', id: 'x' },
  { short: 'X', id: 'X' },
  { short: '1', id: '1' },
];

const c = <V>(pairs: [string, V][]): ArgChoice<V>[] => pairs.map(([name, value]) => ({ name, value }));
type When = 'always' | 'never' | 'auto';
const WHEN = c<When>([['always', 'always'], ['yes', 'always'], ['force', 'always'], ['never', 'never'], ['no', 'never'], ['none', 'never'], ['auto', 'auto'], ['tty', 'auto'], ['if-tty', 'auto']]);
const FORMATS = c<Format>([['verbose', 'long'], ['long', 'long'], ['commas', 'commas'], ['horizontal', 'horizontal'], ['across', 'horizontal'], ['vertical', 'many'], ['single-column', 'one']]);
const SORTS = c<SortKey>([['none', 'none'], ['time', 'time'], ['size', 'size'], ['extension', 'extension'], ['version', 'version'], ['width', 'width']]);
const TIMES = c<'atime' | 'ctime' | 'mtime' | 'birth'>([['atime', 'atime'], ['access', 'atime'], ['use', 'atime'], ['ctime', 'ctime'], ['status', 'ctime'], ['mtime', 'mtime'], ['modification', 'mtime'], ['birth', 'birth'], ['creation', 'birth']]);
const INDICATOR_STYLES = c<IndicatorStyle>([['none', 'none'], ['slash', 'slash'], ['file-type', 'file-type'], ['classify', 'classify']]);
const QUOTING = QUOTING_STYLES.map((s) => ({ name: s, value: s }));

/** The --time-style diagnostic. reference: coreutils 9.4 `ls -l --time-style=bogus`, captured 2026-11-16 */
const timeStyleError = (arg: string): string =>
  `invalid argument ${quote(arg)} for ${quote('time style')}\nValid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n`;

const utcTz = (tz: string | undefined): boolean => tz === undefined || /^:?(UTC0?|Etc\/UTC|UTC\+?0|GMT0?|Etc\/GMT|Universal|Zulu)?$/.test(tz);

/** xstrtoumax with base 0 (decimal, 0x hex, 0 octal): the value, Infinity on overflow, or undefined. */
function parseUmax(s: string): number | undefined {
  const m = /^[ \t\n\v\f\r]*\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.exec(s);
  if (!m) return undefined;
  const digits = m[1] as string;
  const v = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits.startsWith('0') ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(v);
}

/** decode_line_length: too large means no limit (0); undefined is invalid. */
function decodeLineLength(s: string): number | undefined {
  const v = parseUmax(s);
  if (v === undefined) return undefined;
  return v === Infinity ? 0 : v;
}

/** fnmatch(pattern, name, FNM_PERIOD) for --ignore and --hide. */
function fnmatchPeriod(pattern: string, name: string): boolean {
  const pat: PatChar[] = [];
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\' && i + 1 < chars.length) pat.push({ c: chars[++i] as string, quoted: true });
    else pat.push({ c: chars[i] as string, quoted: false });
  }
  if (name.startsWith('.') && !(pat[0]?.c === '.')) return false;
  return globMatch(pat, name);
}

/** ST_NBLOCKS as ext4 would allocate them (see the header). */
function blocksOf(st: Stat): number {
  switch (st.type) {
    case 'dir':
    case 'file':
      return Math.ceil(st.size / 4096) * 8;
    case 'symlink':
      return st.size < 60 ? 0 : 8;
    default:
      return 0;
  }
}

/** file_name_concat as extract_dirs_from_files uses it: `./sub`, `/etc`, `a/b`. */
function fileNameConcat(dir: string, base: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  if (trimmed === '') return `/${base.replace(/^\/+/, '')}`;
  return base.startsWith('/') ? trimmed + base : `${trimmed}/${base}`;
}

/** attach: the path of `name` in `dirname`, which is left out when it is `.`. */
function attach(dirname: string, name: string): string {
  if (dirname === '' || dirname === '.') return name;
  return dirname.endsWith('/') ? dirname + name : `${dirname}/${name}`;
}

const baseIsDot = (name: string): boolean => {
  const b = name.replace(/\/+$/, '').split('/').pop() ?? '';
  return b === '.' || b === '..';
};

type LsMode = 'ls' | 'dir' | 'vdir';

type Decoded = { ok: true; cfg: LsConfig; help?: boolean; warnings: string[] } | { ok: false; status: number; message: string; unsupported?: string };

/** decode_switches. */
function decode(p: ProcApi, options: { id: string; value?: string }[], mode: LsMode): Decoded {
  const env = p.env;
  const me = p.name;
  const tty = p.isatty(1);
  const warnings: string[] = [];
  const usage = (message: string, status: number): Decoded => ({ ok: false, status, message: `${message}\nTry '${me} --help' for more information.\n` });
  const fatal = (message: string): Decoded => ({ ok: false, status: 2, message: `${message}\n` });

  let tabsize = 8;
  const tabEnv = env['TABSIZE'];
  if (env['POSIXLY_CORRECT'] === undefined && tabEnv !== undefined) {
    const v = parseUmax(tabEnv);
    if (v !== undefined && v !== Infinity) tabsize = v;
    else warnings.push(`ignoring invalid tab size in environment variable TABSIZE: ${quote(tabEnv)}`);
  }

  let format: Format | undefined;
  let ignore: LsConfig['ignore'] = 'default';
  const ignorePatterns: string[] = [];
  const hidePatterns: string[] = [];
  let immediateDirs = false;
  let recursive = false;
  let deref: Deref | undefined;
  let sort: SortKey = 'name';
  let sortSpecified = false;
  let reverse = false;
  let dirsFirst = false;
  let time: 'mtime' | 'ctime' = 'mtime';
  let explicitTime = false;
  let timeStyle: string | undefined;
  let indicator: IndicatorStyle = 'none';
  let printInode = false;
  let printBlockSize = false;
  let printOwner = true;
  let printGroup = true;
  let printAuthor = false;
  let printScontext = false;
  let numericIds = false;
  let blockSpec: { human: HumanOptions; size: number } | undefined;
  let kibibytes = false;
  let quoting: QuotingStyle | undefined;
  let qmark: boolean | undefined;
  let color = false;
  let width: number | undefined;

  for (const o of options) {
    const v = o.value;
    switch (o.id) {
      case 'all':
        ignore = 'minimal';
        break;
      case 'almost-all':
        ignore = 'dot-and-dotdot';
        break;
      case 'author':
        printAuthor = true;
        break;
      case 'escape':
        quoting = 'escape';
        break;
      case 'block-size': {
        const b = parseBlockSize(v as string);
        // reference: `ls: invalid --block-size argument 'X'`, `... invalid suffix in --block-size argument '10xyz'`
        if (!b.ok) return fatal(`${me}: ${b.error === 'suffix' ? 'invalid suffix in' : 'invalid'} --block-size argument '${v as string}'`);
        blockSpec = { human: b.opts, size: b.size };
        break;
      }
      case 'ignore-backups':
        hidePatterns.push('*~', '.*~');
        break;
      case 'c':
        time = 'ctime';
        explicitTime = true;
        break;
      case 'C':
        format = 'many';
        break;
      case 'color': {
        let when: When = 'always';
        if (v !== undefined) {
          const r = argmatch(v, WHEN);
          if (typeof r === 'number') return usage(`${me}: ${argmatchError(v, '--color', r, WHEN)}`, 1);
          when = r.value;
        }
        color = when === 'always' || (when === 'auto' && tty);
        break;
      }
      case 'directory':
        immediateDirs = true;
        break;
      case 'f':
        ignore = 'minimal';
        sort = 'none';
        sortSpecified = true;
        break;
      case 'classify': {
        let when: When = 'always';
        if (v !== undefined) {
          const r = argmatch(v, WHEN);
          if (typeof r === 'number') return usage(`${me}: ${argmatchError(v, '--classify', r, WHEN)}`, 1);
          when = r.value;
        }
        if (when === 'always' || (when === 'auto' && tty)) indicator = 'classify';
        break;
      }
      case 'file-type':
        indicator = 'file-type';
        break;
      case 'format': {
        const r = argmatch(v as string, FORMATS);
        if (typeof r === 'number') return usage(`${me}: ${argmatchError(v as string, '--format', r, FORMATS)}`, 1);
        format = r.value;
        break;
      }
      case 'full-time':
        format = 'long';
        timeStyle = 'full-iso';
        break;
      case 'g':
        format = 'long';
        printOwner = false;
        break;
      case 'group-directories-first':
        dirsFirst = true;
        break;
      case 'no-group':
        printGroup = false;
        break;
      case 'human-readable':
        blockSpec = { human: { autoscale: true, si: true, base1024: true }, size: 1 };
        break;
      case 'si':
        blockSpec = { human: { autoscale: true, si: true }, size: 1 };
        break;
      case 'dereference-command-line':
        deref = 'args';
        break;
      case 'dereference-command-line-symlink-to-dir':
        deref = 'args-dirs';
        break;
      case 'hide':
        hidePatterns.push(v as string);
        break;
      case 'hyperlink': {
        let when: When = 'always';
        if (v !== undefined) {
          const r = argmatch(v, WHEN);
          if (typeof r === 'number') return usage(`${me}: ${argmatchError(v, '--hyperlink', r, WHEN)}`, 1);
          when = r.value;
        }
        if (when === 'always' || (when === 'auto' && tty)) return { ok: false, status: 0, message: '', unsupported: 'the flag --hyperlink' };
        break;
      }
      case 'indicator-style': {
        const r = argmatch(v as string, INDICATOR_STYLES);
        if (typeof r === 'number') return usage(`${me}: ${argmatchError(v as string, '--indicator-style', r, INDICATOR_STYLES)}`, 1);
        indicator = r.value;
        break;
      }
      case 'inode':
        printInode = true;
        break;
      case 'ignore':
        ignorePatterns.push(v as string);
        break;
      case 'kibibytes':
        kibibytes = true;
        break;
      case 'l':
        format = 'long';
        break;
      case 'dereference':
        deref = 'always';
        break;
      case 'm':
        format = 'commas';
        break;
      case 'numeric-uid-gid':
        format = 'long';
        numericIds = true;
        break;
      case 'literal':
        quoting = 'literal';
        break;
      case 'o':
        format = 'long';
        printGroup = false;
        break;
      case 'p':
        indicator = 'slash';
        break;
      case 'hide-control-chars':
        qmark = true;
        break;
      case 'show-control-chars':
        qmark = false;
        break;
      case 'quote-name':
        quoting = 'c';
        break;
      case 'quoting-style': {
        const r = argmatch(v as string, QUOTING);
        if (typeof r === 'number') return usage(`${me}: ${argmatchError(v as string, '--quoting-style', r, QUOTING)}`, 1);
        quoting = r.value;
        break;
      }
      case 'reverse':
        reverse = true;
        break;
      case 'recursive':
        recursive = true;
        break;
      case 'size':
        printBlockSize = true;
        break;
      case 'S':
        sort = 'size';
        sortSpecified = true;
        break;
      case 'sort': {
        const r = argmatch(v as string, SORTS);
        if (typeof r === 'number') return usage(`${me}: ${argmatchError(v as string, '--sort', r, SORTS)}`, 1);
        sort = r.value;
        sortSpecified = true;
        break;
      }
      case 'time': {
        const r = argmatch(v as string, TIMES);
        if (typeof r === 'number') return usage(`${me}: ${argmatchError(v as string, '--time', r, TIMES)}`, 1);
        if (r.value === 'atime' || r.value === 'birth') {
          return { ok: false, status: 0, message: '', unsupported: r.value === 'atime' ? 'the access time (--time=atime)' : 'the birth time (--time=birth)' };
        }
        time = r.value;
        explicitTime = true;
        break;
      }
      case 'time-style':
        timeStyle = v as string;
        break;
      case 't':
        sort = 'time';
        sortSpecified = true;
        break;
      case 'tabsize': {
        const t = parseUmax(v as string);
        if (t === undefined || t === Infinity) return fatal(`${me}: invalid tab size: ${quote(v as string)}`);
        tabsize = t;
        break;
      }
      case 'U':
        sort = 'none';
        sortSpecified = true;
        break;
      case 'v':
        sort = 'version';
        sortSpecified = true;
        break;
      case 'width': {
        const w = decodeLineLength(v as string);
        if (w === undefined) return fatal(`${me}: invalid line width: ${quote(v as string)}`);
        width = w;
        break;
      }
      case 'x':
        format = 'horizontal';
        break;
      case 'X':
        sort = 'extension';
        sortSpecified = true;
        break;
      case 'context':
        printScontext = true;
        break;
      case '1':
        if (format !== 'long') format = 'one';
        break;
      case 'help':
        return { ok: true, cfg: undefined as unknown as LsConfig, help: true, warnings };
      case 'version':
        return { ok: false, status: 0, message: '', unsupported: 'the flag --version' };
    }
  }

  // ls_mode: dir lists in columns and vdir in the long format, both with escape quoting.
  const fmt: Format = format ?? (mode === 'dir' ? 'many' : mode === 'vdir' ? 'long' : tty ? 'many' : 'one');

  // Sizes: --block-size, -h and --si; else LS_BLOCK_SIZE, BLOCK_SIZE, POSIXLY_CORRECT (512).
  let human: HumanOptions = {};
  let blockSize: number;
  let fileHuman: HumanOptions = {};
  let fileBlockSize = 1;
  if (blockSpec) {
    human = fileHuman = blockSpec.human;
    blockSize = fileBlockSize = blockSpec.size;
  } else {
    // human_options(getenv("LS_BLOCK_SIZE")): then BLOCK_SIZE, BLOCKSIZE; an invalid value means the
    // default. File sizes follow only LS_BLOCK_SIZE and BLOCK_SIZE.
    const defaultBlockSize = env['POSIXLY_CORRECT'] !== undefined ? 512 : 1024;
    const envSpec = env['LS_BLOCK_SIZE'] ?? env['BLOCK_SIZE'] ?? env['BLOCKSIZE'];
    const b = envSpec === undefined ? undefined : parseBlockSize(envSpec);
    if (b?.ok) {
      human = b.opts;
      blockSize = b.size;
    } else blockSize = defaultBlockSize;
    if (env['LS_BLOCK_SIZE'] !== undefined || env['BLOCK_SIZE'] !== undefined) {
      fileHuman = human;
      fileBlockSize = blockSize;
    }
    if (kibibytes) {
      human = {};
      blockSize = 1024;
    }
  }

  // Colors, and no tabs with them.
  let colors = null;
  if (color) {
    const setup = setupColors(env);
    warnings.push(...setup.warnings);
    colors = setup.colors;
  }
  if (colors) tabsize = 0;

  // The line length, needed by the column layouts and colors.
  let lineLength = width ?? -1;
  if (fmt === 'many' || fmt === 'horizontal' || fmt === 'commas' || colors) {
    if (lineLength < 0) {
      const ws = tty ? p.winsize() : undefined;
      if (ws && ws.cols > 0) lineLength = ws.cols;
    }
    if (lineLength < 0) {
      const cols = env['COLUMNS'];
      if (cols !== undefined && cols !== '') {
        const n = decodeLineLength(cols);
        if (n === undefined) warnings.push(`ignoring invalid width in environment variable COLUMNS: ${quote(cols)}`);
        else lineLength = n;
      }
    }
  }
  if (lineLength < 0) lineLength = 80;

  // Quoting: an option, else QUOTING_STYLE, else shell-escape on a terminal and literal elsewhere.
  if (quoting === undefined) {
    const qs = env['QUOTING_STYLE'];
    if (qs !== undefined) {
      const r = argmatch(qs, QUOTING);
      if (typeof r === 'number') warnings.push(`ignoring invalid value of environment variable QUOTING_STYLE: ${quote(qs)}`);
      else quoting = r.value;
    }
  }
  const style: QuotingStyle = quoting ?? (mode !== 'ls' ? 'escape' : tty ? 'shell-escape' : 'literal');
  let extra = style === 'escape' ? ' ' : '';
  if (indicator === 'file-type') extra += '*=>@|';
  else if (indicator === 'classify') extra += '=>@|';

  // Time styles matter only to the long format.
  let timeFormats = LOCALE_FORMATS;
  if (fmt === 'long') {
    const ts = timeStyle ?? env['TIME_STYLE'];
    if (ts !== undefined) {
      const r = parseTimeStyle(ts);
      if (!r.ok) {
        if (r.error === 'format') return fatal(`${me}: invalid time style format ${quote(ts)}`);
        return { ok: false, status: 2, message: `${me}: ${timeStyleError(ts)}Try '${me} --help' for more information.\n` };
      }
      timeFormats = r.formats;
    }
  }

  if (explicitTime && !sortSpecified && fmt !== 'long') sort = 'time';
  const resolvedDeref: Deref = deref ?? (immediateDirs || indicator === 'classify' || fmt === 'long' ? 'never' : 'args-dirs');
  const alignQuotes =
    (fmt === 'long' || ((fmt === 'many' || fmt === 'horizontal') && lineLength !== 0)) && (style === 'shell' || style === 'shell-escape' || style === 'c-maybe');
  const checkSymlinkMode =
    dirsFirst ||
    (colors !== null &&
      (isColored(colors, 'or') || (isColored(colors, 'ex') && colors.linkAsReferent) || (isColored(colors, 'mi') && fmt === 'long')));
  const formatNeedsStat = sort === 'time' || sort === 'size' || fmt === 'long' || printScontext || printBlockSize;
  const formatNeedsType = !formatNeedsStat && (recursive || colors !== null || dirsFirst || indicator !== 'none');

  return {
    ok: true,
    warnings,
    cfg: {
      format: fmt,
      ignore,
      ignorePatterns,
      hidePatterns,
      immediateDirs,
      recursive,
      deref: resolvedDeref,
      sort,
      reverse,
      dirsFirst,
      time,
      timeFormats,
      indicator,
      printInode,
      printBlockSize,
      printOwner,
      printGroup,
      printAuthor,
      printScontext,
      numericIds,
      fileHuman,
      fileBlockSize,
      human,
      blockSize,
      quoting: extra === '' ? { style } : { style, extra },
      dirQuoting: { style, extra: ':' },
      qmark: qmark ?? (mode === 'ls' && tty),
      alignQuotes,
      colors,
      checkSymlinkMode,
      lineLength,
      tabsize,
      formatNeedsStat,
      formatNeedsType,
    },
  };
}

interface Pending {
  name: string;
  cmdline: boolean;
  /** Inodes of the directories being listed above this one (-R loop detection). */
  ancestors: string[];
}

function* run(p: ProcApi, mode: LsMode): Generator<Syscall, number, unknown> {
  const me = p.name;
  const args = yield* parseArgs(p, { options: OPTIONS }, 2);
  if (typeof args === 'number') return args;
  const d = decode(p, args.options, mode);
  if (!d.ok) {
    if (d.unsupported !== undefined) return yield* p.unsupported({ kind: 'flag', what: d.unsupported });
    yield* p.write(2, d.message);
    return d.status;
  }
  for (const w of d.warnings) yield* p.write(2, `${me}: ${w}\n`);
  if (d.help) {
    yield* p.write(1, helpText(mode));
    return 0;
  }
  const cfg = d.cfg;
  if (cfg.format === 'long' && !utcTz(p.env['TZ'])) {
    return yield* p.unsupported({ kind: 'behavior', what: `local time in the time zone ${p.env['TZ'] as string}` });
  }

  const fs = p.fs();
  let badConversion: string | undefined;
  const world: LsWorld = {
    now: p.now,
    userName: (uid) => userByUid(p.ctx, p.machine, uid)?.name,
    groupName: (gid) => groupByGid(p.ctx, p.machine, gid)?.name,
    onBadConversion: (conv) => {
      badConversion ??= conv;
    },
  };
  const out: Out = { text: '', usedColor: false };
  let status = 0;
  const flush = function* (): Generator<Syscall, void, unknown> {
    if (out.text !== '') {
      const t = out.text;
      out.text = '';
      yield* p.write(1, t);
    }
  };
  const failures: string[] = [];
  /** file_failure: the message now (after what is already listed), and the exit status. */
  const failure = (serious: boolean, message: string, code: Errno): void => {
    failures.push(`${me}: ${message}: ${strerror(code)}\n`);
    if (serious) status = 2;
    else if (status === 0) status = 1;
  };
  const drainFailures = function* (): Generator<Syscall, void, unknown> {
    if (failures.length === 0) return;
    yield* flush();
    const msgs = failures.splice(0);
    for (const m of msgs) yield* p.write(2, m);
  };

  const newListing = (): Listing => ({ files: [], someQuoted: false, widths: emptyWidths(), totalBlocks: 0 });
  const fsError = (e: unknown): Errno => {
    if (isFsError(e)) return e.code;
    throw e;
  };
  const statTry = (path: string, follow: boolean): { st: Stat } | { code: Errno } => {
    try {
      return { st: follow ? fs.stat(path) : fs.lstat(path) };
    } catch (e) {
      return { code: fsError(e) };
    }
  };
  const typeOfStat = (st: Stat): FileType => st.type;

  /** gobble_file. */
  const gobble = (listing: Listing, name: string, type: FileType, ino: string | undefined, cmdline: boolean, dirname: string): void => {
    const f: FileInfo = { name, path: name, type, statOk: false, mode: 0, linkok: false, linkmode: 0, blocks: 0, ...(ino !== undefined ? { ino } : {}) };
    if (!listing.someQuoted && cfg.alignQuotes && needsQuoting(cfg, name)) listing.someQuoted = true;
    const colors = cfg.colors;
    const checkStat =
      cmdline ||
      cfg.formatNeedsStat ||
      (type === 'dir' && colors !== null && (isColored(colors, 'ow') || isColored(colors, 'st') || isColored(colors, 'tw'))) ||
      ((cfg.printInode || cfg.formatNeedsType) &&
        (type === 'symlink' || type === 'unknown') &&
        (cfg.deref === 'always' || colors?.linkAsReferent === true || cfg.checkSymlinkMode)) ||
      (cfg.printInode && ino === undefined) ||
      (cfg.formatNeedsType &&
        (type === 'unknown' ||
          cmdline ||
          (type === 'file' &&
            (cfg.indicator === 'classify' ||
              (colors !== null && (isColored(colors, 'ex') || isColored(colors, 'su') || isColored(colors, 'sg')))))));
    const full = attach(dirname, name);
    f.path = full;
    if (checkStat) {
      let r: { st: Stat } | { code: Errno };
      if (cfg.deref === 'always') r = statTry(full, true);
      else if ((cfg.deref === 'args' || cfg.deref === 'args-dirs') && cmdline) {
        r = statTry(full, true);
        if (cfg.deref === 'args-dirs') {
          const needLstat = 'code' in r ? r.code === 'ENOENT' || r.code === 'ELOOP' : r.st.type !== 'dir';
          if (needLstat) r = statTry(full, false);
        }
      } else r = statTry(full, false);
      if ('code' in r) {
        failure(cmdline, `cannot access ${quoteaf(full)}`, r.code);
        if (cmdline) return;
        listing.files.push(f);
        return;
      }
      f.statOk = true;
      f.st = r.st;
      f.mode = modeOf(r.st);
      f.ino = r.st.ino;
      f.type = typeOfStat(r.st);
      if (f.type === 'dir' && cmdline && !cfg.immediateDirs) f.type = 'argdir';
    }
    if (f.type === 'symlink' && (cfg.format === 'long' || cfg.checkSymlinkMode)) {
      try {
        f.linkname = fs.readlink(full);
      } catch (e) {
        fsError(e);
      }
      if (f.linkname !== undefined && (cfg.indicator === 'file-type' || cfg.indicator === 'classify' || cfg.checkSymlinkMode)) {
        const t = statTry(full, true);
        if ('st' in t) {
          f.linkok = true;
          f.linkmode = modeOf(t.st);
        }
      }
    }
    if (f.statOk && f.st) f.blocks = blocksOf(f.st);
    accumulateWidths(world, cfg, listing, f);
    listing.totalBlocks += f.blocks;
    listing.files.push(f);
  };

  const sortListing = (listing: Listing): FileInfo[] =>
    sortEntries(
      listing.files.map((f) => ({
        f,
        name: f.name,
        time: f.st ? (cfg.time === 'ctime' ? f.st.ctime : f.st.mtime) : 0,
        size: f.st?.size ?? 0,
        width: cfg.sort === 'width' ? fileNameWidth(cfg, listing, f) : 0,
        linkedDir: f.type === 'dir' || f.type === 'argdir' || (f.linkmode & 0o170000) === 0o040000,
      })),
      cfg.sort,
      cfg.reverse,
      cfg.dirsFirst,
    ).map((e) => e.f);

  const pending: Pending[] = [];
  /** extract_dirs_from_files: queue the directories, last first; command line ones leave the list. */
  const extractDirs = (files: FileInfo[], dirname: string | null, cmdline: boolean, ancestors: string[]): FileInfo[] => {
    for (let i = files.length - 1; i >= 0; i--) {
      const f = files[i] as FileInfo;
      if ((f.type === 'dir' || f.type === 'argdir') && (dirname === null || !baseIsDot(f.name))) {
        const name = dirname === null || f.name.startsWith('/') ? f.name : fileNameConcat(dirname, f.name);
        pending.push({ name, cmdline, ancestors });
      }
    }
    return files.filter((f) => f.type !== 'argdir');
  };

  let printDirName = true;
  let first = true;
  /** print_dir. */
  const printDir = function* (dir: Pending): Generator<Syscall, void, unknown> {
    let names: string[];
    let dirIno: string;
    try {
      names = fs.readdir(dir.name);
      dirIno = fs.stat(dir.name).ino;
    } catch (e) {
      failure(dir.cmdline, `cannot open directory ${quoteaf(dir.name)}`, fsError(e));
      yield* drainFailures();
      return;
    }
    if (cfg.recursive && dir.ancestors.includes(dirIno)) {
      // reference: `ls: L/x/up: not listing already-listed directory`, exit 2 (ls -RL with a loop)
      yield* flush();
      yield* p.write(2, `${me}: ${quotef(dir.name)}: not listing already-listed directory\n`);
      status = 2;
      return;
    }
    const listing = newListing();
    if (cfg.recursive || printDirName) {
      if (!first) out.text += '\n';
      first = false;
      out.text += `${quoteName(cfg, dir.name, cfg.dirQuoting).text}:\n`;
    }
    // Entry types and inode numbers come from the directory itself (d_type, d_ino), as getdents
    // reports them without a stat.
    const machine = getMachine(p.ctx, p.machine);
    const dirInode = machine.vfs.inodes[dirIno] as DirInode;
    const direntType = (id: string | undefined): FileType => {
      const i = id === undefined ? undefined : machine.vfs.inodes[id];
      if (!i) return 'unknown';
      if (i.type === 'dir') return 'dir';
      if (i.type === 'symlink') return 'symlink';
      if (i.type === 'generated' && i.device) return 'char';
      return 'file';
    };
    const entries: [string, string | undefined][] = names.map((n) => [n, dirInode.entries[n]]);
    if (cfg.ignore === 'minimal') entries.unshift(['.', dirInode.id], ['..', dirInode.parent]);
    for (const [name, id] of entries) {
      const hidden =
        (cfg.ignore !== 'minimal' && name.startsWith('.') && (cfg.ignore === 'default' || name === '.' || name === '..')) ||
        (cfg.ignore === 'default' && cfg.hidePatterns.some((pat) => fnmatchPeriod(pat, name))) ||
        cfg.ignorePatterns.some((pat) => fnmatchPeriod(pat, name));
      if (hidden) continue;
      gobble(listing, name, direntType(id), id, false, dir.name);
    }
    let files = sortListing(listing);
    if (cfg.recursive) files = extractDirs(files, dir.name, false, [...dir.ancestors, dirIno]);
    yield* drainFailures();
    if (cfg.format === 'long' || cfg.printBlockSize) out.text += totalLine(cfg, listing);
    if (files.length > 0) printFiles(world, cfg, listing, out, files);
    if (badConversion !== undefined) return;
    yield* flush();
  };

  const top = newListing();
  const operands = args.operands;
  if (operands.length === 0) {
    if (cfg.immediateDirs) gobble(top, '.', 'dir', undefined, true, '');
    else pending.push({ name: '.', cmdline: true, ancestors: [] });
  } else for (const name of operands) gobble(top, name, 'unknown', undefined, true, '');
  yield* drainFailures();
  let files: FileInfo[] = [];
  if (top.files.length > 0) {
    files = sortListing(top);
    if (!cfg.immediateDirs) files = extractDirs(files, null, true, []);
  }
  if (files.length > 0) {
    printFiles(world, cfg, top, out, files);
    if (pending.length > 0) out.text += '\n';
  } else if (operands.length <= 1 && pending.length === 1) printDirName = false;
  while (pending.length > 0 && badConversion === undefined) {
    yield* printDir(pending.pop() as Pending);
  }
  if (badConversion !== undefined) {
    return yield* p.unsupported({ kind: 'flag-value', what: `the time format conversion ${badConversion}` });
  }
  restoreColor(cfg, out);
  yield* flush();
  return status;
}

/**
 * `dir --help` and `vdir --help` differ from `ls --help` only in the program name of the usage
 * line and the two documentation lines. reference: coreutils 9.4 dir --help, vdir --help, captured 2026-11-16
 */
function helpText(mode: LsMode): string {
  if (mode === 'ls') return LS_HELP;
  return LS_HELP.replace('Usage: ls ', `Usage: ${mode} `)
    .replace('coreutils/ls>', `coreutils/${mode}>`)
    .replace("'(coreutils) ls invocation'", `'(coreutils) ${mode} invocation'`);
}

export const lsProgram: ProgramSpec = { name: 'ls', main: (p) => run(p, 'ls') };
export const dirProgram: ProgramSpec = { name: 'dir', main: (p) => run(p, 'dir') };
export const vdirProgram: ProgramSpec = { name: 'vdir', main: (p) => run(p, 'vdir') };
