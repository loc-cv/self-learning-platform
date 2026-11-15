// cp — copy files and directories. GNU coreutils 9.4 as Ubuntu 24.04 ships it.
//   docs: cp --help and cp(1) of coreutils 9.4
//   upstream: coreutils 9.4 src/cp.c main, do_copy; src/copy.c copy_internal, copy_reg, copy_dir,
//             same_file_ok, set_owner, emit_verbose
//   reference: coreutils 9.4-3ubuntu6.3 cp, captured 2026-11-16 (packages/host/transcripts/coreutils/cp.t).
//              Ubuntu's cp -n differs from upstream 9.4: it warns that -n is non-portable (once per
//              -n given) and skips existing files silently with status 0.
// What the VFS keeps is what can be preserved: mode, owner and group, and the modification time.
// There are no access times, extended attributes or security contexts, so --preserve=xattr has
// nothing to copy and -a's context preservation, which fails silently without SELinux, does
// nothing; an explicit --preserve=context gets the notice. Entries of a directory are copied in
// name order; the real cp uses the file system's order. A symbolic link's own time is not kept.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { strerror, UnsupportedError, type Errno } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt, baseName, dirName, fsWithUmask, joinPath, umaskOf } from '../lib/fsutil.ts';
import { matchUpdate, overwriteQuestion, sameFileOk, sameName, targetDirectoryError, updateArgError } from '../lib/copyutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';

/** `cp --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: cp [OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... SOURCE... DIRECTORY\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...\nCopy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.\n\nMandatory arguments to long options are mandatory for short options too.\n  -a, --archive                same as -dR --preserve=all\n      --attributes-only        don't copy the file data, just the attributes\n      --backup[=CONTROL]       make a backup of each existing destination file\n  -b                           like --backup but does not accept an argument\n      --copy-contents          copy contents of special files when recursive\n  -d                           same as --no-dereference --preserve=links\n      --debug                  explain how a file is copied.  Implies -v\n  -f, --force                  if an existing destination file cannot be\n                                 opened, remove it and try again (this option\n                                 is ignored when the -n option is also used)\n  -i, --interactive            prompt before overwrite (overrides a previous -n\n                                  option)\n  -H                           follow command-line symbolic links in SOURCE\n  -l, --link                   hard link files instead of copying\n  -L, --dereference            always follow symbolic links in SOURCE\n  -n, --no-clobber             do not overwrite an existing file and do not fail\n                                 (overrides a -u or previous -i option). See also\n                                 --update; equivalent to --update=none.\n  -P, --no-dereference         never follow symbolic links in SOURCE\n  -p                           same as --preserve=mode,ownership,timestamps\n      --preserve[=ATTR_LIST]   preserve the specified attributes\n      --no-preserve=ATTR_LIST  don't preserve the specified attributes\n      --parents                use full source file name under DIRECTORY\n  -R, -r, --recursive          copy directories recursively\n      --reflink[=WHEN]         control clone/CoW copies. See below\n      --remove-destination     remove each existing destination file before\n                                 attempting to open it (contrast with --force)\n      --sparse=WHEN            control creation of sparse files. See below\n      --strip-trailing-slashes  remove any trailing slashes from each SOURCE\n                                 argument\n  -s, --symbolic-link          make symbolic links instead of copying\n  -S, --suffix=SUFFIX          override the usual backup suffix\n  -t, --target-directory=DIRECTORY  copy all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n  --update[=UPDATE]            control which existing files are updated;\n                                 UPDATE={all,none,older(default)}.  See below\n  -u                           equivalent to --update[=older]\n  -v, --verbose                explain what is being done\n  -x, --one-file-system        stay on this file system\n  -Z                           set SELinux security context of destination\n                                 file to default type\n      --context[=CTX]          like -Z, or if CTX is specified then set the\n                                 SELinux or SMACK security context to CTX\n      --help        display this help and exit\n      --version     output version information and exit\n\nATTR_LIST is a comma-separated list of attributes. Attributes are 'mode' for\npermissions (including any ACL and xattr permissions), 'ownership' for user\nand group, 'timestamps' for file timestamps, 'links' for hard links, 'context'\nfor security context, 'xattr' for extended attributes, and 'all' for all\nattributes.\n\nBy default, sparse SOURCE files are detected by a crude heuristic and the\ncorresponding DEST file is made sparse as well.  That is the behavior\nselected by --sparse=auto.  Specify --sparse=always to create a sparse DEST\nfile whenever the SOURCE file contains a long enough sequence of zero bytes.\nUse --sparse=never to inhibit creation of sparse files.\n\nUPDATE controls which existing files in the destination are replaced.\n'all' is the default operation when an --update option is not specified,\nand results in all existing files in the destination being replaced.\n'none' is like the --no-clobber option, in that no files in the\ndestination are replaced, and skipped files do not induce a failure.\n'older' is the default operation when --update is specified, and results\nin files being replaced if they're older than the corresponding source file.\n\nWhen --reflink[=always] is specified, perform a lightweight copy, where the\ndata blocks are copied only when modified.  If this is not possible the copy\nfails, or if --reflink=auto is specified, fall back to a standard copy.\nUse --reflink=never to ensure a standard copy is performed.\n\nThe backup suffix is '~', unless set with --suffix or SIMPLE_BACKUP_SUFFIX.\nThe version control method may be selected via the --backup option or through\nthe VERSION_CONTROL environment variable.  Here are the values:\n\n  none, off       never make backups (even if --backup is given)\n  numbered, t     make numbered backups\n  existing, nil   numbered if numbered backups exist, simple otherwise\n  simple, never   always make simple backups\n\nAs a special case, cp makes a backup of SOURCE when the force and backup\noptions are given and SOURCE and DEST are the same name for an existing,\nregular file.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/cp>\nor available locally via: info '(coreutils) cp invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', long: 'archive' },
  { long: 'attributes-only' },
  { long: 'backup', arg: 'optional', supported: false },
  { short: 'b', id: 'backup', supported: false },
  { long: 'copy-contents', supported: false },
  { short: 'd', id: 'd' },
  { long: 'debug', supported: false },
  { short: 'f', long: 'force' },
  { short: 'i', long: 'interactive' },
  { short: 'H', id: 'H' },
  { short: 'l', long: 'link' },
  { short: 'L', long: 'dereference' },
  { short: 'n', long: 'no-clobber' },
  { short: 'P', long: 'no-dereference' },
  { short: 'p', id: 'p' },
  { long: 'preserve', arg: 'optional' },
  { long: 'no-preserve', arg: 'required' },
  { long: 'parents', supported: false },
  { short: 'R', long: 'recursive' },
  { short: 'r', id: 'recursive' },
  { long: 'reflink', arg: 'optional', supported: false },
  { long: 'remove-destination' },
  { long: 'sparse', arg: 'required', supported: false },
  { long: 'strip-trailing-slashes' },
  { short: 's', long: 'symbolic-link' },
  { short: 'S', long: 'suffix', arg: 'required', supported: false },
  { short: 't', long: 'target-directory', arg: 'required' },
  { short: 'T', long: 'no-target-directory' },
  { long: 'update', arg: 'optional' },
  { short: 'u', id: 'u' },
  { short: 'v', long: 'verbose' },
  { short: 'x', long: 'one-file-system', supported: false },
  { short: 'Z', id: 'context', supported: false },
  { long: 'context', arg: 'optional', supported: false },
  { long: 'help' },
  { long: 'version' },
];

type Deref = 'undefined' | 'never' | 'command-line' | 'always';
type Interactive = 'unspecified' | 'no' | 'skip' | 'ask';

interface Options {
  deref: Deref;
  recursive: boolean;
  preserveMode: boolean;
  preserveOwnership: boolean;
  preserveTimestamps: boolean;
  preserveLinks: boolean;
  requirePreserve: boolean;
  explicitNoPreserveMode: boolean;
  hardLink: boolean;
  symbolicLink: boolean;
  interactive: Interactive;
  update: boolean;
  unlinkAfterFailedOpen: boolean;
  unlinkBeforeOpening: boolean;
  dataCopy: boolean;
  verbose: boolean;
}

interface Run {
  p: ProcApi;
  fs: Fs;
  x: Options;
  root: boolean;
  umask: number;
  /** remember_copied: source (or created directory) inode → destination name. */
  copied: Record<string, string>;
  /** Inodes of destinations made for command-line arguments (dest_info). */
  created: Record<string, true>;
  /** Sources seen on the command line (src_info), when there are two or more. */
  seen: Record<string, true> | undefined;
}

const S_IRWXU = 0o700;
const S_IRWXGO = 0o077;
const S_IWGO = 0o022;
const SPECIAL = 0o7000;

const PRESERVE_WORDS = ['mode', 'timestamps', 'ownership', 'links', 'context', 'xattr', 'all'] as const;
type PreserveWord = (typeof PRESERVE_WORDS)[number];

function matchPreserve(w: string): PreserveWord | undefined {
  if ((PRESERVE_WORDS as readonly string[]).includes(w)) return w as PreserveWord;
  const c = PRESERVE_WORDS.filter((x) => x.startsWith(w));
  return w !== '' && c.length === 1 ? c[0] : undefined;
}

/** decode_preserve_arg. Returns the bad word, or a word that needs the notice. */
function decodePreserve(arg: string, x: Options, on: boolean): { bad?: string; unsupported?: string } {
  for (const raw of arg.split(',')) {
    const w = matchPreserve(raw);
    if (w === undefined) return { bad: raw };
    if (w === 'mode') {
      x.preserveMode = on;
      x.explicitNoPreserveMode = !on;
    } else if (w === 'timestamps') x.preserveTimestamps = on;
    else if (w === 'ownership') x.preserveOwnership = on;
    else if (w === 'links') x.preserveLinks = on;
    else if (w === 'context') {
      if (on) return { unsupported: 'context' };
    } else if (w === 'xattr') {
      // Nothing to copy: the VFS has no extended attributes.
    } else {
      x.preserveMode = x.preserveTimestamps = x.preserveOwnership = x.preserveLinks = on;
      if (!on) x.explicitNoPreserveMode = true;
    }
  }
  return {};
}

function* verbose(r: Run, src: string, dst: string): Op<void> {
  if (r.x.verbose) yield* r.p.write(1, `${quoteaf(src)} -> ${quoteaf(dst)}\n`);
}

/** link(2) to an earlier copy or to the source (-l), replacing an existing destination. */
function* hardLink(r: Run, from: string, dst: string, replace: boolean): Op<boolean> {
  const { fs, p } = r;
  let res = attempt(() => fs.link(from, dst));
  if (!res.ok && res.code === 'EEXIST' && replace) {
    const un = attempt(() => fs.unlink(dst));
    if (!un.ok) {
      yield* warn(p, `cannot remove ${quoteaf(dst)}: ${strerror(un.code)}`);
      return false;
    }
    if (r.x.verbose) yield* p.write(1, `removed ${quoteaf(dst)}\n`);
    res = attempt(() => fs.link(from, dst));
  }
  if (!res.ok) {
    yield* warn(p, `cannot create hard link ${quoteaf(dst)} to ${quoteaf(from)}: ${strerror(res.code)}`);
    return false;
  }
  return true;
}

/** Owner, then mode, then nothing else: the tail of copy_reg and copy_internal. */
function* preserveAttributes(r: Run, src: string, dst: string, srcSb: Stat, dstSb: Stat | undefined, newDst: boolean, isDir: boolean, created: { mode: number; restore: boolean; omitted: number }): Op<boolean> {
  const { fs, p, x } = r;
  if (x.preserveTimestamps) {
    const t = attempt(() => fs.utimes(dst, srcSb.mtime));
    if (!t.ok) {
      yield* warn(p, `preserving times for ${quoteaf(dst)}: ${strerror(t.code)}`);
      if (x.requirePreserve) return false;
    }
  }
  let srcMode = srcSb.mode;
  if (x.preserveOwnership && (newDst || !dstSb || dstSb.uid !== srcSb.uid || dstSb.gid !== srcSb.gid)) {
    const ch = attempt(() => fs.chown(dst, srcSb.uid, srcSb.gid));
    if (!ch.ok) {
      if (ch.code === 'EPERM' || ch.code === 'EINVAL') attempt(() => fs.chown(dst, -1, srcSb.gid));
      // chown_failure_ok: without CAP_CHOWN, EPERM and EINVAL are expected and ignored.
      if (!((ch.code === 'EPERM' || ch.code === 'EINVAL') && !r.root)) {
        yield* warn(p, `failed to preserve ownership for ${quoteaf(dst)}: ${strerror(ch.code)}`);
        if (x.requirePreserve) return false;
      }
      srcMode &= ~SPECIAL;
    }
  }
  if (x.preserveMode) {
    const m = attempt(() => fs.chmod(dst, srcMode));
    if (!m.ok) {
      yield* warn(p, `preserving permissions for ${quoteaf(dst)}: ${strerror(m.code)}`);
      if (x.requirePreserve) return false;
    }
    return true;
  }
  if (x.explicitNoPreserveMode && newDst) {
    const m = attempt(() => fs.chmod(dst, (isDir ? 0o777 : 0o666) & ~r.umask));
    return m.ok;
  }
  let restore = created.restore;
  let mode = created.mode;
  const omitted = created.omitted & ~r.umask;
  if (omitted && !restore) {
    const now = attempt(() => fs.lstat(dst));
    if (newDst && !now.ok) {
      yield* warn(p, `cannot stat ${quoteaf(dst)}: ${strerror(now.code)}`);
      return false;
    }
    if (now.ok) mode = now.value.mode;
    if (omitted & ~mode) restore = true;
  }
  if (restore) {
    const m = attempt(() => fs.chmod(dst, mode | omitted));
    if (!m.ok) {
      yield* warn(p, `preserving permissions for ${quoteaf(dst)}: ${strerror(m.code)}`);
      if (x.requirePreserve) return false;
    }
  }
  return true;
}

/** copy_reg: open the source, create or truncate the destination, write the data. */
function* copyRegular(r: Run, src: string, dst: string, srcSb: Stat, dstSb: Stat | undefined, newDstIn: boolean): Op<boolean> {
  const { fs, p, x } = r;
  const opened = attempt(() => fs.open(src, { read: true }));
  if (!opened.ok) {
    yield* warn(p, `cannot open ${quoteaf(src)} for reading: ${strerror(opened.code)}`);
    return false;
  }
  const inode = fs.machine.vfs.inodes[opened.value];
  let data = '';
  let program: { program: string; size: number } | undefined;
  if (inode?.type === 'program') program = { program: inode.program, size: inode.size };
  else if (x.dataCopy) {
    try {
      data = fs.readFile(src);
    } catch (e) {
      if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: `copying ${e.what}` });
      throw e;
    }
  }
  let newDst = newDstIn;
  let destErr: Errno | undefined;
  if (!newDst) {
    // An existing destination keeps its inode and mode: open(O_WRONLY|O_TRUNC).
    let o: ReturnType<typeof attempt<string>>;
    try {
      o = attempt(() => fs.open(dst, { write: true, truncate: x.dataCopy || program !== undefined }));
    } catch (e) {
      if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: e.what });
      throw e;
    }
    destErr = o.ok ? undefined : o.code;
    if (destErr !== undefined && destErr !== 'ENOENT' && x.unlinkAfterFailedOpen) {
      const un = attempt(() => fs.unlink(dst));
      if (un.ok) {
        if (x.verbose) yield* p.write(1, `removed ${quoteaf(dst)}\n`);
      } else if (un.code !== 'ENOENT') {
        yield* warn(p, `cannot remove ${quoteaf(dst)}: ${strerror(un.code)}`);
        return false;
      }
      destErr = 'ENOENT';
    }
    if (destErr === undefined) {
      const mode = dstSb ? dstSb.mode : srcSb.mode & 0o777;
      try {
        const w = attempt(() => {
          if (program) {
            // The binary content of an executable stub is its program: the destination becomes a
            // stub too (a new inode, where the real cp rewrites the old one's data).
            fs.unlink(dst);
            fsWithUmask(p, 0).installProgram(dst, program.program, { size: program.size, mode });
          } else if (x.dataCopy && data !== '') fs.writeFile(dst, data);
        });
        if (!w.ok) {
          yield* warn(p, `cannot create regular file ${quoteaf(dst)}: ${strerror(w.code)}`);
          return false;
        }
      } catch (e) {
        if (e instanceof UnsupportedError) return yield* p.unsupported({ kind: 'behavior', what: e.what });
        throw e;
      }
    }
    if (destErr === 'ENOENT') newDst = true;
  }
  const createdMode = srcSb.mode & 0o777;
  if (newDst) {
    const mode = createdMode;
    const c = attempt(() => {
      if (program) fs.installProgram(dst, program.program, { size: program.size, mode });
      else fs.writeFile(dst, x.dataCopy ? data : '', { exclusive: true, mode });
    });
    if (!c.ok) {
      let code = c.code;
      if (code === 'EEXIST' && attempt(() => fs.readlink(dst)).ok) {
        yield* warn(p, `not writing through dangling symlink ${quoteaf(dst)}`);
        return false;
      }
      if (code === 'EISDIR' && dst.endsWith('/')) code = 'ENOTDIR';
      yield* warn(p, `cannot create regular file ${quoteaf(dst)}: ${strerror(code)}`);
      return false;
    }
  } else if (destErr !== undefined) {
    yield* warn(p, `cannot create regular file ${quoteaf(dst)}: ${strerror(destErr)}`);
    return false;
  }
  return yield* preserveAttributes(r, src, dst, srcSb, dstSb, newDst, false, { mode: createdMode, restore: false, omitted: 0 });
}

/** copy_internal for one source and destination. */
function* copyOne(r: Run, src: string, dst: string, top: boolean, topSrc: string, topDst: string, newDstIn: boolean): Op<boolean> {
  const { fs, p, x } = r;
  const derefSrc = x.deref === 'always' || (x.deref === 'command-line' && top);
  const s = attempt(() => (x.deref === 'never' ? fs.lstat(src) : derefSrc ? fs.stat(src) : fs.lstat(src)));
  if (!s.ok) {
    yield* warn(p, `cannot stat ${quoteaf(src)}: ${strerror(s.code)}`);
    return false;
  }
  const srcSb = s.value;
  const srcIsDir = srcSb.type === 'dir';
  if (srcIsDir && !x.recursive) {
    yield* warn(p, `-r not specified; omitting directory ${quoteaf(src)}`);
    return false;
  }
  if (top && r.seen) {
    if (!srcIsDir && r.seen[srcSb.ino]) {
      yield* warn(p, `warning: source file ${quoteaf(src)} specified more than once`);
      return true;
    }
    r.seen[srcSb.ino] = true;
  }
  let newDst = newDstIn;
  let dstSb: Stat | undefined;
  if (!newDst) {
    const isReg = srcSb.type === 'file';
    const useLstat = !isReg || x.symbolicLink || x.hardLink || x.unlinkBeforeOpening;
    const d = attempt(() => (useLstat ? fs.lstat(dst) : fs.stat(dst)));
    if (d.ok) dstSb = d.value;
    else if (d.code === 'ENOENT') newDst = true;
    else if (!(d.code === 'ELOOP' && x.unlinkAfterFailedOpen)) {
      yield* warn(p, `cannot stat ${quoteaf(dst)}: ${strerror(d.code)}`);
      return false;
    }
  }
  if (dstSb) {
    if (x.interactive !== 'no' && x.interactive !== 'skip') {
      const ok = sameFileOk(fs, src, srcSb, dst, dstSb, {
        moveMode: false,
        hardLink: x.hardLink,
        symbolicLink: x.symbolicLink,
        derefNever: x.deref === 'never',
        unlinkDestBeforeOpening: x.unlinkBeforeOpening,
      });
      if (!ok) {
        yield* warn(p, `${quoteaf(src)} and ${quoteaf(dst)} are the same file`);
        return false;
      }
    }
    if (x.update && !srcIsDir && dstSb.mtime >= srcSb.mtime) return true;
    if (!srcIsDir) {
      if (x.interactive === 'no' || x.interactive === 'skip') return true;
      if (x.interactive === 'ask') {
        const q = overwriteQuestion(p, fs, dst, dstSb, x.unlinkBeforeOpening || x.unlinkAfterFailedOpen);
        return yield* p.unsupported({ kind: 'behavior', what: `answering cp's question "${q.trim()}"`, hints: ['use cp -f, or -n to skip existing files'] });
      }
    }
    if (dstSb.type !== 'dir') {
      if (srcIsDir) {
        yield* warn(p, `cannot overwrite non-directory ${quoteaf(dst)} with directory ${quoteaf(src)}`);
        return false;
      }
      if (top && r.created[dstSb.ino]) {
        yield* warn(p, `will not overwrite just-created ${quoteaf(dst)} with ${quoteaf(src)}`);
        return false;
      }
    }
    if (!srcIsDir && dstSb.type === 'dir') {
      yield* warn(p, `cannot overwrite directory ${quoteaf(dst)} with non-directory`);
      return false;
    }
    if (dstSb.type !== 'dir' && (x.unlinkBeforeOpening || (x.preserveLinks && dstSb.nlink > 1) || (x.deref === 'never' && srcSb.type !== 'file'))) {
      const un = attempt(() => fs.unlink(dst));
      if (!un.ok && un.code !== 'ENOENT') {
        yield* warn(p, `cannot remove ${quoteaf(dst)}: ${strerror(un.code)}`);
        return false;
      }
      newDst = true;
      dstSb = undefined;
      if (x.verbose) yield* p.write(1, `removed ${quoteaf(dst)}\n`);
    }
  }
  if (!srcIsDir) yield* verbose(r, src, dst);

  // remember_copied: directories against copying into themselves, hard links with --preserve=links.
  let earlier: string | undefined;
  if (x.recursive && srcIsDir) {
    earlier = r.copied[srcSb.ino];
    if (top && earlier === undefined) r.copied[srcSb.ino] = dst;
  } else if (x.preserveLinks && !x.hardLink && (srcSb.nlink > 1 || (top && x.deref === 'command-line') || x.deref === 'always')) {
    earlier = r.copied[srcSb.ino];
    if (earlier === undefined) r.copied[srcSb.ino] = dst;
  }
  if (earlier !== undefined) {
    if (srcIsDir) {
      if (sameName(fs, src, earlier)) {
        yield* warn(p, `cannot copy a directory, ${quoteaf(topSrc)}, into itself, ${quoteaf(topDst)}`);
        return false;
      }
      if (sameName(fs, dst, earlier)) {
        yield* warn(p, `warning: source directory ${quoteaf(topSrc)} specified more than once`);
        return true;
      }
      if (!(x.deref === 'always' || (top && x.deref === 'command-line'))) {
        yield* warn(p, `will not create hard link ${quoteaf(dst)} to directory ${quoteaf(earlier)}`);
        return false;
      }
    } else {
      return yield* hardLink(r, earlier, dst, true);
    }
  }

  let ok = true;
  if (srcIsDir) {
    const dstMode = srcSb.mode & 0o7777;
    let omitted = dstMode & (x.preserveOwnership ? S_IRWXGO : S_IWGO);
    let createdMode = 0;
    let restore = false;
    if (newDst || !dstSb || dstSb.type !== 'dir') {
      const mk = attempt(() => fs.mkdir(dst, dstMode & ~omitted));
      if (!mk.ok) {
        yield* warn(p, `cannot create directory ${quoteaf(dst)}: ${strerror(mk.code)}`);
        return false;
      }
      const st = attempt(() => fs.lstat(dst));
      if (!st.ok) {
        yield* warn(p, `cannot stat ${quoteaf(dst)}: ${strerror(st.code)}`);
        return false;
      }
      createdMode = st.value.mode;
      // The new directory must be writable and searchable while it is filled.
      if ((createdMode & S_IRWXU) !== S_IRWXU) {
        restore = true;
        const ch = attempt(() => fs.chmod(dst, createdMode | S_IRWXU));
        if (!ch.ok) {
          yield* warn(p, `setting permissions for ${quoteaf(dst)}: ${strerror(ch.code)}`);
          return false;
        }
      }
      if (top) r.copied[st.value.ino] = dst;
      yield* verbose(r, src, dst);
      if (top) r.created[st.value.ino] = true;
    } else {
      omitted = 0;
    }
    const names = attempt(() => fs.readdir(src));
    if (!names.ok) {
      yield* warn(p, `cannot access ${quoteaf(src)}: ${strerror(names.code)}`);
      ok = false;
    } else {
      for (const n of names.value) ok = (yield* copyOne(r, joinPath(src, n), joinPath(dst, n), false, topSrc, topDst, false)) && ok;
    }
    const tail = yield* preserveAttributes(r, src, dst, srcSb, dstSb, newDst, true, { mode: createdMode, restore, omitted });
    return ok && tail;
  }
  if (x.symbolicLink) {
    if (!src.startsWith('/')) {
      const parent = dirName(dst);
      const dot = attempt(() => fs.stat('.'));
      const par = attempt(() => fs.stat(parent));
      const inCwd = parent === '.' || !dot.ok || !par.ok || dot.value.ino === par.value.ino;
      if (!inCwd) {
        yield* warn(p, `${quotef(dst)}: can make relative symbolic links only in current directory`);
        return false;
      }
    }
    const sl = attempt(() => fs.symlink(src, dst));
    if (!sl.ok) {
      yield* warn(p, `cannot create symbolic link ${quoteaf(dst)} to ${quoteaf(src)}: ${strerror(sl.code)}`);
      return false;
    }
  } else if (x.hardLink) {
    // -L/-H link to what a symbolic link names; -P links the link itself.
    const from = srcSb.type !== 'symlink' && derefSrc ? (attempt(() => fs.realpath(src)).ok ? fs.realpath(src) : src) : src;
    if (!(yield* hardLink(r, from, dst, !dstSb || x.unlinkAfterFailedOpen))) return false;
  } else if (srcSb.type === 'symlink') {
    const target = attempt(() => fs.readlink(src));
    if (!target.ok) {
      yield* warn(p, `cannot read symbolic link ${quoteaf(src)}: ${strerror(target.code)}`);
      return false;
    }
    const sl = attempt(() => fs.symlink(target.value, dst));
    if (!sl.ok) {
      yield* warn(p, `cannot create symbolic link ${quoteaf(dst)}: ${strerror(sl.code)}`);
      return false;
    }
  } else if (srcSb.type === 'char' && x.recursive) {
    return yield* p.unsupported({ kind: 'behavior', what: `copying the special file ${quoteaf(src)} (mknod)` });
  } else {
    return yield* copyRegular(r, src, dst, srcSb, dstSb, newDst);
  }
  if (top) {
    const st = attempt(() => fs.lstat(dst));
    if (st.ok) r.created[st.value.ino] = true;
  }
  return ok;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const x: Options = {
    deref: 'undefined',
    recursive: false,
    preserveMode: false,
    preserveOwnership: false,
    preserveTimestamps: false,
    preserveLinks: false,
    requirePreserve: false,
    explicitNoPreserveMode: false,
    hardLink: false,
    symbolicLink: false,
    interactive: 'unspecified',
    update: false,
    unlinkAfterFailedOpen: false,
    unlinkBeforeOpening: false,
    dataCopy: true,
    verbose: false,
  };
  let targetDir: string | undefined;
  let stripSlashes = false;
  for (const o of args.options) {
    switch (o.id) {
      case 'archive':
        x.deref = 'never';
        x.preserveLinks = x.preserveOwnership = x.preserveMode = x.preserveTimestamps = x.requirePreserve = true;
        x.recursive = true;
        break;
      case 'attributes-only':
        x.dataCopy = false;
        break;
      case 'd':
        x.preserveLinks = true;
        x.deref = 'never';
        break;
      case 'force':
        x.unlinkAfterFailedOpen = true;
        break;
      case 'H':
        x.deref = 'command-line';
        break;
      case 'interactive':
        x.interactive = 'ask';
        break;
      case 'link':
        x.hardLink = true;
        break;
      case 'dereference':
        x.deref = 'always';
        break;
      case 'no-clobber':
        // reference: Ubuntu's coreutils 9.4 cp, captured 2026-11-16 (see the header).
        yield* warn(p, 'warning: behavior of -n is non-portable and may change in future; use --update=none instead');
        x.interactive = 'no';
        break;
      case 'no-dereference':
        x.deref = 'never';
        break;
      case 'no-preserve': {
        const d = decodePreserve(o.value as string, x, false);
        if (d.bad !== undefined) return yield* preserveArgError(p, d.bad, '--no-preserve');
        break;
      }
      case 'preserve':
        if (o.value !== undefined) {
          const d = decodePreserve(o.value, x, true);
          if (d.bad !== undefined) return yield* preserveArgError(p, d.bad, '--preserve');
          if (d.unsupported !== undefined) return yield* p.unsupported({ kind: 'flag', what: `the flag --preserve=${d.unsupported}`, hints: ['security contexts are not modeled'] });
          x.requirePreserve = true;
          break;
        }
        x.preserveOwnership = x.preserveMode = x.preserveTimestamps = x.requirePreserve = true;
        break;
      case 'p':
        x.preserveOwnership = x.preserveMode = x.preserveTimestamps = x.requirePreserve = true;
        break;
      case 'recursive':
        x.recursive = true;
        break;
      case 'remove-destination':
        x.unlinkBeforeOpening = true;
        break;
      case 'strip-trailing-slashes':
        stripSlashes = true;
        break;
      case 'symbolic-link':
        x.symbolicLink = true;
        break;
      case 'target-directory':
        if (targetDir !== undefined) {
          yield* warn(p, 'multiple target directories specified');
          return 1;
        }
        targetDir = o.value as string;
        break;
      case 'u':
        x.update = true;
        break;
      case 'update':
        if (o.value === undefined) x.update = true;
        else if (x.interactive !== 'no') {
          const u = matchUpdate(o.value);
          if (u === undefined) {
            yield* p.write(2, updateArgError(p.name, o.value));
            return 1;
          }
          x.update = u === 'older';
          x.interactive = u === 'none' ? 'skip' : 'unspecified';
        }
        break;
      case 'verbose':
        x.verbose = true;
        break;
    }
  }
  if (x.hardLink && x.symbolicLink) return yield* usageError(p, 'cannot make both hard and symbolic links');
  if (x.interactive === 'no') x.update = false;
  if (x.deref === 'undefined') x.deref = x.recursive && !x.hardLink ? 'never' : 'always';
  const fs = p.fs();
  const files = [...args.operands];
  let n = files.length;
  if (n <= (targetDir === undefined ? 1 : 0)) {
    if (n === 0) return yield* usageError(p, 'missing file operand');
    return yield* usageError(p, `missing destination file operand after ${quoteaf(files[0] as string)}`);
  }
  let newDst = false;
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
    const e = targetDirectoryError(fs, last);
    if (e === undefined) {
      targetDir = last;
      n -= 1;
    } else {
      if (e === 'ENOENT') newDst = true;
      if (n > 2) {
        yield* warn(p, `target ${quoteaf(last)}: ${strerror(e)}`);
        return 1;
      }
    }
  }
  const r: Run = {
    p,
    fs,
    x,
    root: p.cred.uid === 0,
    umask: umaskOf(p),
    copied: {},
    created: {},
    seen: targetDir !== undefined && n >= 2 ? {} : undefined,
  };
  const strip = (s: string): string => (stripSlashes ? s.replace(/(.)\/+$/, '$1') : s);
  let ok = true;
  if (targetDir !== undefined) {
    for (let i = 0; i < n; i++) {
      const src = strip(files[i] as string);
      let base = baseName(src);
      if (base === '..') base = '.';
      const dst = joinPath(targetDir, base);
      ok = (yield* copyOne(r, src, dst, true, src, dst, false)) && ok;
    }
  } else {
    const src = strip(files[0] as string);
    const dst = files[1] as string;
    ok = yield* copyOne(r, src, dst, true, src, dst, newDst);
  }
  return ok ? 0 : 1;
}

function* preserveArgError(p: ProcApi, bad: string, opt: string): Op<number> {
  const valid = PRESERVE_WORDS.map((w) => `  - ${quote(w)}`).join('\n');
  yield* p.write(2, `${p.name}: invalid argument ${quote(bad)} for ${quote(opt)}\nValid arguments are:\n${valid}\nTry '${p.name} --help' for more information.\n`);
  return 1;
}

export const cpProgram: ProgramSpec = { name: 'cp', main };
