// The host's scenario steps (docs/SCENARIO_FORMAT.md §6): `run` types a command line into a
// shell, `write` creates or replaces a file directly. Both act on the entry machine unless `on`
// names another.

import type { ArgsSchema, Json, StepCtx, StepSpec } from '@simlab/kernel';
import { credFor, groupEntries, userByName } from '../users.ts';
import { createFs } from '../vfs/fs.ts';
import { FsError } from '../vfs/errno.ts';
import { ROOT_CRED } from '../vfs/types.ts';
import { runLine, stepShell, stepTarget, tail, type EditorOp } from './shell.ts';

const text = (description: string): ArgsSchema => ({ type: 'string', minLength: 1, description });

export const ON_SCHEMA = text('Machine to act on; default: the entry machine.');
export const AS_SCHEMA = text('User to act as; default: the entry user on the entry machine, root elsewhere.');

const EDITOR_SCHEMA: ArgsSchema = {
  type: 'array',
  minItems: 1,
  description: 'Answers the editor the command opens: operations applied to the content it opened with; the result is saved.',
  items: {
    oneOf: [
      {
        type: 'object',
        properties: {
          replace: {
            type: 'object',
            description: 'Replace the first occurrence of `from` with `to`; fails when `from` is absent.',
            properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string' } },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
        required: ['replace'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { write: { type: 'string', description: 'The whole new content of the buffer.' } },
        required: ['write'],
        additionalProperties: false,
      },
    ],
  },
};

interface RunArgs {
  run: string;
  on?: string;
  as?: string;
  expect?: { exit: number };
  editor?: EditorOp[];
}

/** `run: <command line>`: typed into the list's shell for that machine and user; waits for it. */
export const runStep: StepSpec = {
  name: 'run',
  args: {
    type: 'object',
    properties: {
      run: text('The command line, typed into a shell as a person would.'),
      on: ON_SCHEMA,
      as: AS_SCHEMA,
      expect: {
        type: 'object',
        description: 'The exit status the command must end with; default 0.',
        properties: { exit: { type: 'integer', minimum: 0, maximum: 255 } },
        required: ['exit'],
        additionalProperties: false,
      },
      editor: EDITOR_SCHEMA,
    },
    required: ['run'],
    additionalProperties: false,
  },
  run(ctx: StepCtx, raw: Json) {
    const a = raw as unknown as RunArgs;
    const { machine, user } = stepTarget(ctx.session, a.on, a.as);
    const login = stepShell(ctx.kernel, ctx.session, machine, user);
    const r = runLine(login, a.run, a.editor);
    const want = a.expect?.exit ?? 0;
    if (r.status !== want) {
      throw new Error(`exit status ${r.status}, expected ${want}${r.output === '' ? '' : `; output:\n${tail(r.output)}`}`);
    }
  },
  show(raw: Json) {
    const a = raw as unknown as RunArgs;
    const lines = [...where(a.on, a.as), `$ ${a.run}`];
    for (const op of a.editor ?? []) {
      if ('write' in op) lines.push('# in the editor, make the file read:', ...op.write.replace(/\n$/, '').split('\n').map((l) => `#   ${l}`));
      else lines.push(`# in the editor, change ${JSON.stringify(op.replace.from)} to ${JSON.stringify(op.replace.to)}`);
    }
    if (a.editor) lines.push('# then save and quit');
    return lines.join('\n');
  },
};

/** `# on node01 as root` when a step names a machine or user. */
function where(on: string | undefined, as: string | undefined): string[] {
  if (on === undefined && as === undefined) return [];
  return [`# ${on !== undefined ? `on ${on}` : ''}${on !== undefined && as !== undefined ? ' ' : ''}${as !== undefined ? `as ${as}` : ''}`];
}

interface WriteArgs {
  write: { path: string; content: string; mode?: string; owner?: string; group?: string };
  on?: string;
  as?: string;
}

/** `write: { path, content, mode?, owner?, group? }`: the file is written directly, not through a shell. */
export const writeStep: StepSpec = {
  name: 'write',
  args: {
    type: 'object',
    properties: {
      write: {
        type: 'object',
        properties: {
          path: text('Absolute, or relative to the home directory of the user `as`.'),
          content: { type: 'string', description: 'The file content.' },
          mode: { type: 'string', pattern: '^[0-7]{3,4}$', description: 'Permission bits in octal; default as the user creates files (umask 022).' },
          owner: text('Owner; default the user `as`.'),
          group: text("Group; default the owner's primary group."),
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      on: ON_SCHEMA,
      as: AS_SCHEMA,
    },
    required: ['write'],
    additionalProperties: false,
  },
  run(ctx: StepCtx, raw: Json) {
    const a = raw as unknown as WriteArgs;
    const { machine, user } = stepTarget(ctx.session, a.on, a.as);
    ctx.kernel.act('step.write', (c) => {
      const entry = userByName(c, machine, user);
      if (!entry) throw new Error(`machine ${machine} has no user ${user}`);
      const path = a.write.path.startsWith('/') ? a.write.path : `${entry.home}/${a.write.path}`;
      const fs = createFs(c, machine, { cred: credFor(c, machine, user), umask: 0o022, cwd: entry.home });
      // Missing directories are created as the user would with mkdir -p.
      const parts = path.split('/').filter((p) => p !== '');
      let dir = '';
      for (const part of parts.slice(0, -1)) {
        dir = `${dir}/${part}`;
        try {
          fs.mkdir(dir);
        } catch (e) {
          if (!(e instanceof FsError) || e.code !== 'EEXIST') throw e;
        }
      }
      fs.writeFile(path, a.write.content);
      const admin = createFs(c, machine, { cred: ROOT_CRED, umask: 0 });
      if (a.write.mode !== undefined) admin.chmod(path, parseInt(a.write.mode, 8));
      if (a.write.owner !== undefined || a.write.group !== undefined) {
        const owner = a.write.owner !== undefined ? userByName(c, machine, a.write.owner) : undefined;
        if (a.write.owner !== undefined && !owner) throw new Error(`machine ${machine} has no user ${a.write.owner}`);
        const gid = a.write.group !== undefined ? groupId(c, machine, a.write.group) : owner ? owner.gid : -1;
        admin.chown(path, owner ? owner.uid : -1, gid);
      }
    });
  },
  show(raw: Json) {
    const a = raw as unknown as WriteArgs;
    const w = a.write;
    const body = w.content.endsWith('\n') ? w.content : `${w.content}\n`;
    const lines = [...where(a.on, a.as), `$ cat > ${w.path} <<'EOF'`, ...body.replace(/\n$/, '').split('\n'), 'EOF'];
    if (w.mode !== undefined) lines.push(`$ chmod ${w.mode} ${w.path}`);
    if (w.owner !== undefined || w.group !== undefined) lines.push(`$ chown ${w.owner ?? ''}${w.group !== undefined ? `:${w.group}` : ''} ${w.path}`);
    return lines.join('\n');
  },
};

function groupId(ctx: Parameters<typeof credFor>[0], machine: string, name: string): number {
  const g = groupEntries(ctx, machine).find((e) => e.name === name);
  if (!g) throw new Error(`machine ${machine} has no group ${name}`);
  return g.gid;
}

export const HOST_STEPS: readonly StepSpec[] = [runStep, writeStep];
