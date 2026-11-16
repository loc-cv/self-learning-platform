// kubectl's command tree and dispatch: cobra's Find over the real command tree (from the manifest),
// pflag parsing of the command's flags plus the global ones, the real errors for unknown commands
// and flags, and the `[sim]` notice for a command or flag that real kubectl has but the simulator
// does not (docs/FIDELITY.md §4.1). Each simulated command is a `Verb` module.
//   upstream: vendor/github.com/spf13/cobra/command.go Find, stripFlags, argsMinusFirstX, findNext,
//             findSuggestions, SuggestionsFor (Levenshtein distance 2 or a prefix), ld (levenshtein.go
//             in cobra.go); args.go legacyArgs
//   upstream: staging/src/k8s.io/kubectl/pkg/util/templates/templater.go FlagErrorFunc
//             (`<err>\nSee '<path> --help' for usage.`), SilenceUsage
//   upstream: staging/src/k8s.io/component-base/cli/run.go RunNoErrOutput (cobra prints nothing;
//             kubectl's CheckErr prints `error: …`)

import type { GapKind } from '@simlab/kernel';
import type { ProcApi, Syscall } from '@simlab/host';
import { manifest, type ManifestCommand, type ManifestFlag } from '../manifest.ts';
import { flagSet, parseFlags, type FlagDef, type FlagKind, type FlagSet, type ParsedFlags } from './flagset.ts';
import { completeCommand } from '../completion/run.ts';

export type Op<T> = Generator<Syscall, T, unknown>;

/** What a verb gets: the process, its parsed flags and the command path it was found under. */
export interface Invocation {
  p: ProcApi;
  /** Command path, e.g. "get". */
  path: string;
  flags: ParsedFlags;
  args: string[];
}

export interface Verb {
  /** Command path in the manifest. */
  path: string;
  /** The command's flags the simulator implements, with their real types and defaults. */
  flags: FlagDef[];
  /**
   * Flags of the real command that are parsed and have no observable effect in a simulated world,
   * each with the reason (docs/FIDELITY.md §4.1): accepted silently.
   */
  noEffect?: Record<string, string>;
  /**
   * Flags in `flags` that still print a notice for some or all of their values, with which: they
   * are defined so that kubectl's own validation of them runs first. The verb prints the notice;
   * this is the record docs/COVERAGE.md is generated from (npm run coverage:generate).
   */
  partial?: Record<string, string>;
  /**
   * The `-o` formats of the real command (its AllowedFormats) and those the simulator prints,
   * besides the default; the verb prints a notice for the others. For docs/COVERAGE.md.
   */
  outputFormats?: { allowed: readonly string[]; simulated: readonly string[] };
  run(inv: Invocation): Op<number>;
}

export interface Dispatch {
  verbs: readonly Verb[];
  /** Simulated global flags: name → whether it has an effect (false: on the no-effect list). */
  globals: Record<string, { reason?: string }>;
  /** Prints help for a command path (`kubectl <path> --help`); returns the exit status. */
  help(p: ProcApi, path: string): Op<number>;
  /** `help`, `options` and the commands whose Run prints help; undefined for others. */
  helpCommands(p: ProcApi, path: string, args: readonly string[]): Op<number | undefined>;
  /** Prints a notice and records the gap (ends the program). */
  unsupported(p: ProcApi, kind: GapKind, what: string): Op<number>;
  /** Writes an error as kubectl's CheckErr would and returns the exit status. */
  fail(p: ProcApi, text: string): Op<number>;
}

function kindOf(f: ManifestFlag): FlagKind {
  switch (f.type) {
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'list':
      // Help prints `[]` for both StringSlice and StringArray; a flag the simulator does not
      // define is read as a StringArray, which never rejects a value (a StringSlice splits CSV and
      // can fail), so a real value is never refused before its [sim] notice.
      return 'stringArray';
    case 'string':
      return 'string';
    default:
      return 'other';
  }
}

function defOf(f: ManifestFlag): FlagDef {
  const kind = kindOf(f);
  let def: FlagDef['default'] = f.default;
  if (kind === 'bool') def = f.default === 'true';
  else if (kind === 'int') def = Number(f.default);
  else if (kind === 'stringSlice' || kind === 'stringArray') def = [];
  return { name: f.name, ...(f.shorthand ? { shorthand: f.shorthand } : {}), kind, default: def };
}

/** cobra's help flag, added to every command. */
const HELP_FLAG: FlagDef = { name: 'help', shorthand: 'h', kind: 'bool', default: false };

interface Node {
  cmd: ManifestCommand;
  children: Map<string, Node>;
}

let tree: Node | undefined;

function buildTree(): Node {
  const byPath = new Map<string, Node>();
  for (const c of manifest().commands) byPath.set(c.path, { cmd: c, children: new Map() });
  for (const [path, node] of byPath) {
    if (path === '') continue;
    const i = path.lastIndexOf(' ');
    const parent = byPath.get(i < 0 ? '' : path.slice(0, i));
    parent?.children.set(i < 0 ? path : path.slice(i + 1), node);
  }
  return byPath.get('') as Node;
}

function root(): Node {
  return (tree ??= buildTree());
}

/** The flags of a command as the real binary defines them, with a verb's own definitions first. */
function flagsFor(node: Node, verb: Verb | undefined, withHelp = true): FlagSet {
  const defs: FlagDef[] = [];
  const seen = new Set<string>();
  const add = (d: FlagDef) => {
    if (seen.has(d.name)) return;
    seen.add(d.name);
    defs.push(d);
  };
  for (const d of verb?.flags ?? []) add(d);
  for (const f of node.cmd.flags) add(defOf(f));
  for (const f of manifest().globalFlags) add(defOf(f));
  if (withHelp) add(HELP_FLAG);
  return flagSet(defs);
}

function takesNoValue(fs: FlagSet, name: string): boolean {
  const d = fs.byName.get(name);
  return d !== undefined && d.kind === 'bool';
}

function shortTakesNoValue(fs: FlagSet, s: string): boolean {
  const d = s.length > 0 ? fs.byShort.get(s[0] as string) : undefined;
  return d !== undefined && d.kind === 'bool';
}

/** cobra stripFlags: the non-flag words of args. */
function stripFlags(args: readonly string[], fs: FlagSet): string[] {
  const commands: string[] = [];
  const a = [...args];
  while (a.length > 0) {
    const s = a.shift() as string;
    if (s === '--') break;
    if (s.startsWith('--') && !s.includes('=') && !takesNoValue(fs, s.slice(2))) {
      if (a.length <= 1) break;
      a.shift();
      continue;
    }
    if (s.startsWith('-') && !s.includes('=') && s.length === 2 && !shortTakesNoValue(fs, s.slice(1))) {
      if (a.length <= 1) break;
      a.shift();
      continue;
    }
    if (s !== '' && !s.startsWith('-')) commands.push(s);
  }
  return commands;
}

/** cobra argsMinusFirstX */
function argsMinusFirstX(args: readonly string[], x: string, fs: FlagSet): string[] {
  for (let pos = 0; pos < args.length; pos++) {
    const s = args[pos] as string;
    if (s === '--') break;
    if (s.startsWith('--') && !s.includes('=') && !takesNoValue(fs, s.slice(2))) {
      pos++;
      continue;
    }
    if (s.startsWith('-') && !s.includes('=') && s.length === 2 && !shortTakesNoValue(fs, s.slice(1))) {
      pos++;
      continue;
    }
    if (!s.startsWith('-') && s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
  }
  return [...args];
}

function findNext(node: Node, next: string): Node | undefined {
  for (const [name, child] of node.children) {
    if (name === next || child.cmd.aliases.includes(next)) return child;
  }
  return undefined;
}

/** cobra's ld: Levenshtein distance, case-insensitive when asked. */
function ld(s: string, t: string, ignoreCase: boolean): number {
  if (ignoreCase) {
    s = s.toLowerCase();
    t = t.toLowerCase();
  }
  const d: number[][] = [];
  for (let i = 0; i <= s.length; i++) d.push([i, ...new Array<number>(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) (d[0] as number[])[j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      if (s[i - 1] === t[j - 1]) row[j] = prev[j - 1] as number;
      else row[j] = Math.min(prev[j] as number, row[j - 1] as number, prev[j - 1] as number) + 1;
    }
  }
  return (d[s.length] as number[])[t.length] as number;
}

/** findSuggestions over the root's available commands, in help order. */
function suggestions(node: Node, typed: string): string {
  const out: string[] = [];
  for (const name of node.cmd.subcommands) {
    if (ld(typed, name, true) <= 2 || name.toLowerCase().startsWith(typed.toLowerCase())) out.push(name);
  }
  return out.length > 0 ? `\n\nDid you mean this?\n${out.map((s) => `\t${s}\n`).join('')}` : '';
}

export function* dispatch(p: ProcApi, d: Dispatch): Op<number> {
  const args = p.argv.slice(1);
  // cobra's hidden completion command (completions.go initCompleteCmd), as the completion script
  // calls it: first, with flag parsing off.
  if (args[0] === '__complete' || args[0] === '__completeNoDesc') return yield* completeCommand(p, args.slice(1), args[0] === '__completeNoDesc');
  const verbs = new Map(d.verbs.map((v) => [v.path, v]));
  // Find
  let node = root();
  let rest = [...args];
  for (;;) {
    // cobra defines the help flag only when the command executes, so during Find `--help` reads
    // as a flag that takes a value (`kubectl --help get` prints kubectl's help).
    const fs = flagsFor(node, verbs.get(node.cmd.path), false);
    const words = stripFlags(rest, fs);
    if (words.length === 0) break;
    const next = findNext(node, words[0] as string);
    if (!next) break;
    rest = argsMinusFirstX(rest, words[0] as string, fs);
    node = next;
  }
  const path = node.cmd.path;
  const verb = verbs.get(path);
  const fs = flagsFor(node, verb);
  // legacyArgs: the root with subcommands checks its first non-flag argument.
  if (path === '') {
    const words = stripFlags(rest, flagsFor(node, verb, false));
    if (words.length > 0) {
      return yield* d.fail(p, `error: unknown command "${words[0] as string}" for "kubectl"${suggestions(node, words[0] as string)}`);
    }
  }
  const parsed = parseFlags(fs, rest);
  const cmdPath = path === '' ? 'kubectl' : `kubectl ${path}`;
  if ('error' in parsed) {
    if (parsed.help) return yield* d.help(p, path);
    // upstream: templater.go FlagErrorFunc; `kubectl options` has its own (options.go).
    if (path === 'options') return yield* d.fail(p, `error: ${parsed.error}\nRun 'kubectl options' without flags.`);
    return yield* d.fail(p, `error: ${parsed.error}\nSee '${cmdPath} --help' for usage.`);
  }
  if (parsed.values.help === true) return yield* d.help(p, path);
  // Deprecated flags print their notice when set (pflag FlagSet.Set).
  for (const name of parsed.changed) {
    const mf = node.cmd.flags.find((f) => f.name === name) ?? manifest().globalFlags.find((f) => f.name === name);
    if (mf?.deprecated) yield* p.write(2, `Flag --${name} has been deprecated, ${mf.deprecated}\n`);
  }
  if (!verb) {
    const h = yield* d.helpCommands(p, path, parsed.args);
    if (h !== undefined) return h;
    return yield* d.unsupported(p, 'subcommand', `the command "${cmdPath}"`);
  }
  for (const name of parsed.changed) {
    if (name === 'help') continue;
    if (verb.flags.some((f) => f.name === name)) continue;
    if (verb.noEffect && name in verb.noEffect) continue;
    if (name in d.globals) continue;
    return yield* d.unsupported(p, 'flag', `the flag --${name}`);
  }
  return yield* verb.run({ p, path, flags: parsed, args: parsed.args });
}
