// kubectl's help as the engine prints it, against the committed captures of the real binary
// (fixtures/golden/v1.37.2/client/help.yaml and help-more.yaml), byte for byte: piped, and on
// pseudo-terminals of 79, 80, 100 and 120 columns. Every command's piped and terminal help is
// also compared with the binary itself by npm run golden:kubectl-manifest (it needs the binary,
// so it is not part of the gate).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, test } from 'vitest';
import { helpCommand, helpFlag, helpRun, manifest, manifestCommand, optionsCommand, type HelpResult, type Terminal } from '@simlab/k8s';
import { fixturesDir } from '../oracle/paths.ts';

interface Captured {
  run: string;
  tty?: boolean;
  cols?: number;
  exit: number;
  output?: string;
  stdout?: string;
  stderr?: string;
}

/** The engine's answer for one command line, or undefined when it is not help (the dispatcher's). */
function simulate(line: string, t: Terminal): HelpResult | undefined {
  const words = line.split(' ').slice(1);
  if (words[0] === 'help') return helpCommand(words.slice(1), t);
  const flag = words.findIndex((w) => w === '--help' || w === '-h');
  // the command a line names: its longest prefix of words that is a command path
  let path = '';
  for (let i = 1; i <= (flag < 0 ? words.length : flag); i++) if (manifestCommand(words.slice(0, i).join(' '))) path = words.slice(0, i).join(' ');
  const rest = words.slice(path === '' ? 0 : path.split(' ').length);
  if (flag >= 0) return helpFlag(path, t);
  if (path === 'options') return optionsCommand(t);
  if (path === '' && rest.length > 0) return undefined;
  return helpRun(path, rest, t);
}

function steps(file: string): Captured[] {
  return (parseYaml(readFileSync(path.join(fixturesDir, 'client', file), 'utf8')) as { steps: Captured[] }).steps;
}

describe.each(['help.yaml', 'help-more.yaml'])('%s', (file) => {
  const cases = steps(file).map((s, i) => ({ ...s, name: `${i}: ${s.run}${s.tty ? ` (${s.cols ?? 80} columns)` : ''}` }));
  const covered = cases.filter((s) => simulate(s.run, {}) !== undefined);

  test.each(covered.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    const t: Terminal = s.tty ? { stdout: s.cols ?? 80, stderr: s.cols ?? 80 } : {};
    const r = simulate(s.run, t) as HelpResult;
    if (s.tty) {
      // one stream only in these steps, so the terminal's interleaving is just the two in turn
      expect(r.stdout === '' || r.stderr === '').toBe(true);
      expect({ exit: r.exit, output: r.stdout + r.stderr }).toEqual({ exit: s.exit, output: s.output });
    } else expect({ exit: r.exit, stdout: r.stdout, stderr: r.stderr }).toEqual({ exit: s.exit, stdout: s.stdout, stderr: s.stderr });
  });

  test('every help step of the capture is covered', () => {
    const uncovered = cases.filter((s) => !covered.includes(s)).map((s) => s.run);
    // kubectl's unknown command and flag errors and `create` with no file are the dispatcher's
    expect(uncovered).toEqual(file === 'help.yaml' ? ['kubectl nosuch', 'kubectl get pods --nosuchflag', 'kubectl create'] : []);
  });
});

describe('manifest', () => {
  test('help and options are real commands that kubectl lists nowhere', () => {
    const m = manifest();
    const root = m.commands.find((c) => c.path === '');
    expect(m.commands.filter((c) => c.unlisted).map((c) => c.path)).toEqual(['help', 'options']);
    expect(root?.subcommands).not.toContain('help');
    expect(root?.help.groups?.flatMap((g) => g.commands)).toEqual(root?.subcommands);
  });

  test('a terminal narrower than 80 columns gets the piped text', () => {
    for (const c of manifest().commands) expect(helpFlag(c.path, { stdout: 79, stderr: 79 }).stdout).toBe(helpFlag(c.path).stdout);
  });
});
