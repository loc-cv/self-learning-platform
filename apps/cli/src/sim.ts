// npm run sim -- --topology <name> [--seed N] (-c "<commands>" | <script file> | -) [options]
// Runs commands in a simulated machine without a human and prints what the terminal shows.
// The script format is in script.ts. Exit status: 0, or 1 when the run recorded a gap or a
// command did not finish, or 2 for a usage error.

import { readFileSync } from 'node:fs';
import { parseArgs, parseDuration, parseSeed } from './args.ts';
import { DEFAULT_TIMEOUT, runScript, type ScriptOptions } from './script.ts';
import { topologyNames, UsageError } from './world.ts';

const USAGE = `usage: npm run sim -- --topology NAME [--seed N] (-c COMMANDS | FILE | -)
  -c, --command TEXT   commands, one per line (a literal \\n in TEXT also separates them)
  FILE, -              read the script from a file or standard input
  --seed N             PRNG seed (default 1)
  --step DURATION      virtual time to let pass after each command (default 0)
  --timeout DURATION   how long one command may run (default 1h)
  --cols N, --rows N   terminal size (default 80x24)
  --raw                print the bytes the terminal received instead of the screen
  --transcript         run a plain session and print transcript format (docs/TRANSCRIPTS.md)
  --machine M, --user U  where the terminal opens (default: the topology's entry)
  --hash               print the world hash at the end
  --objects FILE       create the manifest's objects through the API server first, then let 30s
                       pass (a stand-in until kubectl create; repeatable)
Directives in scripts: @advance 30s, @keys \\x03, @resize 100x30, @editor <<EOF ... EOF
Topologies: ${topologyNames().join(', ')}
`;

function main(argv: string[]): number {
  const a = parseArgs(argv, ['topology', 'seed', 'command', 'step', 'timeout', 'cols', 'rows', 'machine', 'user', 'objects'], ['raw', 'transcript', 'hash', 'help']);
  if (a.flags.has('help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const topology = a.values.get('topology');
  if (topology === undefined) throw new UsageError('--topology is required');
  let text: string;
  const command = a.values.get('command');
  if (command !== undefined) text = command.replace(/\\n/g, '\n');
  else if (a.positionals[0] === '-') text = readFileSync(0, 'utf8');
  else if (a.positionals[0] !== undefined) text = readFileSync(a.positionals[0], 'utf8');
  else throw new UsageError('give -c COMMANDS, a script file, or - for standard input');
  const opts: ScriptOptions = {
    topology,
    seed: parseSeed(a.values.get('seed')),
    cols: Number(a.values.get('cols') ?? 80),
    rows: Number(a.values.get('rows') ?? 24),
    step: parseDuration(a.values.get('step') ?? '0'),
    timeout: a.values.has('timeout') ? parseDuration(a.values.get('timeout') as string) : DEFAULT_TIMEOUT,
    mode: a.flags.has('raw') ? 'raw' : a.flags.has('transcript') ? 'transcript' : 'screen',
  };
  const machine = a.values.get('machine');
  const user = a.values.get('user');
  if (machine !== undefined) opts.machine = machine;
  if (user !== undefined) opts.user = user;
  const objects = a.values.get('objects');
  if (objects !== undefined) opts.objects = [{ text: readFileSync(objects, 'utf8'), where: objects }];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const r = runScript(lines, opts);
  process.stdout.write(r.output);
  for (const n of r.notes) process.stderr.write(`# ${n}\n`);
  for (const g of r.gaps) process.stderr.write(`# gap: ${g.kind} ${g.program}: ${g.what}\n`);
  if (a.flags.has('hash')) process.stderr.write(`# world hash ${r.hash}\n`);
  return r.notes.length > 0 || r.gaps.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`sim: ${e.message}\n${USAGE}`);
    process.exitCode = 2;
  } else throw e;
}
