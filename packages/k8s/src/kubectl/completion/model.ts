// The command tree and flags as cobra's completion sees them, from the vendored manifest: each
// command's children, its local flags (with cobra's help flag added) and the inherited global
// flags, each with its pflag type, NoOptDefVal and whether it may be repeated.
//   upstream: vendor/github.com/spf13/cobra/command.go InitDefaultHelpFlag (`help for <name>`),
//             Commands (sorted by name: EnableCommandSorting), IsAvailableCommand
//   upstream: vendor/github.com/spf13/pflag/flag.go VisitAll (flags in lexicographical order)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go AddValidateFlags
//             (`validate` NoOptDefVal "strict"), AddDryRunFlag (`dry-run` NoOptDefVal "unchanged");
//             staging/src/k8s.io/kubectl/pkg/cmd/delete/delete_flags.go AddFlags (`cascade`
//             NoOptDefVal "background"). Help does not show NoOptDefVal, so the manifest lacks it.

import { manifest, type ManifestFlag } from '../manifest.ts';
import { flagSet, type FlagDef, type FlagKind, type FlagSet } from '../cli/flagset.ts';

export interface CompFlag {
  name: string;
  shorthand?: string;
  usage: string;
  def: FlagDef;
  /** Slice, Array or stringTo types: suggested again after being set. */
  multi: boolean;
  /** Deprecated flags are not suggested (cobra nonCompletableFlag). */
  deprecated: boolean;
  /** The command that defines it: '' for kubectl's own (the factory's config flags among them). */
  origin: string;
}

export interface CompCommand {
  path: string;
  name: string;
  short: string;
  aliases: string[];
  /** Sorted by name, as cobra keeps them. */
  children: CompCommand[];
  /** Local flags (help and the command's own persistent flags included), sorted by name. */
  local: CompFlag[];
  /** Persistent flags it defines, which its subcommands inherit. */
  persistent: CompFlag[];
}

/**
 * Persistent flags of subcommand groups, which help does not list and the manifest lacks.
 * upstream: staging/src/k8s.io/kubectl/pkg/cmd/config/config.go NewCmdConfig
 * (`cmd.PersistentFlags().StringVar(…, pathOptions.ExplicitFileFlag, …, "use a particular
 * kubeconfig file")`, ExplicitFileFlag is clientcmd.RecommendedConfigPathFlag "kubeconfig")
 */
const PERSISTENT: Record<string, ManifestFlag[]> = {
  config: [{ name: 'kubeconfig', default: '', type: 'string', usage: 'use a particular kubeconfig file' }],
};

/** NoOptDefVal of the value-taking flags kubectl gives one (bools have "true"). */
const NO_OPT_DEF_VAL: Record<string, string> = { 'dry-run': 'unchanged', validate: 'strict', cascade: 'background' };

const DURATION = /^-?(\d+(\.\d*)?(ns|us|µs|ms|s|m|h))+$/;

function kindOf(f: ManifestFlag): FlagKind {
  switch (f.type) {
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'list':
      return 'stringArray';
    case 'string':
      return 'string';
    default:
      // 'other' is a duration (help prints it unquoted, `0s`) or a map.
      return DURATION.test(f.default) ? 'duration' : 'other';
  }
}

const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function compFlag(f: ManifestFlag, origin: string): CompFlag {
  const kind = kindOf(f);
  let value: FlagDef['default'] = f.default;
  if (kind === 'bool') value = f.default === 'true';
  else if (kind === 'int') value = Number(f.default);
  else if (kind === 'stringArray') value = [];
  const noOpt = kind === 'bool' ? undefined : NO_OPT_DEF_VAL[f.name];
  const def: FlagDef = { name: f.name, kind, default: value, ...(f.shorthand ? { shorthand: f.shorthand } : {}), ...(noOpt ? { noOptDefVal: noOpt } : {}) };
  return { name: f.name, ...(f.shorthand ? { shorthand: f.shorthand } : {}), usage: f.usage, def, multi: f.type === 'list', deprecated: f.deprecated !== undefined, origin };
}

let cache: { root: CompCommand; byPath: Map<string, CompCommand>; globals: CompFlag[] } | undefined;

function build(): NonNullable<typeof cache> {
  const m = manifest();
  const byPath = new Map<string, CompCommand>();
  for (const c of m.commands) {
    const name = c.path === '' ? 'kubectl' : (c.path.split(' ').pop() as string);
    const help: CompFlag = {
      name: 'help',
      shorthand: 'h',
      usage: `help for ${name}`,
      def: { name: 'help', shorthand: 'h', kind: 'bool', default: false },
      multi: false,
      deprecated: false,
      origin: c.path,
    };
    const persistent = (PERSISTENT[c.path] ?? []).map((f) => compFlag(f, c.path));
    const local = [...c.flags.map((f) => compFlag(f, c.path)), help, ...persistent].sort(byName);
    byPath.set(c.path, { path: c.path, name, short: c.short, aliases: c.aliases, children: [], local, persistent });
  }
  for (const [path, node] of byPath) {
    if (path === '') continue;
    const i = path.lastIndexOf(' ');
    byPath.get(i < 0 ? '' : path.slice(0, i))?.children.push(node);
  }
  for (const node of byPath.values()) node.children.sort(byName);
  const globals = m.globalFlags.map((f) => compFlag(f, '')).sort(byName);
  return { root: byPath.get('') as CompCommand, byPath, globals };
}

function model(): NonNullable<typeof cache> {
  return (cache ??= build());
}

export function rootCommand(): CompCommand {
  return model().root;
}

export function commandAt(path: string): CompCommand | undefined {
  return model().byPath.get(path);
}

/** kubectl's persistent flags, which every command inherits. */
export function globalFlags(): CompFlag[] {
  return model().globals;
}

/**
 * cobra InheritedFlags: the persistent flags of the command's parents (the nearest wins), without
 * those its own flags shadow; sorted by name. `globals` replaces kubectl's own (cleared for plugins).
 */
export function inheritedFlags(cmd: CompCommand, globals: readonly CompFlag[] = globalFlags()): CompFlag[] {
  const byName = new Map<string, CompFlag>();
  for (const g of globals) byName.set(g.name, g);
  const words = cmd.path === '' ? [] : cmd.path.split(' ');
  for (let i = 1; i < words.length; i++) {
    for (const f of commandAt(words.slice(0, i).join(' '))?.persistent ?? []) byName.set(f.name, f);
  }
  return [...byName.values()].filter((f) => !cmd.local.some((l) => l.name === f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The pflag set a command parses: its local flags and the inherited ones (unless cleared). */
export function parseSet(cmd: CompCommand, inherited: readonly CompFlag[]): FlagSet {
  return flagSet([...cmd.local, ...inherited].map((f) => f.def));
}
