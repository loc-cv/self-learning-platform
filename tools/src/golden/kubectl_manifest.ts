// npm run golden:kubectl-manifest [-- --check]
//
// The client-only oracle's inventory of kubectl: every command and subcommand of the pinned
// release with its aliases, usage line and flags (name, shorthand, default, type, usage), plus
// the global flags. Written to fixtures/golden/<version>/kubectl-commands.json. Phase 07a reads it
// to tell a command or flag that is real but not simulated (a [sim] notice) from one kubectl
// itself would reject.
//
// Read from the real binary's help with standard output a pipe, so nothing is wrapped (upstream:
// staging/src/k8s.io/kubectl/pkg/util/templates/templater.go, help_flags_printer.go). Hidden and
// plugin commands do not appear in help and are not listed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KUBERNETES_TAG } from '@simlab/k8s';
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
}

const home = mkdtempSync(path.join(tmpdir(), 'simlab-kubectl-help-'));

function help(args: string[]): string {
  const r = spawnSync(binaryPath('kubectl'), [...args], { env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`kubectl ${args.join(' ')}: ${r.stderr}`);
  // Defaults under $HOME (--cache-dir) are written for the learner's home directory.
  return r.stdout.split(home).join('/home/student');
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

function commandList(secs: Map<string, string[]>, root: boolean): { name: string; short: string }[] {
  const out: { name: string; short: string }[] = [];
  for (const [title, lines] of secs) {
    const isList = root ? / Commands( \(.*\))?$|^Other Commands$/.test(title) && title !== 'Subcommands provided by plugins' : title === 'Available Commands';
    if (!isList) continue;
    for (const l of lines) {
      const m = /^ {2}(\S+)\s{2,}(.*)$/.exec(l);
      if (m) out.push({ name: m[1] as string, short: (m[2] as string).trim() });
    }
  }
  return out;
}

function walk(words: string[], short: string, acc: CommandInfo[]): void {
  const text = help([...words, '--help']);
  const secs = sections(text);
  const subs = commandList(secs, words.length === 0);
  const aliases = (secs.get('Aliases') ?? []).join(' ').split(',').map((s) => s.trim()).filter((s) => s !== '');
  acc.push({
    path: words.join(' '),
    aliases: aliases.filter((a) => a !== words[words.length - 1]),
    short,
    usage: (secs.get('Usage') ?? []).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('Use "')),
    subcommands: subs.map((s) => s.name),
    flags: parseFlags(secs.get('Options') ?? []),
  });
  for (const s of subs) walk([...words, s.name], s.short, acc);
}

const check = process.argv.includes('--check');
await fetchBinaries((s) => console.log(s));
try {
  const commands: CommandInfo[] = [];
  walk([], 'kubectl controls the Kubernetes cluster manager.', commands);
  const globalFlags = parseFlags(help(['options']).split('\n'));
  const manifest = {
    kubernetes: KUBERNETES_TAG,
    source: `help output of the kubectl ${KUBERNETES_TAG} release binary; generated by npm run golden:kubectl-manifest, do not edit`,
    globalFlags,
    commands: commands.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const target = path.join(fixturesDir, 'kubectl-commands.json');
  const old = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (check) {
    if (old !== text) {
      console.error(`${path.relative(repoRoot, target)} differs from a new capture`);
      process.exitCode = 1;
    } else console.log(`${path.relative(repoRoot, target)} is current`);
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${path.relative(repoRoot, target)}: ${commands.length} commands, ${globalFlags.length} global flags`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
