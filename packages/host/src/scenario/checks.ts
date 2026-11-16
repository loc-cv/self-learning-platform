// The host's checks (docs/SCENARIO_FORMAT.md §7.1): `shell.exec`, the escape hatch that runs a
// command and looks at its exit status and output, and `host.file`. Both run on the grader's fork
// of the session world, so whatever they type or leave behind is discarded with it.

import type { ArgsSchema, CheckCtx, CheckResult, CheckSpec, GapEvent, Json } from '@simlab/kernel';
import { groupByGid, userByUid } from '../users.ts';
import { createFs } from '../vfs/fs.ts';
import { FsError } from '../vfs/errno.ts';
import { ROOT_CRED, type Stat } from '../vfs/types.ts';
import { runLine, stepShell, stepTarget } from './shell.ts';
import { AS_SCHEMA, ON_SCHEMA } from './steps.ts';

/** Output matchers (§7.1): every key given must hold. */
export interface Matcher {
  equals?: string;
  contains?: string;
  notContains?: string;
  matches?: string;
}

const MATCHER_SCHEMA = (stream: string): ArgsSchema => ({
  type: 'object',
  description: `What ${stream} must satisfy; every key given must hold.`,
  properties: {
    equals: { type: 'string', description: 'Equal, after removing one trailing newline.' },
    contains: { type: 'string', minLength: 1, description: 'Contains this text.' },
    notContains: { type: 'string', minLength: 1, description: 'Does not contain this text.' },
    matches: { type: 'string', minLength: 1, description: 'Matches this regular expression (JavaScript syntax, multi-line: ^ and $ match at line ends).' },
  },
  additionalProperties: false,
  minProperties: 1,
});

/** The first matcher key that fails, described; undefined when all hold. */
export function matchFailure(text: string, m: Matcher): string | undefined {
  if (m.equals !== undefined && text.replace(/\n$/, '') !== m.equals) return `is not ${JSON.stringify(m.equals)}`;
  if (m.contains !== undefined && !text.includes(m.contains)) return `does not contain ${JSON.stringify(m.contains)}`;
  if (m.notContains !== undefined && text.includes(m.notContains)) return `contains ${JSON.stringify(m.notContains)}`;
  if (m.matches !== undefined && !new RegExp(m.matches, 'm').test(text)) return `does not match /${m.matches}/`;
  return undefined;
}

export function describeMatcher(stream: string, m: Matcher): string[] {
  const out: string[] = [];
  if (m.equals !== undefined) out.push(`${stream} is ${JSON.stringify(m.equals)}`);
  if (m.contains !== undefined) out.push(`${stream} contains ${JSON.stringify(m.contains)}`);
  if (m.notContains !== undefined) out.push(`${stream} does not contain ${JSON.stringify(m.notContains)}`);
  if (m.matches !== undefined) out.push(`${stream} matches /${m.matches}/`);
  return out;
}

/** Output shown in `observed`: short, one line per line, quoted. */
function excerpt(text: string): string {
  const t = text.replace(/\n$/, '');
  if (t === '') return 'nothing';
  const lines = t.split('\n');
  const shown = lines.slice(0, 4).join('\n');
  return JSON.stringify(lines.length > 4 ? `${shown}\n…` : shown);
}

interface ExecArgs {
  run: string;
  on?: string;
  as?: string;
  exit?: number;
  stdout?: Matcher;
  stderr?: Matcher;
}

/** Where the command's standard error goes on the fork; read back, then discarded with the fork. */
const STDERR_FILE = '/tmp/.simlab-check.stderr';

export const shellExecCheck: CheckSpec = {
  name: 'shell.exec',
  args: {
    type: 'object',
    properties: {
      run: { type: 'string', minLength: 1, description: 'The command line, run in a new shell on the fork.' },
      on: ON_SCHEMA,
      as: AS_SCHEMA,
      exit: { type: 'integer', minimum: 0, maximum: 255, description: 'The exit status it must end with; default 0.' },
      stdout: MATCHER_SCHEMA('standard output'),
      stderr: MATCHER_SCHEMA('standard error'),
    },
    required: ['run'],
    additionalProperties: false,
  },
  run(ctx: CheckCtx, raw: Json): CheckResult {
    const a = raw as unknown as ExecArgs;
    const exit = a.exit ?? 0;
    const expected = [`\`${a.run}\` exits with ${exit}`, ...describeMatcher('its output', a.stdout ?? {}), ...describeMatcher('its standard error', a.stderr ?? {})].join(', ');
    const { machine, user } = stepTarget(ctx.session, a.on, a.as);
    const gaps: GapEvent[] = [];
    let r;
    try {
      const login = stepShell(ctx.kernel, ctx.session, machine, user, 'host.check');
      const stop = ctx.session.listen({ gap: (g) => gaps.push(g) });
      // A group, so the status is the command's and only its standard error goes to the file.
      r = runLine(login, `{ ${a.run}\n} 2>${STDERR_FILE}`);
      stop();
    } catch (e) {
      return { pass: false, expected, observed: '', error: (e as Error).message };
    }
    if (gaps.length > 0) return { pass: false, expected, observed: '', error: `the command reached something the simulator does not support: ${gaps[0]?.what}` };
    const stderr = ctx.kernel.act('check.stderr', (c) => {
      try {
        return createFs(c, machine, { cred: ROOT_CRED, umask: 0 }).readFile(STDERR_FILE);
      } catch {
        return '';
      }
    });
    const problems: string[] = [];
    if (r.status !== exit) problems.push(`exited with ${r.status}`);
    const out = a.stdout ? matchFailure(r.output, a.stdout) : undefined;
    if (out) problems.push(`its output ${out}`);
    const err = a.stderr ? matchFailure(stderr, a.stderr) : undefined;
    if (err) problems.push(`its standard error ${err}`);
    const shown = `output ${excerpt(r.output)}${stderr !== '' ? `, standard error ${excerpt(stderr)}` : ''}`;
    if (problems.length === 0) return { pass: true, expected, observed: `exited with ${r.status}, ${shown}` };
    return { pass: false, expected, observed: `${problems.join('; ')}; ${shown}` };
  },
};

interface FileArgs {
  on: string;
  path: string;
  exists?: boolean;
  type?: 'file' | 'dir' | 'symlink';
  contains?: string;
  matches?: string;
  mode?: string;
  owner?: string;
  group?: string;
}

export const hostFileCheck: CheckSpec = {
  name: 'host.file',
  args: {
    type: 'object',
    properties: {
      on: { type: 'string', minLength: 1, description: 'The machine.' },
      path: { type: 'string', minLength: 1, description: 'Absolute path.' },
      exists: { type: 'boolean', description: 'Whether the file must exist; default true. With false, no other property is allowed.' },
      type: { enum: ['file', 'dir', 'symlink'], description: 'The file type; `symlink` looks at the link itself, the others follow links.' },
      contains: { type: 'string', minLength: 1, description: 'The content contains this text.' },
      matches: { type: 'string', minLength: 1, description: 'The content matches this regular expression (multi-line).' },
      mode: { type: 'string', pattern: '^[0-7]{3,4}$', description: 'Permission bits in octal.' },
      owner: { type: 'string', minLength: 1, description: 'Owner user name.' },
      group: { type: 'string', minLength: 1, description: 'Group name.' },
    },
    required: ['on', 'path'],
    additionalProperties: false,
  },
  run(ctx: CheckCtx, raw: Json): CheckResult {
    const a = raw as unknown as FileArgs;
    const exists = a.exists ?? true;
    const wants: string[] = [];
    if (a.type) wants.push(a.type === 'dir' ? 'a directory' : a.type === 'symlink' ? 'a symbolic link' : 'a regular file');
    if (a.contains !== undefined) wants.push(`containing ${JSON.stringify(a.contains)}`);
    if (a.matches !== undefined) wants.push(`matching /${a.matches}/`);
    if (a.mode !== undefined) wants.push(`mode ${a.mode}`);
    if (a.owner !== undefined) wants.push(`owned by ${a.owner}`);
    if (a.group !== undefined) wants.push(`group ${a.group}`);
    const expected = exists ? `${a.path} on ${a.on} exists${wants.length > 0 ? `, ${wants.join(', ')}` : ''}` : `${a.path} on ${a.on} does not exist`;
    const host = ctx.kernel.world.slices['host'] as { machines: Record<string, unknown> };
    if (!(a.on in host.machines)) return { pass: false, expected, observed: '', error: `there is no machine ${a.on}` };
    if (!exists && wants.length > 0) return { pass: false, expected, observed: '', error: 'exists: false takes no other property' };
    return ctx.kernel.act('check.file', (c): CheckResult => {
      const fs = createFs(c, a.on, { cred: ROOT_CRED, umask: 0 });
      let st: Stat;
      try {
        st = a.type === 'symlink' ? fs.lstat(a.path) : fs.stat(a.path);
      } catch (e) {
        if (e instanceof FsError) return { pass: !exists, expected, observed: e.code === 'ENOENT' ? `${a.path} does not exist` : `${a.path}: ${e.message}` };
        throw e;
      }
      if (!exists) return { pass: false, expected, observed: `${a.path} exists` };
      const problems: string[] = [];
      if (a.type && st.type !== a.type) problems.push(`it is a ${st.type === 'dir' ? 'directory' : st.type === 'symlink' ? 'symbolic link' : st.type === 'char' ? 'character device' : 'regular file'}`);
      if (a.mode !== undefined && (st.mode & 0o7777) !== parseInt(a.mode, 8)) problems.push(`its mode is ${(st.mode & 0o7777).toString(8).padStart(4, '0')}`);
      if (a.owner !== undefined) {
        const name = userByUid(c, a.on, st.uid)?.name ?? String(st.uid);
        if (name !== a.owner) problems.push(`its owner is ${name}`);
      }
      if (a.group !== undefined) {
        const name = groupByGid(c, a.on, st.gid)?.name ?? String(st.gid);
        if (name !== a.group) problems.push(`its group is ${name}`);
      }
      if (a.contains !== undefined || a.matches !== undefined) {
        if (st.type !== 'file') problems.push('it has no content to read');
        else {
          const content = fs.readFile(a.path);
          if (a.contains !== undefined && !content.includes(a.contains)) problems.push(`it does not contain ${JSON.stringify(a.contains)}`);
          if (a.matches !== undefined && !new RegExp(a.matches, 'm').test(content)) problems.push(`it does not match /${a.matches}/`);
        }
      }
      return problems.length === 0 ? { pass: true, expected, observed: `${a.path} exists as expected` } : { pass: false, expected, observed: problems.join('; ') };
    });
  },
};

export const HOST_CHECKS: readonly CheckSpec[] = [shellExecCheck, hostFileCheck];
