// chown — change file owner and group. GNU coreutils 9.4.
//   docs: chown --help and chown(1) of coreutils 9.4; chown(2)
//   upstream: coreutils 9.4 src/chown.c main; src/chown-core.c change_file_owner,
//             describe_change, user_group_str; gnulib lib/userspec.c parse_user_spec_warn,
//             parse_with_separator
//   reference: coreutils 9.4 chown, captured 2026-11-16 (packages/host/transcripts/coreutils/chown.t)
// With -R, a directory is changed after its entries (fts postorder). Entries are visited in name
// order; the real order is the file system's. The VFS has no lchown(2): wherever chown would
// change a symbolic link itself (-h, or a link met with -R and -P), it prints the notice before
// changing anything.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { groupByGid, groupEntries, userByName, userByUid } from '../../users.ts';
import { strerror } from '../../vfs/errno.ts';
import type { Fs } from '../../vfs/fs.ts';
import type { Stat } from '../../vfs/types.ts';
import type { OptionSpec } from '../lib/getopt.ts';
import { attempt, ftsTrim, joinPath, rootIno, rootWarning } from '../lib/fsutil.ts';
import { parseArgs, usageError, warn } from '../lib/io.ts';
import { quote, quoteaf, quotef } from '../lib/quote.ts';

/** `chown --help`. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: chown [OPTION]... [OWNER][:[GROUP]] FILE...\n  or:  chown [OPTION]... --reference=RFILE FILE...\nChange the owner and/or group of each FILE to OWNER and/or GROUP.\nWith --reference, change the owner and group of each FILE to those of RFILE.\n\n  -c, --changes          like verbose but report only when a change is made\n  -f, --silent, --quiet  suppress most error messages\n  -v, --verbose          output a diagnostic for every file processed\n      --dereference      affect the referent of each symbolic link (this is\n                         the default), rather than the symbolic link itself\n  -h, --no-dereference   affect symbolic links instead of any referenced file\n                         (useful only on systems that can change the\n                         ownership of a symlink)\n      --from=CURRENT_OWNER:CURRENT_GROUP\n                         change the owner and/or group of each file only if\n                         its current owner and/or group match those specified\n                         here.  Either may be omitted, in which case a match\n                         is not required for the omitted attribute\n      --no-preserve-root  do not treat '/' specially (the default)\n      --preserve-root    fail to operate recursively on '/'\n      --reference=RFILE  use RFILE's owner and group rather than specifying\n                         OWNER:GROUP values.  RFILE is always dereferenced.\n  -R, --recursive        operate on files and directories recursively\n\nThe following options modify how a hierarchy is traversed when the -R\noption is also specified.  If more than one is specified, only the final\none takes effect.\n\n  -H                     if a command line argument is a symbolic link\n                         to a directory, traverse it\n  -L                     traverse every symbolic link to a directory\n                         encountered\n  -P                     do not traverse any symbolic links (default)\n\n      --help        display this help and exit\n      --version     output version information and exit\n\nOwner is unchanged if missing.  Group is unchanged if missing, but changed\nto login group if implied by a ':' following a symbolic OWNER.\nOWNER and GROUP may be numeric as well as symbolic.\n\nExamples:\n  chown root /u        Change the owner of /u to \"root\".\n  chown root:staff /u  Likewise, but also change its group to \"staff\".\n  chown -hR root /u    Change the owner of /u and subfiles to \"root\".\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/chown>\nor available locally via: info '(coreutils) chown invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'c', long: 'changes' },
  { short: 'f', long: 'silent' },
  { long: 'quiet', id: 'silent' },
  { short: 'v', long: 'verbose' },
  { long: 'dereference' },
  { short: 'h', long: 'no-dereference' },
  { long: 'from', arg: 'required' },
  { long: 'no-preserve-root' },
  { long: 'preserve-root' },
  { long: 'reference', arg: 'required' },
  { short: 'R', long: 'recursive' },
  { short: 'H', id: 'H' },
  { short: 'L', id: 'L', supported: false },
  { short: 'P', id: 'P' },
  { long: 'help' },
  { long: 'version' },
];

/** MAXUID / MAXGID: (uid_t) -1 is reserved. */
const MAXID = 0xfffffffe;

interface Spec {
  uid: number;
  gid: number;
  user: string | undefined;
  group: string | undefined;
}

/** xstrtoul(s, …, "") within the id range, or undefined. */
function numericId(s: string): number | undefined {
  if (!/^\s*\+?\d+$/.test(s)) return undefined;
  const n = Number(s.trim().replace(/^\+/, ''));
  return n <= MAXID ? n : undefined;
}

/** parse_with_separator: names looked up in /etc/passwd and /etc/group, then numbers. */
function parseWithSeparator(p: ProcApi, spec: string, sep: number): Spec | string {
  const u = sep < 0 ? (spec !== '' ? spec : undefined) : sep > 0 ? spec.slice(0, sep) : undefined;
  const g = sep < 0 || sep === spec.length - 1 ? undefined : spec.slice(sep + 1);
  let uid = -1;
  let gid = -1;
  let user: string | undefined;
  let group: string | undefined;
  if (u !== undefined) {
    const pw = u.startsWith('+') ? undefined : userByName(p.ctx, p.machine, u);
    if (!pw) {
      if (sep >= 0 && g === undefined) return 'invalid spec';
      const n = numericId(u);
      if (n === undefined) return 'invalid user';
      uid = n;
    } else {
      uid = pw.uid;
      user = u;
      if (g === undefined && sep >= 0) {
        // A separator and no group: the user's login group.
        gid = pw.gid;
        group = groupByGid(p.ctx, p.machine, gid)?.name ?? String(gid);
      }
    }
  }
  if (g !== undefined) {
    const gr = g.startsWith('+') ? undefined : groupEntries(p.ctx, p.machine).find((e) => e.name === g);
    if (!gr) {
      const n = numericId(g);
      if (n === undefined) return 'invalid group';
      gid = n;
    } else gid = gr.gid;
    group = g;
    // A numeric group gets no name (the lookup failed), as upstream drops groupname then.
    if (!gr) group = undefined;
  }
  return { uid, gid, user, group };
}

/** parse_user_spec_warn: `:` separates; failing that, a `.` does, with a warning. */
function parseUserSpec(p: ProcApi, spec: string): { spec?: Spec; error?: string; warn: boolean } {
  const colon = spec.indexOf(':');
  const r = parseWithSeparator(p, spec, colon);
  if (typeof r !== 'string') return { spec: r, warn: false };
  if (colon < 0) {
    const dot = spec.indexOf('.');
    if (dot >= 0) {
      const d = parseWithSeparator(p, spec, dot);
      if (typeof d !== 'string') return { spec: d, error: "warning: '.' should be ':'", warn: true };
    }
  }
  return { error: r, warn: false };
}

interface Run {
  p: ProcApi;
  fs: Fs;
  uid: number;
  gid: number;
  /** Names for messages (chopt.user_name, chopt.group_name). */
  user: string | undefined;
  group: string | undefined;
  requiredUid: number;
  requiredGid: number;
  recurse: boolean;
  /** -H: follow symbolic links given on the command line. */
  comfollow: boolean;
  /** chopt.affect_symlink_referent */
  referent: boolean;
  silent: boolean;
  verbosity: 'off' | 'changes' | 'high';
  root: string | undefined;
}

const uidName = (r: Run, uid: number): string => userByUid(r.p.ctx, r.p.machine, uid)?.name ?? String(uid);
const gidName = (r: Run, gid: number): string => groupByGid(r.p.ctx, r.p.machine, gid)?.name ?? String(gid);

/** user_group_str */
function userGroup(user: string | undefined, group: string | undefined): string | undefined {
  if (user !== undefined) return group !== undefined ? `${user}:${group}` : user;
  return group;
}

type Status = 'succeeded' | 'failed' | 'no-change';

/** describe_change */
function* describe(r: Run, file: string, status: Status, oldStats: Stat | undefined): Op<void> {
  const user = r.user ?? (r.uid !== -1 ? String(r.uid) : undefined);
  const group = r.group ?? (r.gid !== -1 ? String(r.gid) : undefined);
  const oldUser = oldStats ? uidName(r, oldStats.uid) : undefined;
  const oldGroup = oldStats ? gidName(r, oldStats.gid) : undefined;
  const spec = userGroup(user, group);
  const oldSpec = userGroup(user !== undefined ? oldUser : undefined, group !== undefined ? oldGroup : undefined);
  const q = quoteaf(file);
  let line: string;
  if (status === 'succeeded') {
    line = user !== undefined ? `changed ownership of ${q} from ${oldSpec} to ${spec}` : group !== undefined ? `changed group of ${q} from ${oldSpec} to ${spec}` : `no change to ownership of ${q}`;
  } else if (status === 'failed') {
    if (oldSpec !== undefined) {
      line = user !== undefined ? `failed to change ownership of ${q} from ${oldSpec} to ${spec}` : group !== undefined ? `failed to change group of ${q} from ${oldSpec} to ${spec}` : `failed to change ownership of ${q}`;
    } else {
      // Without the old ids, the new spec takes the old one's place in the format.
      line = user !== undefined ? `failed to change ownership of ${q} to ${spec}` : group !== undefined ? `failed to change group of ${q} to ${spec}` : `failed to change ownership of ${q}`;
    }
  } else {
    line = user !== undefined ? `ownership of ${q} retained as ${oldSpec}` : group !== undefined ? `group of ${q} retained as ${oldSpec}` : `ownership of ${q} retained`;
  }
  yield* r.p.write(1, `${line}\n`);
}

/** change_file_owner for one entry whose stats (as fts gave them) are `st`, or the error that stat gave. */
function* change(r: Run, file: string, st: Stat | undefined, error: string | undefined): Op<boolean> {
  let ok = true;
  let stats: Stat | undefined = st;
  let doChown: boolean;
  if (error !== undefined) {
    if (!r.silent) yield* warn(r.p, error);
    ok = false;
    doChown = false;
    stats = undefined;
  } else {
    const s = st as Stat;
    const fast = r.requiredUid === -1 && r.requiredGid === -1 && r.verbosity === 'off' && r.root === undefined && !r.referent;
    if (!fast && r.referent && s.type === 'symlink') {
      const t = attempt(() => r.fs.stat(file));
      if (!t.ok) {
        if (!r.silent) yield* warn(r.p, `cannot dereference ${quoteaf(file)}: ${strerror(t.code)}`);
        ok = false;
      } else stats = t.value;
    }
    const cur = stats as Stat;
    doChown = ok && (fast || ((r.requiredUid === -1 || r.requiredUid === cur.uid) && (r.requiredGid === -1 || r.requiredGid === cur.gid)));
  }
  if (ok && stats !== undefined && stats.type === 'dir' && r.root !== undefined && stats.ino === r.root) {
    for (const line of rootWarning(file)) yield* warn(r.p, line);
    return false;
  }
  if (doChown) {
    // lchown on a non-link is chown; a link itself was refused before anything changed.
    const res = attempt(() => r.fs.chown(file, r.uid, r.gid));
    ok = res.ok;
    if (!res.ok && !r.silent) {
      yield* warn(r.p, `${r.uid !== -1 ? 'changing ownership of' : 'changing group of'} ${quoteaf(file)}: ${strerror(res.code)}`);
    }
  }
  if (r.verbosity !== 'off') {
    const s = stats;
    const changed = doChown && ok && s !== undefined && !((r.uid === -1 || r.uid === s.uid) && (r.gid === -1 || r.gid === s.gid));
    if (changed || r.verbosity === 'high') yield* describe(r, file, !ok ? 'failed' : !changed ? 'no-change' : 'succeeded', stats);
  }
  return ok;
}

/** Stats fts gives an entry: command-line arguments are followed with -H or without -R. */
function statEntry(r: Run, file: string, top: boolean): { st?: Stat; code?: Parameters<typeof strerror>[0] } {
  const s = attempt(() => (top && r.comfollow ? r.fs.stat(file) : r.fs.lstat(file)));
  if (s.ok) return { st: s.value };
  // FTS_COMFOLLOW on a dangling link falls back to the link itself.
  if (top && r.comfollow) {
    const l = attempt(() => r.fs.lstat(file));
    if (l.ok) return { st: l.value };
  }
  return { code: s.code };
}

function* walk(r: Run, file: string, top: boolean): Op<boolean> {
  const e = statEntry(r, file, top);
  if (e.st === undefined) return yield* change(r, file, undefined, `cannot access ${quoteaf(file)}: ${strerror(e.code as Parameters<typeof strerror>[0])}`);
  const st = e.st;
  if (r.recurse && st.type === 'dir') {
    if (r.root !== undefined && st.ino === r.root) {
      for (const line of rootWarning(file)) yield* warn(r.p, line);
      return false;
    }
    const names = attempt(() => r.fs.readdir(file));
    if (!names.ok) return yield* change(r, file, undefined, `cannot read directory ${quoteaf(file)}: ${strerror(names.code)}`);
    let ok = true;
    for (const n of names.value) ok = (yield* walk(r, joinPath(file, n), false)) && ok;
    return (yield* change(r, file, st, undefined)) && ok;
  }
  return yield* change(r, file, st, undefined);
}

/** Finds a symbolic link chown would have to change itself (lchown), which the VFS cannot do. */
function linkToChange(r: Run, file: string, top: boolean): string | undefined {
  if (r.referent || (r.uid === -1 && r.gid === -1)) return undefined;
  const e = statEntry(r, file, top);
  if (e.st === undefined) return undefined;
  if (e.st.type === 'symlink') {
    const matches = (r.requiredUid === -1 || r.requiredUid === e.st.uid) && (r.requiredGid === -1 || r.requiredGid === e.st.gid);
    return matches ? file : undefined;
  }
  if (r.recurse && e.st.type === 'dir' && e.st.ino !== r.root) {
    const names = attempt(() => r.fs.readdir(file));
    if (names.ok) {
      for (const n of names.value) {
        const found = linkToChange(r, joinPath(file, n), false);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP);
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  let recurse = false;
  let comfollow = false;
  let dereference = -1;
  let preserveRoot = false;
  let silent = false;
  let verbosity: Run['verbosity'] = 'off';
  let reference: string | undefined;
  let requiredUid = -1;
  let requiredGid = -1;
  for (const o of args.options) {
    switch (o.id) {
      case 'H':
        comfollow = true;
        break;
      case 'P':
        comfollow = false;
        break;
      case 'no-dereference':
        dereference = 0;
        break;
      case 'dereference':
        dereference = 1;
        break;
      case 'no-preserve-root':
        preserveRoot = false;
        break;
      case 'preserve-root':
        preserveRoot = true;
        break;
      case 'reference':
        reference = o.value;
        break;
      case 'from': {
        const f = parseUserSpec(p, o.value as string);
        if (f.error !== undefined) {
          yield* warn(p, `${f.error}: ${quote(o.value as string)}`);
          if (!f.warn) return 1;
        }
        if (f.spec) {
          requiredUid = f.spec.uid;
          requiredGid = f.spec.gid;
        }
        break;
      }
      case 'recursive':
        recurse = true;
        break;
      case 'changes':
        verbosity = 'changes';
        break;
      case 'silent':
        silent = true;
        break;
      case 'verbose':
        verbosity = 'high';
        break;
    }
  }
  if (recurse) {
    if (!comfollow) {
      if (dereference === 1) {
        yield* warn(p, '-R --dereference requires either -H or -L');
        return 1;
      }
      dereference = 0;
    }
  } else comfollow = false;
  const operands = [...args.operands];
  if (operands.length < (reference !== undefined ? 1 : 2)) {
    if (operands.length === 0) return yield* usageError(p, 'missing operand');
    return yield* usageError(p, `missing operand after ${quote(p.argv[p.argv.length - 1] as string)}`);
  }
  const fs = p.fs();
  let spec: Spec;
  if (reference !== undefined) {
    const ref = attempt(() => fs.stat(reference as string));
    if (!ref.ok) {
      yield* warn(p, `failed to get attributes of ${quoteaf(reference)}: ${strerror(ref.code)}`);
      return 1;
    }
    const { uid, gid } = ref.value;
    spec = { uid, gid, user: userByUid(p.ctx, p.machine, uid)?.name ?? String(uid), group: groupByGid(p.ctx, p.machine, gid)?.name ?? String(gid) };
  } else {
    const arg = operands.shift() as string;
    const parsed = parseUserSpec(p, arg);
    if (parsed.error !== undefined) {
      yield* warn(p, `${parsed.error}: ${quote(arg)}`);
      if (!parsed.warn) return 1;
    }
    spec = parsed.spec as Spec;
    // A group and no user: messages say "ownership :GROUP" rather than "group GROUP".
    if (spec.user === undefined && spec.group !== undefined) spec = { ...spec, user: '' };
  }
  const r: Run = {
    p,
    fs,
    uid: spec.uid,
    gid: spec.gid,
    user: spec.user,
    group: spec.group,
    requiredUid,
    requiredGid,
    recurse,
    comfollow,
    referent: dereference !== 0,
    silent,
    verbosity,
    root: recurse && preserveRoot ? rootIno(fs) : undefined,
  };
  const files = operands.map(ftsTrim);
  for (const f of files) {
    const link = linkToChange(r, f, true);
    if (link !== undefined) {
      return yield* p.unsupported({
        kind: 'behavior',
        what: `changing the owner of the symbolic link ${quotef(link)} itself`,
        hints: ['the simulator cannot change a link itself (lchown); without -h chown changes what the link points to'],
      });
    }
  }
  let ok = true;
  for (const f of files) ok = (yield* walk(r, f, true)) && ok;
  return ok ? 0 : 1;
}

export const chownProgram: ProgramSpec = { name: 'chown', main };
