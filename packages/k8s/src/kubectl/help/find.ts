// cobra's Find over the manifest's command tree: which command a list of words names, as
// `kubectl help <words>` resolves it.
// upstream: vendor/github.com/spf13/cobra/command.go Find, findNext, stripFlags, argsMinusFirstX;
// args.go legacyArgs. Prefix matching and case-insensitive names are off in kubectl (cobra's
// defaults); hidden commands (cobra's __complete) are not in the manifest and are not found.

import type { Manifest, ManifestCommand, ManifestFlag } from '../manifest.ts';
import { goQuote } from './goquote.ts';

function children(m: Manifest, path: string): ManifestCommand[] {
  const depth = path === '' ? 1 : path.split(' ').length + 1;
  return m.commands.filter((c) => c.path !== '' && c.path.split(' ').length === depth && (path === '' || c.path.startsWith(`${path} `)));
}

function name(c: ManifestCommand): string {
  return c.path.split(' ').pop() as string;
}

/** Whether a flag takes no value when given without `=` (pflag NoOptDefVal; bools have "true"). */
function noOptDefVal(flags: readonly ManifestFlag[], match: (f: ManifestFlag) => boolean): boolean {
  const f = flags.find(match);
  return f !== undefined && f.type === 'bool';
}

function takesValue(s: string, flags: readonly ManifestFlag[]): boolean {
  if (s.startsWith('--') && !s.includes('=') && !noOptDefVal(flags, (f) => f.name === s.slice(2))) return true;
  return s.startsWith('-') && !s.includes('=') && s.length === 2 && !noOptDefVal(flags, (f) => f.shorthand === s.slice(1));
}

/** upstream: cobra stripFlags (including its quirk: a value-taking flag with one word after it ends the scan) */
function stripFlags(args: readonly string[], flags: readonly ManifestFlag[]): string[] {
  const commands: string[] = [];
  let i = 0;
  while (i < args.length) {
    const s = args[i++] as string;
    if (s === '--') break;
    if (takesValue(s, flags)) {
      if (args.length - i <= 1) break;
      i++;
      continue;
    }
    if (s !== '' && !s.startsWith('-')) commands.push(s);
  }
  return commands;
}

/** upstream: cobra argsMinusFirstX */
function argsMinusFirstX(args: readonly string[], x: string, flags: readonly ManifestFlag[]): string[] {
  for (let pos = 0; pos < args.length; pos++) {
    const s = args[pos] as string;
    if (s === '--') break;
    if (takesValue(s, flags)) {
      pos++;
      continue;
    }
    if (!s.startsWith('-') && s === x) return [...args.slice(0, pos), ...args.slice(pos + 1)];
  }
  return [...args];
}

export type FindResult = { path: string; args: string[] } | { error: string };

/**
 * The command `args` name, starting at kubectl itself, and the words left over; or cobra's error
 * for an unknown first word (legacyArgs: only kubectl itself checks its arguments).
 */
export function findCommand(m: Manifest, args: readonly string[]): FindResult {
  const flagsOf = (c: ManifestCommand) => [...c.flags, ...m.globalFlags];
  const root = m.commands.find((c) => c.path === '') as ManifestCommand;
  let c = root;
  let rest = [...args];
  for (;;) {
    const words = stripFlags(rest, flagsOf(c));
    if (words.length === 0) break;
    const next = words[0] as string;
    const child = children(m, c.path).find((k) => name(k) === next || k.aliases.includes(next));
    if (!child) break;
    rest = argsMinusFirstX(rest, next, flagsOf(c));
    c = child;
  }
  if (c === root && root.subcommands.length > 0) {
    const words = stripFlags(rest, flagsOf(c));
    // upstream: args.go legacyArgs; the "Did you mean this?" suggestions are left to the caller
    if (words.length > 0) return { error: `unknown command ${goQuote(words[0] as string)} for "kubectl"` };
  }
  return { path: c.path, args: rest };
}
