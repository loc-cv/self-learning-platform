// What the real kubectl of the pin has: every command, its aliases and flags, and the global
// flags, from the client-only oracle (fixtures/golden/v1.37.2/kubectl-commands.json, vendored by
// npm run golden:kubectl-manifest). The command framework uses it to tell a real command or flag
// the simulator lacks (a [sim] notice) from one kubectl itself would reject (its real error), and
// the help module prints every command's help from it (./help/render.ts).

import { MANIFEST } from './data/v1.37.2.ts';

export interface ManifestFlag {
  name: string;
  shorthand?: string;
  /** The default as help prints it, without the quotes of a string. */
  default: string;
  /** Inferred from help: 'string' is quoted, 'list' is [..], 'other' is a duration or a map. */
  type: 'bool' | 'string' | 'int' | 'list' | 'other';
  usage: string;
  deprecated?: string;
}

/**
 * The parts of a command's help that are not in its other fields; with those, they give the help
 * back byte for byte (packages/k8s/src/kubectl/help/render.ts, checked against the real binary by
 * npm run golden:kubectl-manifest).
 */
export interface ManifestHelp {
  /** The description help starts with: cobra's Long, or Short when Long is empty, trimmed. */
  long: string;
  /** The text under "Examples:", trimmed at the end; absent when the command has none. */
  examples?: string;
  /** kubectl itself only: the titled groups its command list is printed in, in order. */
  groups?: { title: string; commands: string[] }[];
  /** False when the command has no Run: help then has no Usage section and no `kubectl options` hint. */
  runnable?: false;
}

export interface ManifestCommand {
  /** Words after `kubectl`, e.g. "create deployment"; "" is kubectl itself. */
  path: string;
  aliases: string[];
  /** The one-line description in the parent's command list (for `help` and `options`, from `kubectl __complete`). */
  short: string;
  /** The line under "Usage:" in help, e.g. "kubectl get [(-o|--output)=...] [options]". */
  usage: string[];
  /** The names of the commands help lists, in its order (for kubectl itself, across help.groups). */
  subcommands: string[];
  /** The command's own flags (help's Options section), in help's order; the global flags are separate. */
  flags: ManifestFlag[];
  help: ManifestHelp;
  /**
   * True for `help` (cobra's help command) and `options`: real commands of kubectl that its
   * command list never shows, so they are not in kubectl's `subcommands`.
   */
  unlisted?: true;
}

export interface Manifest {
  kubernetes: string;
  /** The flags every command accepts, as `kubectl options` lists them. */
  globalFlags: ManifestFlag[];
  commands: ManifestCommand[];
}

let cached: { manifest: Manifest; byPath: Map<string, ManifestCommand> } | undefined;

function load(): { manifest: Manifest; byPath: Map<string, ManifestCommand> } {
  if (!cached) {
    const manifest = JSON.parse(MANIFEST) as Manifest;
    cached = { manifest, byPath: new Map(manifest.commands.map((c) => [c.path, c])) };
  }
  return cached;
}

export function manifest(): Manifest {
  return load().manifest;
}

/** The command at `path` ("create deployment"), or undefined. */
export function manifestCommand(path: string): ManifestCommand | undefined {
  return load().byPath.get(path);
}
