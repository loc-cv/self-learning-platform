// Data shared by the parts of ls: the decoded options and one listed file (struct fileinfo).

import type { Stat } from '../../vfs/types.ts';
import type { HumanOptions } from '../lib/human.ts';
import type { Colors } from './ls-color.ts';
import type { QuotingOptions } from './ls-quote.ts';
import type { SortKey } from './ls-sort.ts';
import type { TimeFormats } from './ls-time.ts';

export type Format = 'long' | 'one' | 'many' | 'horizontal' | 'commas';
export type IndicatorStyle = 'none' | 'slash' | 'file-type' | 'classify';
export type Deref = 'never' | 'args' | 'args-dirs' | 'always';
/** filetype in ls.c: from the directory entry, or from stat. */
export type FileType = 'unknown' | 'file' | 'dir' | 'symlink' | 'char' | 'argdir';

export interface LsConfig {
  format: Format;
  /** -a: also . and ..; -A: dot files without them. */
  ignore: 'default' | 'dot-and-dotdot' | 'minimal';
  ignorePatterns: string[];
  hidePatterns: string[];
  immediateDirs: boolean;
  recursive: boolean;
  deref: Deref;
  sort: SortKey;
  reverse: boolean;
  dirsFirst: boolean;
  time: 'mtime' | 'ctime';
  timeFormats: TimeFormats;
  indicator: IndicatorStyle;
  printInode: boolean;
  printBlockSize: boolean;
  printOwner: boolean;
  printGroup: boolean;
  printAuthor: boolean;
  printScontext: boolean;
  numericIds: boolean;
  /** Sizes in the size column. */
  fileHuman: HumanOptions;
  fileBlockSize: number;
  /** Blocks (-s) and totals. */
  human: HumanOptions;
  blockSize: number;
  quoting: QuotingOptions;
  dirQuoting: QuotingOptions;
  qmark: boolean;
  /** Pad unquoted names by one space when some names in the listing are quoted. */
  alignQuotes: boolean;
  colors: Colors | null;
  checkSymlinkMode: boolean;
  lineLength: number;
  tabsize: number;
  /** -c, -u alone (without -l or -t) sort by that time. */
  formatNeedsStat: boolean;
  formatNeedsType: boolean;
}

export interface FileInfo {
  /** The name as listed: the operand as given, or the directory entry's name. */
  name: string;
  /** The path to reach it. */
  path: string;
  type: FileType;
  statOk: boolean;
  st?: Stat;
  /** st_mode with the type bits. */
  mode: number;
  /** Inode number from the directory entry or stat. */
  ino?: string;
  linkname?: string;
  linkok: boolean;
  /** st_mode of the link's target, 0 when not known. */
  linkmode: number;
  /** 512-byte blocks (ST_NBLOCKS). */
  blocks: number;
}

export interface Widths {
  inode: number;
  block: number;
  nlink: number;
  owner: number;
  group: number;
  author: number;
  scontext: number;
  size: number;
  major: number;
  minor: number;
}

export const emptyWidths = (): Widths => ({ inode: 0, block: 0, nlink: 0, owner: 0, group: 0, author: 0, scontext: 0, size: 0, major: 0, minor: 0 });

/** The files of one listing (cwd_file) and what is computed over them while they are gathered. */
export interface Listing {
  files: FileInfo[];
  someQuoted: boolean;
  widths: Widths;
  totalBlocks: number;
}
