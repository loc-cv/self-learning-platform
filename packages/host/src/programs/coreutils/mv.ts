// mv — move (rename) files. GNU coreutils 9.4.
//   docs: mv --help and mv(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/mv.c main, do_move; src/copy.c copy_internal (its move_mode path),
//             same_file_ok, abandon_move, overwrite_ok
//   reference: coreutils 9.4 mv, captured 2026-11-16 (packages/host/transcripts/coreutils/mv.t)
// A machine's VFS is one file system, so rename(2) never fails with EXDEV and mv never falls back
// to copying and removing; --no-copy therefore changes nothing. Prompts (-i, and mv's question
// before replacing a write-protected file when standard input is a terminal) print the notice.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, type Errno } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt, baseName, joinPath } from '../lib/fsutil.ts';
import { matchUpdate, overwriteQuestion, sameFileOk, targetDirectoryError, updateArgError, writableDestination } from '../lib/copyutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quoteaf } from '../lib/quote.ts';

/** `mv --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: mv [OPTION]... [-T] SOURCE DEST\n  or:  mv [OPTION]... SOURCE... DIRECTORY\n  or:  mv [OPTION]... -t DIRECTORY SOURCE...\nRename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.\n\nMandatory arguments to long options are mandatory for short options too.\n      --backup[=CONTROL]       make a backup of each existing destination file\n  -b                           like --backup but does not accept an argument\n      --debug                  explain how a file is copied.  Implies -v\n  -f, --force                  do not prompt before overwriting\n  -i, --interactive            prompt before overwrite\n  -n, --no-clobber             do not overwrite an existing file\nIf you specify more than one of -i, -f, -n, only the final one takes effect.\n      --no-copy                do not copy if renaming fails\n      --strip-trailing-slashes  remove any trailing slashes from each SOURCE\n                                 argument\n  -S, --suffix=SUFFIX          override the usual backup suffix\n  -t, --target-directory=DIRECTORY  move all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n  --update[=UPDATE]            control which existing files are updated;\n                                 UPDATE={all,none,older(default)}.  See below\n  -u                           equivalent to --update[=older]\n  -v, --verbose                explain what is being done\n  -Z, --context                set SELinux security context of destination\n                                 file to default type\n      --help        display this help and exit\n      --version     output version information and exit\n\nUPDATE controls which existing files in the destination are replaced.\n'all' is the default operation when an --update option is not specified,\nand results in all existing files in the destination being replaced.\n'none' is similar to the --no-clobber option, in that no files in the\ndestination are replaced, but also skipped files do not induce a failure.\n'older' is the default operation when --update is specified, and results\nin files being replaced if they're older than the corresponding source file.\n\nThe backup suffix is '~', unless set with --suffix or SIMPLE_BACKUP_SUFFIX.\nThe version control method may be selected via the --backup option or through\nthe VERSION_CONTROL environment variable.  Here are the values:\n\n  none, off       never make backups (even if --backup is given)\n  numbered, t     make numbered backups\n  existing, nil   numbered if numbered backups exist, simple otherwise\n  simple, never   always make simple backups\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/mv>\nor available locally via: info '(coreutils) mv invocation'\n";

const OPTIONS: OptionSpec[] = [
  { long: 'backup', arg: 'optional', supported: false },
  { short: 'b', id: 'backup', supported: false },
  { long: 'debug' },
  { short: 'f', long: 'force' },
  { short: 'i', long: 'interactive' },
  { short: 'n', long: 'no-clobber' },
  { long: 'no-copy' },
  { long: 'strip-trailing-slashes' },
  { short: 'S', long: 'suffix', arg: 'required', supported: false },
  { short: 't', long: 'target-directory', arg: 'required' },
  { short: 'T', long: 'no-target-directory' },
  { long: 'update', arg: 'optional' },
  { short: 'u', id: 'u' },
  { short: 'v', long: 'verbose' },
  { short: 'Z', long: 'context', supported: false },
  { long: 'help' },
  { long: 'version' },
];

/** I_UNSPECIFIED, I_ALWAYS_YES (-f), I_ALWAYS_NO (-n), I_ALWAYS_SKIP (--update=none), I_ASK_USER (-i). */
type Interactive = 'unspecified' | 'yes' | 'no' | 'skip' | 'ask';

interface Run {
  p: ProcApi;
  fs: Fs;
  interactive: Interactive;
  update: boolean;
  verbose: boolean;
  stdinTty: boolean;
}

/** renameat2(RENAME_NOREPLACE). */
function renameNoReplace(fs: Fs, src: string, dst: string): Errno | undefined {
  const s = attempt(() => fs.lstat(src));
  if (!s.ok) return s.code;
  if (attempt(() => fs.lstat(dst)).ok) return 'EEXIST';
  const r = attempt(() => fs.rename(src, dst));
  return r.ok ? undefined : r.code;
}

function* renamed(r: Run, src: string, dst: string): Op<boolean> {
  if (r.verbose) yield* r.p.write(1, `renamed ${quoteaf(src)} -> ${quoteaf(dst)}\n`);
  return true;
}

/** do_move and copy_internal in move mode. */
function* doMove(r: Run, src: string, dst: string, topSrc: string, topDst: string, tried: Errno | undefined | 'untried'): Op<boolean> {
  const { p, fs } = r;
  let renameErr = tried === 'untried' ? renameNoReplace(fs, src, dst) : tried;
  if (renameErr === undefined) return yield* renamed(r, src, dst);
  let srcSb: Stat | undefined;
  if (renameErr !== 'EEXIST' || (r.interactive !== 'no' && r.interactive !== 'skip')) {
    const s = attempt(() => fs.lstat(src));
    if (!s.ok) {
      yield* warn(p, `cannot stat ${quoteaf(src)}: ${strerror(s.code)}`);
      return false;
    }
    srcSb = s.value;
  }
  let dstSb: Stat | undefined;
  if (!(renameErr === 'EEXIST' && (r.interactive === 'no' || r.interactive === 'skip'))) {
    const d = attempt(() => fs.lstat(dst));
    if (d.ok) {
      dstSb = d.value;
      renameErr = 'EEXIST';
    } else if (d.code !== 'ENOENT') {
      yield* warn(p, `cannot stat ${quoteaf(dst)}: ${strerror(d.code)}`);
      return false;
    }
  }
  if (renameErr === 'EEXIST') {
    if (r.interactive !== 'no' && r.interactive !== 'skip' && srcSb && dstSb) {
      const ok = sameFileOk(fs, src, srcSb, dst, dstSb, { moveMode: true, hardLink: false, symbolicLink: false, derefNever: true, unlinkDestBeforeOpening: false });
      if (!ok) {
        yield* warn(p, `${quoteaf(src)} and ${quoteaf(dst)} are the same file`);
        return false;
      }
    }
    if (r.update && srcSb && dstSb && srcSb.type !== 'dir' && dstSb.mtime >= srcSb.mtime) return true;
    // abandon_move
    if (r.interactive === 'no') {
      yield* warn(p, `not replacing ${quoteaf(dst)}`);
      return false;
    }
    if (r.interactive === 'skip') return true;
    if (dstSb && (r.interactive === 'ask' || (r.interactive === 'unspecified' && r.stdinTty && !writableDestination(fs, dst, dstSb)))) {
      const q = overwriteQuestion(p, fs, dst, dstSb, true);
      return yield* p.unsupported({ kind: 'behavior', what: `answering mv's question "${q.trim()}"`, hints: ['use mv -f to replace without asking'] });
    }
    if (dstSb && srcSb) {
      if (dstSb.type !== 'dir' && srcSb.type === 'dir') {
        yield* warn(p, `cannot overwrite non-directory ${quoteaf(dst)} with directory ${quoteaf(src)}`);
        return false;
      }
      if (srcSb.type !== 'dir' && dstSb.type === 'dir') {
        yield* warn(p, `cannot overwrite directory ${quoteaf(dst)} with non-directory`);
        return false;
      }
    }
    const again = attempt(() => fs.rename(src, dst));
    renameErr = again.ok ? undefined : again.code;
    if (renameErr === undefined) return yield* renamed(r, src, dst);
  }
  if (renameErr === 'EINVAL') {
    yield* warn(p, `cannot move ${quoteaf(topSrc)} to a subdirectory of itself, ${quoteaf(topDst)}`);
    return false;
  }
  const overwriteErrors: Errno[] = ['EEXIST', 'EISDIR', 'EMLINK', 'ENOSPC', 'ETXTBSY', 'ENOTEMPTY'];
  if (overwriteErrors.includes(renameErr)) yield* warn(p, `cannot overwrite ${quoteaf(dst)}: ${strerror(renameErr)}`);
  else yield* warn(p, `cannot move ${quoteaf(src)} to ${quoteaf(dst)}: ${strerror(renameErr)}`);
  return false;
}

const stripSlashes = (s: string): string => (s.replace(/\/+$/, '') === '' && s !== '' ? '/' : s.replace(/\/+$/, ''));

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const fs = p.fs();
  let interactive: Interactive = 'unspecified';
  let update = false;
  let targetDir: string | undefined;
  for (const o of args.options) {
    switch (o.id) {
      case 'force':
        interactive = 'yes';
        break;
      case 'interactive':
        interactive = 'ask';
        break;
      case 'no-clobber':
        interactive = 'no';
        break;
      case 'u':
        update = true;
        break;
      case 'update': {
        const u = o.value === undefined ? 'older' : matchUpdate(o.value);
        if (u === undefined) {
          yield* p.write(2, updateArgError(p.name, o.value as string));
          return 1;
        }
        if (u === 'all') update = false;
        else if (u === 'none') interactive = 'skip';
        else update = true;
        break;
      }
      case 'target-directory': {
        if (targetDir !== undefined) {
          yield* warn(p, 'multiple target directories specified');
          return 1;
        }
        targetDir = o.value as string;
        break;
      }
    }
  }
  if (interactive === 'no') update = false;
  const files = [...args.operands];
  let n = files.length;
  if (n <= (targetDir === undefined ? 1 : 0)) {
    if (n === 0) return yield* usageError(p, 'missing file operand');
    return yield* usageError(p, `missing destination file operand after ${quoteaf(files[0] as string)}`);
  }
  let renameErr: Errno | undefined | 'untried' = 'untried';
  if (args.has('no-target-directory')) {
    if (targetDir !== undefined) {
      yield* warn(p, 'cannot combine --target-directory (-t) and --no-target-directory (-T)');
      return 1;
    }
    if (n > 2) return yield* usageError(p, `extra operand ${quoteaf(files[2] as string)}`);
  } else if (targetDir !== undefined) {
    const e = targetDirectoryError(fs, targetDir);
    if (e !== undefined) {
      yield* warn(p, `target directory ${quoteaf(targetDir)}: ${strerror(e)}`);
      return 1;
    }
  } else {
    const last = files[n - 1] as string;
    if (n === 2) renameErr = renameNoReplace(fs, files[0] as string, last);
    if (renameErr !== undefined) {
      const e = targetDirectoryError(fs, last);
      if (e === undefined) {
        renameErr = 'untried';
        targetDir = last;
        n -= 1;
      } else if (n > 2) {
        yield* warn(p, `target ${quoteaf(last)}: ${strerror(e)}`);
        return 1;
      }
    }
  }
  if (args.has('strip-trailing-slashes')) for (let i = 0; i < n; i++) files[i] = stripSlashes(files[i] as string);
  const r: Run = { p, fs, interactive, update, verbose: args.has('verbose') || args.has('debug'), stdinTty: p.isatty(0) };
  let ok = true;
  if (targetDir !== undefined) {
    for (let i = 0; i < n; i++) {
      const src = files[i] as string;
      const dest = joinPath(targetDir, baseName(src));
      ok = (yield* doMove(r, src, dest, src, dest, 'untried')) && ok;
    }
  } else {
    const src = files[0] as string;
    const dst = files[1] as string;
    ok = yield* doMove(r, src, dst, src, dst, renameErr);
  }
  return ok ? 0 : 1;
}

export const mvProgram: ProgramSpec = { name: 'mv', main };
