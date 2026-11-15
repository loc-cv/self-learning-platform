// id — print real and effective user and group IDs. GNU coreutils 9.4.
//   docs: id --help and id(1) of coreutils 9.4
//   upstream: coreutils src/id.c main, print_full_info; src/group-list.c print_group_list
//   reference: coreutils 9.4 id, captured 2026-11-16 (packages/host/transcripts/coreutils/id.t)
// Without USER the process's credentials are shown (its supplementary groups in their order);
// with USER, the passwd entry and getgrouplist(3): the primary group, then every group in
// /etc/group that lists the user. Processes have no separate real and saved IDs: -r prints the
// same IDs, and euid=/egid= never appear.

import type { Op, ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { groupByGid, groupEntries, userByName, userByUid } from '../../users.ts';
import { parseArgs, warn } from '../lib/io.ts';
import { quote } from '../lib/quote.ts';
import type { OptionSpec } from '../lib/getopt.ts';

/** `id --help`; NUL stands for argv[0]. reference: coreutils 9.4, captured 2026-11-16 */
const HELP = "Usage: \u0000 [OPTION]... [USER]...\nPrint user and group information for each specified USER,\nor (when USER omitted) for the current process.\n\n  -a             ignore, for compatibility with other versions\n  -Z, --context  print only the security context of the process\n  -g, --group    print only the effective group ID\n  -G, --groups   print all group IDs\n  -n, --name     print a name instead of a number, for -ugG\n  -r, --real     print the real ID instead of the effective ID, with -ugG\n  -u, --user     print only the effective user ID\n  -z, --zero     delimit entries with NUL characters, not whitespace;\n                   not permitted in default format\n      --help        display this help and exit\n      --version     output version information and exit\n\nWithout any OPTION, print some useful set of identified information.\n\nGNU coreutils online help: <https://www.gnu.org/software/coreutils/>\nReport any translation bugs to <https://translationproject.org/team/>\nFull documentation <https://www.gnu.org/software/coreutils/id>\nor available locally via: info '(coreutils) id invocation'\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', id: 'a' },
  { short: 'Z', long: 'context' },
  { short: 'g', long: 'group' },
  { short: 'G', long: 'groups' },
  { short: 'n', long: 'name' },
  { short: 'r', long: 'real' },
  { short: 'u', long: 'user' },
  { short: 'z', long: 'zero' },
  { long: 'help' },
  { long: 'version' },
];

interface Ids {
  uid: number;
  gid: number;
  /** getgroups(2) or getgrouplist(3), in their order. */
  groups: number[];
}

/** A user operand: a name, or failing that a number (optionally with +), as parse_user_spec does. */
function lookupUser(p: ProcApi, spec: string): Ids | undefined {
  let user = userByName(p.ctx, p.machine, spec);
  if (!user && /^\+?[0-9]+$/.test(spec)) user = userByUid(p.ctx, p.machine, Number(spec.replace(/^\+/, '')));
  if (!user) return undefined;
  const groups = [user.gid];
  for (const g of groupEntries(p.ctx, p.machine)) if (g.members.includes(user.name) && !groups.includes(g.gid)) groups.push(g.gid);
  return { uid: user.uid, gid: user.gid, groups };
}

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const args = yield* parseArgs(p, { options: OPTIONS });
  if (typeof args === 'number') return args;
  if (args.has('help')) {
    yield* p.write(1, HELP.split('\u0000').join(p.argv[0] ?? p.name));
    return 0;
  }
  if (args.has('version')) return yield* p.unsupported({ kind: 'flag', what: 'the flag --version' });
  const justUser = args.has('user');
  const justGroup = args.has('group');
  const justList = args.has('groups');
  const context = args.has('context');
  const useName = args.has('name');
  const useReal = args.has('real');
  const zero = args.has('zero');
  // The checks of upstream main, in its order; each ends id with status 1 and no "Try" line.
  if (context && args.operands.length === 0) {
    yield* warn(p, '--context (-Z) works only on an SELinux-enabled kernel');
    return 1;
  }
  if (Number(justUser) + Number(justGroup) + Number(justList) + Number(context) > 1) {
    yield* warn(p, 'cannot print "only" of more than one choice');
    return 1;
  }
  const defaultFormat = !(justUser || justGroup || justList || context);
  if (defaultFormat && (useReal || useName)) {
    yield* warn(p, 'cannot print only names or real IDs in default format');
    return 1;
  }
  if (defaultFormat && zero) {
    yield* warn(p, 'option --zero not permitted in default format');
    return 1;
  }
  if (context) return yield* p.unsupported({ kind: 'flag', what: 'the flag -Z with a user' });

  const userName = (uid: number): string | undefined => userByUid(p.ctx, p.machine, uid)?.name;
  const groupName = (gid: number): string | undefined => groupByGid(p.ctx, p.machine, gid)?.name;
  const nameOf = function* (id: number, kind: 'user' | 'group'): Op<string> {
    const n = kind === 'user' ? userName(id) : groupName(id);
    if (n === undefined) return yield* p.unsupported({ kind: 'behavior', what: `id -n for a ${kind} ID without a name` });
    return n;
  };
  const show = function* (ids: Ids): Op<string> {
    const delim = zero ? '\0' : ' ';
    const end = zero ? '\0' : '\n';
    if (justUser) return (useName ? yield* nameOf(ids.uid, 'user') : String(ids.uid)) + end;
    if (justGroup) return (useName ? yield* nameOf(ids.gid, 'group') : String(ids.gid)) + end;
    if (justList) {
      // print_group_list: the real group first, then the others without repeating it.
      const list = [ids.gid, ...ids.groups.filter((g) => g !== ids.gid)];
      const parts: string[] = [];
      for (const g of list) parts.push(useName ? yield* nameOf(g, 'group') : String(g));
      return parts.join(delim) + end;
    }
    const named = (id: number, n: string | undefined) => (n === undefined ? String(id) : `${id}(${n})`);
    let line = `uid=${named(ids.uid, userName(ids.uid))} gid=${named(ids.gid, groupName(ids.gid))}`;
    if (ids.groups.length > 0) line += ` groups=${ids.groups.map((g) => named(g, groupName(g))).join(',')}`;
    return `${line}\n`;
  };

  if (args.operands.length === 0) {
    yield* p.write(1, yield* show({ uid: p.cred.uid, gid: p.cred.gid, groups: [...p.cred.groups] }));
    return 0;
  }
  let status = 0;
  for (const spec of args.operands) {
    const ids = lookupUser(p, spec);
    if (!ids) {
      yield* warn(p, `${quote(spec)}: no such user`);
      status = 1;
      continue;
    }
    yield* p.write(1, yield* show(ids));
  }
  return status;
}

export const idProgram: ProgramSpec = { name: 'id', main };
