// What cp and mv share: the same-file test, the "writable destination" test behind their
// prompts, the --update argument, and how the last operand becomes a target directory.
//   upstream: coreutils 9.4 src/copy.c same_file_ok, writable_destination, overwrite_ok;
//             src/cp.c do_copy and src/mv.c main (target directory handling);
//             src/system.h target_directory_operand; gnulib lib/same.c same_nameat

import type { ProcApi } from '../../proc/program.ts';
import type { Errno } from '../../vfs/errno.ts';
import { ACCESS, type Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import { attempt, baseName, dirName } from './fsutil.ts';
import { octal4, permString } from './modechange.ts';
import { quoteaf } from './quote.ts';

/** same_nameat: both names are the same entry of the same directory. */
export function sameName(fs: Fs, a: string, b: string): boolean {
  if (baseName(a) !== baseName(b)) return false;
  const da = attempt(() => fs.stat(dirName(a)));
  const db = attempt(() => fs.stat(dirName(b)));
  return da.ok && db.ok && da.value.ino === db.value.ino;
}

export interface SameFileOptions {
  moveMode: boolean;
  hardLink: boolean;
  symbolicLink: boolean;
  /** DEREF_NEVER */
  derefNever: boolean;
  unlinkDestBeforeOpening: boolean;
}

/** same_file_ok without backups: false means "'a' and 'b' are the same file". */
export function sameFileOk(fs: Fs, src: string, srcSb: Stat, dst: string, dstSb: Stat, x: SameFileOptions): boolean {
  const isLnk = (s: Stat) => s.type === 'symlink';
  const same = srcSb.ino === dstSb.ino;
  if (same && x.hardLink) return true;
  let srcLink: Stat;
  let dstLink: Stat;
  let sameLink: boolean;
  if (x.derefNever) {
    sameLink = same;
    if (isLnk(srcSb) && isLnk(dstSb)) {
      const sn = sameName(fs, src, dst);
      if (!sn && sameLink) return !x.moveMode;
      return !sn;
    }
    srcLink = srcSb;
    dstLink = dstSb;
  } else {
    if (!same) return true;
    const d = attempt(() => fs.lstat(dst));
    const s = attempt(() => fs.lstat(src));
    if (!d.ok || !s.ok) return true;
    srcLink = s.value;
    dstLink = d.value;
    sameLink = srcLink.ino === dstLink.ino;
    if (isLnk(srcLink) && isLnk(dstLink) && x.unlinkDestBeforeOpening) return true;
  }
  if (x.moveMode || x.unlinkDestBeforeOpening) {
    if (isLnk(dstLink)) return true;
    if (sameLink && dstLink.nlink > 1 && !sameName(fs, src, dst)) return !x.moveMode;
  }
  if (!isLnk(srcLink) && !isLnk(dstLink)) {
    if (srcLink.ino !== dstLink.ino) return true;
    if (x.hardLink) return true;
  }
  if (x.moveMode && isLnk(srcSb) && dstLink.nlink > 1) {
    const abs = attempt(() => fs.realpath(src));
    if (abs.ok) return !sameName(fs, abs.value, dst);
  }
  if (x.symbolicLink && isLnk(dstLink)) return true;
  if (x.derefNever) {
    const s = isLnk(srcLink) ? attempt(() => fs.stat(src)) : { ok: true as const, value: srcLink };
    if (!s.ok) return true;
    const d = isLnk(dstLink) ? attempt(() => fs.stat(dst)) : { ok: true as const, value: dstLink };
    if (!d.ok) return true;
    if (s.value.ino !== d.value.ino) return true;
    if (x.hardLink) return true;
  }
  return false;
}

/** writable_destination: a symbolic link counts as writable; otherwise access(W_OK). */
export function writableDestination(fs: Fs, dst: string, st: Stat): boolean {
  return st.type === 'symlink' || attempt(() => fs.access(dst, ACCESS.W_OK)).ok;
}

/** The question overwrite_ok would ask. */
export function overwriteQuestion(p: ProcApi, fs: Fs, dst: string, st: Stat, unlinkStyle: boolean): string {
  if (!writableDestination(fs, dst, st)) {
    const mode = `${octal4(st.mode)} (${permString(st.mode)})`;
    return unlinkStyle
      ? `${p.name}: replace ${quoteaf(dst)}, overriding mode ${mode}? `
      : `${p.name}: unwritable ${quoteaf(dst)} (mode ${mode}); try anyway? `;
  }
  return `${p.name}: overwrite ${quoteaf(dst)}? `;
}

/** target_directory_operand: open(O_PATH|O_DIRECTORY), following symbolic links. */
export function targetDirectoryError(fs: Fs, d: string): Errno | undefined {
  const st = attempt(() => fs.stat(d));
  if (!st.ok) return st.code;
  return st.value.type === 'dir' ? undefined : 'ENOTDIR';
}

export type Update = 'all' | 'none' | 'older';

/** --update's argument (argmatch, abbreviations allowed); undefined when invalid. */
export function matchUpdate(arg: string): Update | undefined {
  const words: Update[] = ['all', 'none', 'older'];
  if ((words as string[]).includes(arg)) return arg as Update;
  const c = words.filter((w) => w.startsWith(arg));
  return arg !== '' && c.length === 1 ? c[0] : undefined;
}

/** argmatch's message for a bad --update argument. reference: coreutils 9.4 cp --update=x, captured 2026-11-16 */
export function updateArgError(prog: string, arg: string): string {
  return `${prog}: invalid argument ‘${arg}’ for ‘--update’\nValid arguments are:\n  - ‘all’\n  - ‘none’\n  - ‘older’\nTry '${prog} --help' for more information.\n`;
}
