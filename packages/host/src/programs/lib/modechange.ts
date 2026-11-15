// Symbolic and octal file modes as chmod(1), mkdir -m and install -m take them, and the
// `rwxr-xr-x` rendering of permission bits.
//   upstream: gnulib lib/modechange.c (coreutils 9.4 tarball) mode_compile, mode_adjust,
//             mode_create_from_ref; gnulib lib/filemode.c strmode
//   reference: coreutils 9.4 chmod -v, captured 2026-11-16 (packages/host/transcripts/coreutils/chmod.t)

const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;
const S_IRWXU = 0o700;
const S_IRWXG = 0o070;
const S_IRWXO = 0o007;
const S_IRWXUGO = 0o777;
const R_ALL = 0o444;
const W_ALL = 0o222;
const X_ALL = 0o111;
/** CHMOD_MODE_BITS */
const ALL = 0o7777;

type Flag = 'ordinary' | 'copy' | 'x-if-any-x';

/** One mode-change directive (struct mode_change). Plain data. */
export interface ModeChange {
  op: '=' | '+' | '-';
  flag: Flag;
  affected: number;
  value: number;
  mentioned: number;
}

const equals = (mode: number, mentioned: number): ModeChange[] => [
  { op: '=', flag: 'ordinary', affected: ALL, value: mode, mentioned },
];

const isOctal = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '7';

/** mode_compile: the directives of MODE, or null when it is invalid. */
export function compileMode(s: string): ModeChange[] | null {
  if (isOctal(s[0])) {
    let n = 0;
    let i = 0;
    for (; isOctal(s[i]); i++) {
      n = n * 8 + Number(s[i]);
      if (n > ALL) return null;
    }
    if (i < s.length) return null;
    // Fewer than five digits leave a directory's set-user-ID and set-group-ID bits alone unless set.
    const mentioned = i < 5 ? (n & (S_ISUID | S_ISGID)) | S_ISVTX | S_IRWXUGO : ALL;
    return equals(n, mentioned);
  }
  const out: ModeChange[] = [];
  let i = 0;
  for (;;) {
    let affected = 0;
    for (; ; i++) {
      const c = s[i];
      if (c === 'u') affected |= S_ISUID | S_IRWXU;
      else if (c === 'g') affected |= S_ISGID | S_IRWXG;
      else if (c === 'o') affected |= S_ISVTX | S_IRWXO;
      else if (c === 'a') affected |= ALL;
      else if (c === '=' || c === '+' || c === '-') break;
      else return null;
    }
    do {
      const op = s[i++] as '=' | '+' | '-';
      let value = 0;
      let mentioned = 0;
      let flag: Flag = 'copy';
      const c = s[i];
      if (isOctal(c)) {
        let n = 0;
        for (; isOctal(s[i]); i++) {
          n = n * 8 + Number(s[i]);
          if (n > ALL) return null;
        }
        if (affected || (i < s.length && s[i] !== ',')) return null;
        affected = mentioned = ALL;
        value = n;
        flag = 'ordinary';
      } else if (c === 'u') {
        value = S_IRWXU;
        i++;
      } else if (c === 'g') {
        value = S_IRWXG;
        i++;
      } else if (c === 'o') {
        value = S_IRWXO;
        i++;
      } else {
        flag = 'ordinary';
        for (; ; i++) {
          const v = s[i];
          if (v === 'r') value |= R_ALL;
          else if (v === 'w') value |= W_ALL;
          else if (v === 'x') value |= X_ALL;
          else if (v === 'X') flag = 'x-if-any-x';
          else if (v === 's') value |= S_ISUID | S_ISGID;
          else if (v === 't') value |= S_ISVTX;
          else break;
        }
      }
      out.push({ op, flag, affected, value, mentioned: mentioned ? mentioned : affected ? affected & value : value });
    } while (s[i] === '=' || s[i] === '+' || s[i] === '-');
    if (s[i] !== ',') break;
    i++;
  }
  return i === s.length ? out : null;
}

/** mode_create_from_ref: set every mode bit to that of a reference file. */
export function modeFromReference(mode: number): ModeChange[] {
  return equals(mode & ALL, ALL);
}

/**
 * mode_adjust: the new permission bits of a file with `old` bits after `changes`, with `umask`
 * applied where no "who" was given. `bits` receives the bits the changes touched.
 */
export function adjustMode(old: number, dir: boolean, umask: number, changes: readonly ModeChange[]): { mode: number; bits: number } {
  let mode = old & ALL;
  let bits = 0;
  for (const ch of changes) {
    const omit = (dir ? S_ISUID | S_ISGID : 0) & ~ch.mentioned;
    let value = ch.value;
    if (ch.flag === 'copy') {
      value &= mode;
      value |= (value & R_ALL ? R_ALL : 0) | (value & W_ALL ? W_ALL : 0) | (value & X_ALL ? X_ALL : 0);
    } else if (ch.flag === 'x-if-any-x') {
      if (mode & X_ALL || dir) value |= X_ALL;
    }
    value &= (ch.affected ? ch.affected : ~umask) & ~omit;
    if (ch.op === '=') {
      const preserved = (ch.affected ? ~ch.affected : 0) | omit;
      bits |= ALL & ~preserved;
      mode = (mode & preserved) | value;
    } else if (ch.op === '+') {
      bits |= value;
      mode |= value;
    } else {
      bits |= value;
      mode &= ~value;
    }
  }
  return { mode: mode & ALL, bits: bits & ALL };
}

/** strmode without the type letter: `rwsr-xr-T`. upstream: gnulib lib/filemode.c */
export function permString(mode: number): string {
  const tri = (r: number, w: number, x: number, special: boolean, set: string, unset: string): string =>
    (mode & r ? 'r' : '-') + (mode & w ? 'w' : '-') + (special ? (mode & x ? set : unset) : mode & x ? 'x' : '-');
  return (
    tri(0o400, 0o200, 0o100, (mode & S_ISUID) !== 0, 's', 'S') +
    tri(0o040, 0o020, 0o010, (mode & S_ISGID) !== 0, 's', 'S') +
    tri(0o004, 0o002, 0o001, (mode & S_ISVTX) !== 0, 't', 'T')
  );
}

/** Four octal digits, as chmod -v prints a mode. */
export const octal4 = (mode: number): string => (mode & ALL).toString(8).padStart(4, '0');
