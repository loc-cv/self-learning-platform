// npm run golden:kubectl-manifest [-- --check | --vendor]
//
// The client-only oracle's inventory of kubectl: every command and subcommand of the pinned
// release with its aliases, usage line, flags (name, shorthand, default, type, usage) and the
// rest of its help (description, examples, kubectl's command groups), plus the global flags.
// Written to fixtures/golden/<version>/kubectl-commands.json and vendored for the engine. Phase
// 07a reads it to tell a command or flag that is real but not simulated (a [sim] notice) from one
// kubectl itself would reject, and prints help from it (packages/k8s/src/kubectl/help).
//
// Read from the real binary's help with standard output a pipe, so nothing is wrapped (upstream:
// staging/src/k8s.io/kubectl/pkg/util/templates/templater.go, help_flags_printer.go). Hidden and
// plugin commands do not appear in help and are not listed; `help` and `options`, which kubectl's
// command list leaves out, are added (their short descriptions from `kubectl __complete`).
//
// Each run (capture and --check) then proves the data is enough: the engine's help renderer must
// give back every command's piped help, `kubectl help <command>`, `kubectl options` and
// `kubectl help <unknown>` byte for byte, and the same on pseudo-terminals of 79, 80, 100 and 120
// columns (tools/src/golden/pty_run.py).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { helpCommand, KUBERNETES_TAG, optionsCommand, renderHelp, type Manifest, type ManifestHelp } from '@simlab/k8s';
import { binaryPath, fetchBinaries } from '../oracle/binaries.ts';
import { fixturesDir, repoRoot } from '../oracle/paths.ts';

export interface FlagInfo {
  name: string;
  shorthand?: string;
  /** The default as help prints it, without the quotes of a string. */
  default: string;
  /** Inferred from how help prints the default: 'string' is quoted, 'list' is [..], 'map' is [k=v] or {} . */
  type: 'bool' | 'string' | 'int' | 'list' | 'other';
  usage: string;
  deprecated?: string;
}

export interface CommandInfo {
  /** Words after `kubectl`, e.g. "create deployment". */
  path: string;
  aliases: string[];
  short: string;
  usage: string[];
  subcommands: string[];
  flags: FlagInfo[];
  /** The rest of help: packages/k8s/src/kubectl/manifest.ts ManifestHelp. */
  help: ManifestHelp;
  unlisted?: true;
}

const home = mkdtempSync(path.join(tmpdir(), 'simlab-kubectl-help-'));

const env = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
// Defaults under $HOME (--cache-dir) are written for the learner's home directory.
const unhome = (s: string) => s.split(home).join('/home/student');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(binaryPath('kubectl'), [...args], { env, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: unhome(r.stdout), stderr: unhome(r.stderr) };
}

function help(args: string[]): string {
  const r = run(args);
  if (r.status !== 0) throw new Error(`kubectl ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** kubectl on a pseudo-terminal of `cols` columns: what the terminal shows (both streams) and the exit status. */
function tty(args: string[], cols: number): { status: number; output: string } {
  const req = { argv: [binaryPath('kubectl'), ...args], cwd: home, env: { ...env, TERM: 'xterm-256color' }, cols, rows: 24 };
  const r = spawnSync('python3', ['-I', path.join(import.meta.dirname, 'pty_run.py')], { input: JSON.stringify(req), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`pty_run.py failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { status: number; output: string };
  return { status: out.status, output: unhome(out.output) };
}

/** Sections of help text: a line ending in ':' at column 0 starts one. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const line of text.split('\n')) {
    const h = /^([A-Z][^:]*):$/.exec(line);
    if (h) {
      cur = [];
      out.set(h[1] as string, cur);
    } else if (cur) cur.push(line);
  }
  return out;
}

function parseFlags(lines: readonly string[]): FlagInfo[] {
  const flags: FlagInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    // upstream: help_flags_printer.go getFlagFormat: "    -%s, --%s=%s:" or "    --%s=%s:"
    const m = /^ {4}(?:-(\S), )?--([^=\s]+)=(.*):$/.exec(lines[i] as string);
    if (!m) continue;
    const usage: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1] as string).startsWith('\t')) usage.push((lines[++i] as string).slice(1));
    let def = m[3] as string;
    let type: FlagInfo['type'];
    if (def === 'true' || def === 'false') type = 'bool';
    else if (/^'.*'$/.test(def)) {
      type = 'string';
      def = def.slice(1, -1);
    } else if (/^-?[0-9]+$/.test(def)) type = 'int';
    else if (/^\[.*\]$/.test(def)) type = 'list';
    else type = 'other';
    let text = usage.join(' ');
    let deprecated: string | undefined;
    const d = / \(DEPRECATED: (.*)\)$/.exec(text);
    if (d) {
      deprecated = d[1] as string;
      text = text.slice(0, d.index);
    }
    flags.push({ name: m[2] as string, ...(m[1] ? { shorthand: m[1] } : {}), default: def, type, usage: text, ...(deprecated ? { deprecated } : {}) });
  }
  return flags;
}

function commandList(secs: Map<string, string[]>, root: boolean): { title: string; commands: { name: string; short: string }[] }[] {
  const out: { title: string; commands: { name: string; short: string }[] }[] = [];
  for (const [title, lines] of secs) {
    // kubectl's own list ends with the plugins found on $PATH (none in the capture's environment:
    // the group is printed with its title only; upstream: pkg/cmd/plugin/plugin_completion.go
    // GetPluginCommandGroup)
    const isList = root ? / Commands( \(.*\))?$|^Other Commands$|^Subcommands provided by plugins$/.test(title) : title === 'Available Commands';
    if (!isList) continue;
    const commands: { name: string; short: string }[] = [];
    for (const l of lines) {
      const m = /^ {2}(\S+)\s{2,}(.*)$/.exec(l);
      if (m) commands.push({ name: m[1] as string, short: (m[2] as string).trim() });
    }
    out.push({ title: `${title}:`, commands });
  }
  return out;
}

/** Help as `kubectl <path> --help` printed it, by path. */
const helpTexts = new Map<string, string>();

function info(words: string[], short: string, text: string, unlisted = false): CommandInfo {
  const secs = sections(text);
  const groups = commandList(secs, words.length === 0);
  const aliases = (secs.get('Aliases') ?? []).join(' ').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const path = words.join(' ');
  helpTexts.set(path, text);
  return {
    path,
    aliases: aliases.filter((a) => a !== words[words.length - 1]),
    short,
    usage: (secs.get('Usage') ?? []).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('Use "')),
    subcommands: groups.flatMap((g) => g.commands.map((c) => c.name)),
    flags: parseFlags(secs.get('Options') ?? []),
    help: {
      long: '',
      ...(words.length === 0 ? { groups: groups.map((g) => ({ title: g.title, commands: g.commands.map((c) => c.name) })) } : {}),
      // upstream: templates.go SectionTipsGlobalOptions, shown for every runnable command
      ...(text.endsWith(`${OPTIONS_TIP}\n`) || path === 'options' ? {} : { runnable: false as const }),
    },
    ...(unlisted ? { unlisted: true as const } : {}),
  };
}

const OPTIONS_TIP = 'Use "kubectl options" for a list of global command-line options (applies to all commands).';

function walk(words: string[], short: string, acc: CommandInfo[]): void {
  const text = help([...words, '--help']);
  const c = info(words, short, text);
  acc.push(c);
  const subs = commandList(sections(text), words.length === 0).flatMap((g) => g.commands);
  for (const s of subs) walk([...words, s.name], s.short, acc);
}

/**
 * The description and examples of each command, cut out of its help: what is left once the
 * sections the renderer makes from the other fields (aliases, command list, options, usage,
 * hints) are known. Throws when help does not end with what the renderer makes.
 */
function fillHelp(m: Manifest): void {
  for (const c of m.commands) {
    if (c.path === 'options') continue;
    const text = helpTexts.get(c.path) as string;
    const names = c.aliases.length > 0 ? `Aliases:\n${[c.path === '' ? 'kubectl' : c.path.split(' ').pop(), ...c.aliases].join(', ')}\n\n` : '';
    const rendered = renderHelp(m, c.path, { out: undefined, stdout: undefined });
    const tail = rendered.slice(2 + names.length);
    if (!rendered.startsWith(`\n\n${names}`) || !text.endsWith(tail)) throw new Error(`kubectl ${c.path} --help: does not end with the sections made from the manifest:\n${tail}`);
    const head = text.slice(0, text.length - tail.length);
    const marker = `\n\n${names}Examples:\n`;
    const at = head.indexOf(marker);
    if (at >= 0 && head.endsWith('\n\n')) {
      c.help.long = head.slice(0, at);
      c.help.examples = head.slice(at + marker.length, -2);
    } else if (head.endsWith(`\n\n${names}`)) c.help.long = head.slice(0, head.length - 2 - names.length);
    else throw new Error(`kubectl ${c.path} --help: no description before ${JSON.stringify(head.slice(-40))}`);
    // keep the key order of ManifestHelp in the fixture
    const { long, examples, ...rest } = c.help;
    c.help = { long, ...(examples !== undefined ? { examples } : {}), ...rest };
  }
}

/** The short descriptions `kubectl __complete ""` gives, by command name. */
function completions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of run(['__complete', '']).stdout.split('\n')) {
    const t = l.indexOf('\t');
    if (t > 0) out.set(l.slice(0, t), l.slice(t + 1));
  }
  return out;
}

interface Mismatch {
  what: string;
  want: string;
  got: string;
}

function compare(acc: Mismatch[], what: string, want: string, got: string): void {
  if (want !== got) acc.push({ what, want, got });
}

/** Help rendered from the manifest against the real binary, piped and on terminals. */
function verify(m: Manifest): Mismatch[] {
  const bad: Mismatch[] = [];
  for (const c of m.commands) {
    const args = c.path === '' ? [] : c.path.split(' ');
    compare(bad, `kubectl ${c.path} --help`, run([...args, '--help']).stdout, renderHelp(m, c.path, { out: undefined, stdout: undefined }));
    const h = run(['help', ...args]);
    const sim = helpCommand(args, {}, m);
    compare(bad, `kubectl help ${c.path}`, JSON.stringify(h), JSON.stringify({ status: sim.exit, stdout: sim.stdout, stderr: sim.stderr }));
    for (const cols of TTY_WIDTHS) {
      const r = tty([...args, '--help'], cols);
      compare(bad, `kubectl ${c.path} --help (${cols} columns)`, `${r.status}\n${r.output}`, `0\n${renderHelp(m, c.path, { out: cols, stdout: cols })}`);
    }
  }
  const o = run(['options']);
  const so = optionsCommand({}, m);
  compare(bad, 'kubectl options', JSON.stringify(o), JSON.stringify({ status: so.exit, stdout: so.stdout, stderr: so.stderr }));
  const u = run(['help', 'nosuch']);
  const su = helpCommand(['nosuch'], {}, m);
  compare(bad, 'kubectl help nosuch', JSON.stringify(u), JSON.stringify({ status: su.exit, stdout: su.stdout, stderr: su.stderr }));
  for (const cols of TTY_WIDTHS) {
    const r = tty(['options'], cols);
    compare(bad, `kubectl options (${cols} columns)`, `${r.status}\n${r.output}`, `0\n${optionsCommand({ stdout: cols }, m).stdout}`);
    const n = tty(['help', 'nosuch'], cols);
    compare(bad, `kubectl help nosuch (${cols} columns)`, `${n.status}\n${n.output}`, `0\n${helpCommand(['nosuch'], { stdout: cols, stderr: cols }, m).stderr}`);
  }
  return bad;
}

const TTY_WIDTHS = [79, 80, 100, 120];

/**
 * The engine's copy of the manifest (packages/k8s/src/kubectl/data/<version>.ts): what the
 * simulated kubectl knows about real commands and flags. Written from the fixture, so `--vendor`
 * needs no binary.
 */
function vendorText(json: string): string {
  return `// Generated by npm run golden:kubectl-manifest from fixtures/golden/${KUBERNETES_TAG}/kubectl-commands.json. Do not edit.\n// Read by packages/k8s/src/kubectl/manifest.ts.\n\nexport const MANIFEST = ${JSON.stringify(JSON.stringify(JSON.parse(json)))};\n`;
}
const vendorTarget = path.join(repoRoot, 'packages/k8s/src/kubectl/data', `${KUBERNETES_TAG}.ts`);

const check = process.argv.includes('--check');
if (process.argv.includes('--vendor')) {
  writeFileSync(vendorTarget, vendorText(readFileSync(path.join(fixturesDir, 'kubectl-commands.json'), 'utf8')));
  console.log(`wrote ${path.relative(repoRoot, vendorTarget)}`);
  process.exit(0);
}
await fetchBinaries((s) => console.log(s));
try {
  const commands: CommandInfo[] = [];
  walk([], 'kubectl controls the Kubernetes cluster manager.', commands);
  // cobra's help command and kubectl's options are not in kubectl's command list
  const shorts = completions();
  commands.push(info(['help'], shorts.get('help') ?? '', help(['help', '--help']), true));
  commands.push(info(['options'], shorts.get('options') ?? '', help(['options', '--help']), true));
  const globalFlags = parseFlags(help(['options']).split('\n'));
  const manifest = {
    kubernetes: KUBERNETES_TAG,
    source: `help output of the kubectl ${KUBERNETES_TAG} release binary; generated by npm run golden:kubectl-manifest, do not edit`,
    globalFlags,
    commands: commands.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  fillHelp(manifest);
  const bad = verify(manifest);
  for (const b of bad.slice(0, 5)) console.error(`${b.what}: the rendered help differs from the real binary\n--- real\n${b.want}\n--- rendered\n${b.got}`);
  if (bad.length > 0) {
    console.error(`${bad.length} help outputs differ: ${bad.map((b) => b.what).join('; ')}`);
    process.exitCode = 1;
  } else console.log(`help of ${manifest.commands.length} commands, options and help topics equals the real binary's, piped and at ${TTY_WIDTHS.join(', ')} columns`);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const target = path.join(fixturesDir, 'kubectl-commands.json');
  const old = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (check) {
    if (old !== text) {
      console.error(`${path.relative(repoRoot, target)} differs from a new capture`);
      process.exitCode = 1;
    } else console.log(`${path.relative(repoRoot, target)} is current`);
    const vendored = existsSync(vendorTarget) ? readFileSync(vendorTarget, 'utf8') : undefined;
    if (vendored !== vendorText(text)) {
      console.error(`${path.relative(repoRoot, vendorTarget)} differs from the fixture; run with --vendor`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(target, text);
    writeFileSync(vendorTarget, vendorText(text));
    console.log(`wrote ${path.relative(repoRoot, target)}: ${commands.length} commands, ${globalFlags.length} global flags`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
