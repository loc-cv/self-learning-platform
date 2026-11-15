// ls output: names with quoting, color and indicators; the long format; and the one-per-line,
// columns (-C), across (-x) and commas (-m) layouts, computed the way ls.c computes them.
//   upstream: coreutils src/ls.c print_current_files, print_long_format, print_many_per_line,
//             print_horizontal, print_with_separator, calculate_columns, init_column_info, indent,
//             print_file_name_and_frills, length_of_file_name_and_frills, print_name_with_quoting,
//             quote_name, get_type_indicator, format_user_or_group, put_indicator,
//             prep_non_filename_text, set_normal_color
//   reference: coreutils 9.4 ls -C/-x/-m/-1/-l at 80 columns and with -w, -T, captured 2026-11-16
//              (packages/host/transcripts/coreutils/ls*.t)

import { humanReadable } from '../lib/human.ts';
import { colorFor, isColored, S_IFCHR, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG, type ColorSubject } from './ls-color.ts';
import { byteLength, displayWidth, hideControlChars, quotearg, type QuotingOptions } from './ls-quote.ts';
import { isRecent, strftime } from './ls-time.ts';
import type { FileInfo, Listing, LsConfig } from './ls-types.ts';

/** What the output needs from the world. */
export interface LsWorld {
  now: number;
  userName(uid: number): string | undefined;
  groupName(gid: number): string | undefined;
  /** An unsupported strftime conversion in a time style. */
  onBadConversion(conversion: string): void;
}

/** Standard output being built, with the color state of put_indicator. */
export interface Out {
  text: string;
  usedColor: boolean;
}

const MIN_COLUMN_WIDTH = 3;

function putIndicator(cfg: LsConfig, out: Out, s: string | null): void {
  const colors = cfg.colors;
  if (!colors) return;
  if (!out.usedColor) {
    out.usedColor = true;
    prepNonFilenameText(cfg, out);
  }
  out.text += s ?? '';
}

function prepNonFilenameText(cfg: LsConfig, out: Out): void {
  const c = cfg.colors;
  if (!c) return;
  if (c.ind.ec !== null) putIndicator(cfg, out, c.ind.ec);
  else {
    putIndicator(cfg, out, c.ind.lc);
    putIndicator(cfg, out, c.ind.rs);
    putIndicator(cfg, out, c.ind.rc);
  }
}

export function setNormalColor(cfg: LsConfig, out: Out): void {
  const c = cfg.colors;
  if (c && isColored(c, 'no')) {
    putIndicator(cfg, out, c.ind.lc);
    putIndicator(cfg, out, c.ind.no);
    putIndicator(cfg, out, c.ind.rc);
  }
}

/** At exit: reset the terminal when the sequences are not the usual ANSI ones. */
export function restoreColor(cfg: LsConfig, out: Out): void {
  const c = cfg.colors;
  if (c && out.usedColor && !(c.ind.lc === '\x1b[' && c.ind.rc === 'm')) {
    putIndicator(cfg, out, c.ind.lc);
    putIndicator(cfg, out, c.ind.rc);
  }
}

/** quote_name_buf: the name as shown, whether quoting changed it, and its display width. */
export function quoteName(cfg: LsConfig, name: string, opts: QuotingOptions = cfg.quoting): { text: string; quoted: boolean; width: number } {
  let text = quotearg(name, opts);
  const quoted = text !== name;
  const s = opts.style;
  if (cfg.qmark && (s === 'shell' || s === 'shell-always' || s === 'literal')) text = hideControlChars(text);
  return { text, quoted, width: displayWidth(text) };
}

/** needs_quoting: whether quoting changes the name. */
export function needsQuoting(cfg: LsConfig, name: string): boolean {
  return quotearg(name, cfg.quoting) !== name;
}

/** Whether an unquoted name gets the alignment space. */
const padFor = (cfg: LsConfig, listing: Listing, quoted: boolean): boolean => cfg.alignQuotes && listing.someQuoted && !quoted;

export function fileNameWidth(cfg: LsConfig, listing: Listing, f: FileInfo): number {
  const q = quoteName(cfg, f.name);
  return q.width + (padFor(cfg, listing, q.quoted) ? 1 : 0);
}

const typeBits = (t: 'file' | 'dir' | 'symlink' | 'char'): number =>
  t === 'dir' ? S_IFDIR : t === 'symlink' ? S_IFLNK : t === 'char' ? S_IFCHR : S_IFREG;
export const modeOf = (st: { type: 'file' | 'dir' | 'symlink' | 'char'; mode: number }): number => typeBits(st.type) | st.mode;

/** get_type_indicator. */
export function typeIndicator(cfg: LsConfig, statOk: boolean, mode: number, type: FileInfo['type']): string {
  const fmt = mode & S_IFMT;
  if (statOk ? fmt === S_IFREG : type === 'file') return statOk && cfg.indicator === 'classify' && mode & 0o111 ? '*' : '';
  if (statOk ? fmt === S_IFDIR : type === 'dir' || type === 'argdir') return '/';
  if (cfg.indicator === 'slash') return '';
  if (statOk ? fmt === S_IFLNK : type === 'symlink') return '@';
  return '';
}

function colorSubject(cfg: LsConfig, f: FileInfo, target: boolean): ColorSubject {
  const type = f.type === 'argdir' ? 'dir' : f.type;
  if (target) {
    return { name: f.linkname ?? '', statOk: f.statOk, type, mode: f.linkmode, nlink: 1, linkok: f.linkok ? 0 : -1 };
  }
  const asReferent = cfg.colors?.linkAsReferent === true && f.linkok;
  return { name: f.name, statOk: f.statOk, type, mode: asReferent ? f.linkmode : f.mode, nlink: f.st?.nlink ?? 1, linkok: f.linkok ? 1 : 0 };
}

/** print_name_with_quoting: returns the width written, for the layouts. */
function printName(cfg: LsConfig, listing: Listing, out: Out, f: FileInfo, target: boolean, startCol: number): number {
  const name = target ? (f.linkname ?? '') : f.name;
  const colors = cfg.colors;
  const color = colors ? colorFor(colors, colorSubject(cfg, f, target)) : null;
  const usedColorThisTime = colors !== null && (color !== null || isColored(colors, 'no'));
  const q = quoteName(cfg, name);
  const pad = !target && padFor(cfg, listing, q.quoted);
  if (pad) out.text += ' ';
  if (color !== null && colors) {
    if (isColored(colors, 'no')) {
      putIndicator(cfg, out, colors.ind.lc);
      putIndicator(cfg, out, colors.ind.rc);
    }
    putIndicator(cfg, out, colors.ind.lc);
    putIndicator(cfg, out, color);
    putIndicator(cfg, out, colors.ind.rc);
  }
  out.text += q.text;
  const len = byteLength(q.text) + (pad ? 1 : 0);
  if (usedColorThisTime && colors) {
    prepNonFilenameText(cfg, out);
    if (cfg.lineLength && Math.floor(startCol / cfg.lineLength) !== Math.floor((startCol + len - 1) / cfg.lineLength)) putIndicator(cfg, out, colors.ind.cl);
  }
  return q.width + (pad ? 1 : 0);
}

const inodeText = (f: FileInfo): string => (f.statOk && f.ino !== undefined ? f.ino : '?');
const blocksText = (cfg: LsConfig, f: FileInfo): string => (f.statOk ? humanReadable(f.blocks, cfg.human, 512, cfg.blockSize) : '?');

/** print_file_name_and_frills. */
function printFrills(cfg: LsConfig, listing: Listing, out: Out, f: FileInfo, startCol: number): number {
  setNormalColor(cfg, out);
  const commas = cfg.format === 'commas';
  if (cfg.printInode) out.text += `${inodeText(f).padStart(commas ? 0 : listing.widths.inode)} `;
  if (cfg.printBlockSize) {
    const b = blocksText(cfg, f);
    const pad = listing.widths.block && !commas ? listing.widths.block - displayWidth(b) : 0;
    out.text += `${' '.repeat(Math.max(0, pad))}${b} `;
  }
  if (cfg.printScontext) out.text += `${'?'.padStart(commas ? 0 : listing.widths.scontext)} `;
  let width = printName(cfg, listing, out, f, false, startCol);
  if (cfg.indicator !== 'none') {
    const c = typeIndicator(cfg, f.statOk, f.mode, f.type);
    out.text += c;
    width += c.length;
  }
  return width;
}

/** length_of_file_name_and_frills. */
function frillsLength(cfg: LsConfig, listing: Listing, f: FileInfo): number {
  const commas = cfg.format === 'commas';
  let len = 0;
  if (cfg.printInode) len += 1 + (commas ? inodeText(f).length : listing.widths.inode);
  if (cfg.printBlockSize) len += 1 + (commas ? blocksText(cfg, f).length : listing.widths.block);
  if (cfg.printScontext) len += 1 + (commas ? 1 : listing.widths.scontext);
  len += fileNameWidth(cfg, listing, f);
  if (cfg.indicator !== 'none') len += typeIndicator(cfg, f.statOk, f.mode, f.type) === '' ? 0 : 1;
  return len;
}

/** indent: blanks from column `from` to `to`, with tabs where they fit. */
function indent(cfg: LsConfig, from: number, to: number): string {
  let s = '';
  let pos = from;
  while (pos < to) {
    if (cfg.tabsize !== 0 && Math.floor(to / cfg.tabsize) > Math.floor((pos + 1) / cfg.tabsize)) {
      s += '\t';
      pos += cfg.tabsize - (pos % cfg.tabsize);
    } else {
      s += ' ';
      pos++;
    }
  }
  return s;
}

/** calculate_columns: how many columns fit, and their widths. */
function calculateColumns(cfg: LsConfig, listing: Listing, files: FileInfo[], byColumns: boolean): number[] {
  const n = files.length;
  let maxIdx = Math.floor(cfg.lineLength / MIN_COLUMN_WIDTH) + (cfg.lineLength % MIN_COLUMN_WIDTH !== 0 ? 1 : 0);
  if (maxIdx < 1) maxIdx = 1;
  const maxCols = Math.min(maxIdx, n);
  const info = Array.from({ length: maxCols }, (_, i) => ({
    valid: true,
    lineLen: (i + 1) * MIN_COLUMN_WIDTH,
    cols: Array.from({ length: i + 1 }, () => MIN_COLUMN_WIDTH),
  }));
  files.forEach((f, filesno) => {
    const nameLength = frillsLength(cfg, listing, f);
    for (let i = 0; i < maxCols; i++) {
      const ci = info[i] as (typeof info)[number];
      if (!ci.valid) continue;
      const idx = byColumns ? Math.floor(filesno / Math.floor((n + i) / (i + 1))) : filesno % (i + 1);
      const real = nameLength + (idx === i ? 0 : 2);
      const cur = ci.cols[idx] as number;
      if (cur < real) {
        ci.lineLen += real - cur;
        ci.cols[idx] = real;
        ci.valid = ci.lineLen < cfg.lineLength;
      }
    }
  });
  let cols = maxCols;
  for (; cols > 1; cols--) if ((info[cols - 1] as (typeof info)[number]).valid) break;
  return (info[Math.max(cols, 1) - 1] as (typeof info)[number]).cols;
}

function printManyPerLine(cfg: LsConfig, listing: Listing, out: Out, files: FileInfo[], eol: string): void {
  const widths = calculateColumns(cfg, listing, files, true);
  const cols = widths.length;
  const rows = Math.floor(files.length / cols) + (files.length % cols !== 0 ? 1 : 0);
  for (let row = 0; row < rows; row++) {
    let col = 0;
    let filesno = row;
    let pos = 0;
    for (;;) {
      const f = files[filesno] as FileInfo;
      const nameLength = frillsLength(cfg, listing, f);
      const maxNameLength = widths[col++] as number;
      printFrills(cfg, listing, out, f, pos);
      filesno += rows;
      if (filesno >= files.length) break;
      out.text += indent(cfg, pos + nameLength, pos + maxNameLength);
      pos += maxNameLength;
    }
    out.text += eol;
  }
}

function printHorizontal(cfg: LsConfig, listing: Listing, out: Out, files: FileInfo[], eol: string): void {
  const widths = calculateColumns(cfg, listing, files, false);
  const cols = widths.length;
  let pos = 0;
  let f = files[0] as FileInfo;
  printFrills(cfg, listing, out, f, 0);
  let nameLength = frillsLength(cfg, listing, f);
  let maxNameLength = widths[0] as number;
  for (let filesno = 1; filesno < files.length; filesno++) {
    const col = filesno % cols;
    if (col === 0) {
      out.text += eol;
      pos = 0;
    } else {
      out.text += indent(cfg, pos + nameLength, pos + maxNameLength);
      pos += maxNameLength;
    }
    f = files[filesno] as FileInfo;
    printFrills(cfg, listing, out, f, pos);
    nameLength = frillsLength(cfg, listing, f);
    maxNameLength = widths[col] as number;
  }
  out.text += eol;
}

function printWithSeparator(cfg: LsConfig, listing: Listing, out: Out, files: FileInfo[], sep: string, eol: string): void {
  let pos = 0;
  files.forEach((f, filesno) => {
    const len = cfg.lineLength ? frillsLength(cfg, listing, f) : 0;
    if (filesno !== 0) {
      let separator: string;
      if (!cfg.lineLength || pos + len + 2 < cfg.lineLength) {
        pos += 2;
        separator = ' ';
      } else {
        pos = 0;
        separator = eol;
      }
      out.text += sep + separator;
    }
    printFrills(cfg, listing, out, f, pos);
    pos += len;
  });
  out.text += eol;
}

/** filemodestring: `drwxr-sr-t`. */
export function modeString(mode: number): string {
  const fmt = mode & S_IFMT;
  const t = fmt === S_IFDIR ? 'd' : fmt === S_IFLNK ? 'l' : fmt === S_IFCHR ? 'c' : fmt === S_IFREG ? '-' : '?';
  const bit = (m: number, c: string): string => (mode & m ? c : '-');
  const special = (x: number, s: number, set: string, unset: string): string => (mode & s ? (mode & x ? set : unset) : mode & x ? 'x' : '-');
  return (
    t +
    bit(0o400, 'r') + bit(0o200, 'w') + special(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') + bit(0o020, 'w') + special(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') + bit(0o002, 'w') + special(0o001, 0o1000, 't', 'T')
  );
}

const FILETYPE_LETTER: Record<FileInfo['type'], string> = { unknown: '?', file: '-', dir: 'd', symlink: 'l', char: 'c', argdir: 'd' };

function userText(world: LsWorld, cfg: LsConfig, id: number, group: boolean): string {
  if (cfg.numericIds) return String(id);
  return (group ? world.groupName(id) : world.userName(id)) ?? String(id);
}

/** Widths of the long format and -s, -i columns, as gobble_file accumulates them. */
export function accumulateWidths(world: LsWorld, cfg: LsConfig, listing: Listing, f: FileInfo): void {
  const w = listing.widths;
  if (f.statOk && f.st) {
    const st = f.st;
    if (cfg.format === 'long' || cfg.printBlockSize) w.block = Math.max(w.block, displayWidth(blocksText(cfg, f)));
    if (cfg.format === 'long') {
      if (cfg.printOwner) w.owner = Math.max(w.owner, displayWidth(userText(world, cfg, st.uid, false)));
      if (cfg.printGroup) w.group = Math.max(w.group, displayWidth(userText(world, cfg, st.gid, true)));
      if (cfg.printAuthor) w.author = Math.max(w.author, displayWidth(userText(world, cfg, st.uid, false)));
    }
    if (cfg.printScontext) w.scontext = Math.max(w.scontext, 1);
    if (cfg.format === 'long') {
      w.nlink = Math.max(w.nlink, String(st.nlink).length);
      if (st.type === 'char') {
        const rdev = st.rdev ?? { major: 0, minor: 0 };
        w.major = Math.max(w.major, String(rdev.major).length);
        w.minor = Math.max(w.minor, String(rdev.minor).length);
        w.size = Math.max(w.size, w.major + 2 + w.minor);
      } else w.size = Math.max(w.size, displayWidth(humanReadable(st.size, cfg.fileHuman, 1, cfg.fileBlockSize)));
    }
  }
  if (cfg.printInode) w.inode = Math.max(w.inode, inodeText(f).length);
}

function timeOf(cfg: LsConfig, f: FileInfo): number {
  const st = f.st;
  if (!st) return 0;
  return cfg.time === 'ctime' ? st.ctime : st.mtime;
}

/** print_long_format: one line, without the newline. */
function printLong(world: LsWorld, cfg: LsConfig, listing: Listing, out: Out, f: FileInfo): void {
  const w = listing.widths;
  let buf = '';
  if (cfg.printInode) buf += `${inodeText(f).padStart(w.inode)} `;
  if (cfg.printBlockSize) {
    const b = blocksText(cfg, f);
    buf += `${' '.repeat(Math.max(0, w.block - displayWidth(b)))}${b} `;
  }
  const modebuf = f.statOk ? modeString(f.mode) : FILETYPE_LETTER[f.type] + '?'.repeat(9);
  buf += `${modebuf} ${(f.statOk && f.st ? String(f.st.nlink) : '?').padStart(w.nlink)} `;
  const st = f.st;
  const userOrGroup = (name: string | undefined, id: number, width: number): string => {
    if (name !== undefined) return name + ' '.repeat(Math.max(0, width - displayWidth(name)) + 1);
    return `${String(id).padStart(width)} `;
  };
  const nameOf = (id: number, group: boolean): string | undefined =>
    !f.statOk ? '?' : cfg.numericIds ? undefined : group ? world.groupName(id) : world.userName(id);
  if (cfg.printOwner || cfg.printGroup || cfg.printAuthor || cfg.printScontext) {
    out.text += buf;
    buf = '';
    if (cfg.printOwner) out.text += userOrGroup(nameOf(st?.uid ?? 0, false), st?.uid ?? 0, w.owner);
    if (cfg.printGroup) out.text += userOrGroup(nameOf(st?.gid ?? 0, true), st?.gid ?? 0, w.group);
    if (cfg.printAuthor) out.text += userOrGroup(nameOf(st?.uid ?? 0, false), st?.uid ?? 0, w.author);
    if (cfg.printScontext) out.text += userOrGroup('?', 0, w.scontext);
  }
  if (f.statOk && st && st.type === 'char') {
    const rdev = st.rdev ?? { major: 0, minor: 0 };
    const blanks = w.size - (w.major + 2 + w.minor);
    buf += `${String(rdev.major).padStart(w.major + Math.max(0, blanks))}, ${String(rdev.minor).padStart(w.minor)} `;
  } else {
    const size = !f.statOk || !st ? '?' : humanReadable(st.size, cfg.fileHuman, 1, cfg.fileBlockSize);
    buf += `${' '.repeat(Math.max(0, w.size - displayWidth(size)))}${size} `;
  }
  if (f.statOk) {
    const t = timeOf(cfg, f);
    const fmt = isRecent(t, world.now) ? cfg.timeFormats[1] : cfg.timeFormats[0];
    const r = strftime(fmt, t);
    if (!r.ok) world.onBadConversion(r.conversion);
    buf += `${r.ok ? r.text : ''} `;
  } else {
    // long_time_expected_width: the width of a time in the format for old files.
    const r = strftime(cfg.timeFormats[0], 0);
    buf += `${'?'.padStart(r.ok ? displayWidth(r.text) : 0)} `;
  }
  out.text += buf;
  const startCol = byteLength(buf);
  const wName = printName(cfg, listing, out, f, false, startCol);
  if (f.type === 'symlink') {
    if (f.linkname !== undefined) {
      out.text += ' -> ';
      printName(cfg, listing, out, f, true, startCol + wName + 4);
      if (cfg.indicator !== 'none') out.text += typeIndicator(cfg, true, f.linkmode, 'unknown');
    }
  } else if (cfg.indicator !== 'none') out.text += typeIndicator(cfg, f.statOk, f.mode, f.type);
}

/** print_current_files. */
export function printFiles(world: LsWorld, cfg: LsConfig, listing: Listing, out: Out, files: FileInfo[]): void {
  const eol = '\n';
  switch (cfg.format) {
    case 'one':
      for (const f of files) {
        printFrills(cfg, listing, out, f, 0);
        out.text += eol;
      }
      break;
    case 'many':
      if (!cfg.lineLength) printWithSeparator(cfg, listing, out, files, ' ', eol);
      else printManyPerLine(cfg, listing, out, files, eol);
      break;
    case 'horizontal':
      if (!cfg.lineLength) printWithSeparator(cfg, listing, out, files, ' ', eol);
      else printHorizontal(cfg, listing, out, files, eol);
      break;
    case 'commas':
      printWithSeparator(cfg, listing, out, files, ',', eol);
      break;
    case 'long':
      for (const f of files) {
        setNormalColor(cfg, out);
        printLong(world, cfg, listing, out, f);
        out.text += eol;
      }
      break;
  }
}

/** The `total` line of a directory in the long format or with -s. */
export function totalLine(cfg: LsConfig, listing: Listing): string {
  return `total ${humanReadable(listing.totalBlocks, cfg.human, 512, cfg.blockSize)}\n`;
}
