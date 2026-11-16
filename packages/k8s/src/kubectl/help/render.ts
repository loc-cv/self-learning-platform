// kubectl's help and usage text, rendered from the manifest with kubectl's templates.
//
// upstream: staging/src/k8s.io/kubectl/pkg/util/templates/templates.go (MainHelpTemplate,
// MainUsageTemplate and its sections, OptionsUsageTemplate), templater.go (HelpFunc, UsageFunc,
// the template functions), help_flags_printer.go (PrintHelpFlag), and
// vendor/github.com/spf13/cobra/command.go (UsageString, NamePadding, NameAndAliases).
//
// Go's text/template writes each text node and each action's output with its own Write, and on
// a terminal every Write is wrapped on its own (term_writer.go wordWrapWriter). So the
// templates are rendered here as the list of those writes ("chunks"), not as one string: help
// writes its description and then the whole usage string (cobra UsageString renders it into a
// buffer, unwrapped), while a usage printed directly (`kubectl options`, `kubectl help nosuch`)
// goes to the terminal chunk by chunk. Flag usages are wrapped separately, at the limit of
// standard output minus 10, wherever the text goes (templater.go flagsUsages calls
// term.GetWordWrapperLimit on os.Stdout).

import type { Manifest, ManifestCommand, ManifestFlag } from '../manifest.ts';
import { isSpace, terminalLimit, wrapString, writeWrapped } from './wordwrap.ts';

/** Where text goes: the width of the terminal it is written to, and of standard output's. */
export interface HelpTarget {
  /** Columns of the stream the text is written to when it is a terminal; undefined when not. */
  out: number | undefined;
  /** Columns of standard output when it is a terminal (flag usages wrap by it); undefined when not. */
  stdout: number | undefined;
  /** The default of --cache-dir: $KUBECACHEDIR, else $HOME/.kube/cache (cli-runtime config_flags.go getDefaultCacheDir). */
  cacheDir?: string;
}

const ROOT = 'kubectl';
// upstream: cobra/command.go minNamePadding
const MIN_NAME_PADDING = 11;
// upstream: help_flags_printer.go offset
const FLAG_USAGE_OFFSET = 10;

/** strings.TrimRightFunc(s, unicode.IsSpace) */
function trimRight(s: string): string {
  const cps = Array.from(s);
  let end = cps.length;
  while (end > 0 && isSpace((cps[end - 1] as string).codePointAt(0) as number)) end--;
  return cps.slice(0, end).join('');
}

function byPath(m: Manifest): Map<string, ManifestCommand> {
  return new Map(m.commands.map((c) => [c.path, c]));
}

function commandName(c: ManifestCommand): string {
  return c.path === '' ? ROOT : (c.path.split(' ').pop() as string);
}

/** A flag as help prints it. upstream: templater.go getFlagFormat, help_flags_printer.go PrintHelpFlag */
function printHelpFlag(f: ManifestFlag, flagLimit: number, cacheDir: string | undefined): string {
  const def = f.name === 'cache-dir' && cacheDir !== undefined ? cacheDir : f.default;
  const line = `${f.shorthand ? `    -${f.shorthand}, ` : '    '}--${f.name}=${f.type === 'string' ? `'${def}'` : def}:`;
  const usage = f.usage + (f.deprecated !== undefined ? ` (DEPRECATED: ${f.deprecated})` : '');
  // wrapLimit-offset is a uint: 0 (not a terminal) - 10 wraps around to no limit at all.
  const wrapped = wrapString(usage, flagLimit === 0 ? Infinity : flagLimit - FLAG_USAGE_OFFSET);
  return `${line}\n${wrapped}`.split('\n').join('\n\t') + '\n\n';
}

/** upstream: templater.go flagsUsages */
function flagsUsages(flags: readonly ManifestFlag[], t: HelpTarget): string {
  const limit = terminalLimit(t.stdout);
  return flags.map((f) => printHelpFlag(f, limit, t.cacheDir)).join('');
}

/** upstream: templater.go cmdGroupsString, cmdGroups; cobra NamePadding */
function cmdGroupsString(c: ManifestCommand, index: Map<string, ManifestCommand>): string {
  const child = (name: string) => index.get(c.path === '' ? name : `${c.path} ${name}`);
  const groups = c.help.groups ?? [{ title: 'Available Commands:', commands: c.subcommands }];
  const pad = Math.max(MIN_NAME_PADDING, ...c.subcommands.map((n) => n.length));
  return groups
    .map((g) => [g.title, ...g.commands.map((n) => `  ${n.padEnd(pad)}   ${child(n)?.short ?? ''}`)].join('\n'))
    .join('\n\n');
}

/** The writes of MainUsageTemplate for `c`. upstream: templates.go MainUsageTemplate */
function usageChunks(c: ManifestCommand, t: HelpTarget, index: Map<string, ManifestCommand>): string[] {
  const out = ['\n\n'];
  const runnable = c.help.runnable !== false;
  // SectionAliases
  if (c.aliases.length > 0) out.push('Aliases:\n', [commandName(c), ...c.aliases].join(', '), '\n\n');
  // SectionExamples
  if (c.help.examples !== undefined) out.push('Examples:\n', c.help.examples, '\n\n');
  // SectionSubcommands
  if (c.subcommands.length > 0) out.push(cmdGroupsString(c, index), '\n\n');
  // SectionFlags (no kubectl command exposes extra flags with ExposeFlags)
  if (c.flags.length > 0) out.push('Options:\n', trimRight(flagsUsages(c.flags, t)), '\n\n');
  // SectionUsage
  if (runnable && c.usage.length > 0) out.push('Usage:\n  ', c.usage.join(' '), '\n\n');
  // SectionTipsHelp: range over reverseParentsNames writes each name, then " "
  if (c.subcommands.length > 0) {
    out.push('Use "');
    for (const n of [ROOT, ...(c.path === '' ? [] : c.path.split(' '))]) out.push(n, ' ');
    out.push('<command> --help" for more information about a given command.\n');
  }
  // SectionTipsGlobalOptions: optionsCmdFor finds `options` on kubectl itself
  if (runnable) out.push('Use "', `${ROOT} options`, '" for a list of global command-line options (applies to all commands).\n');
  return out;
}

function lookup(m: Manifest, path: string, index: Map<string, ManifestCommand>): ManifestCommand {
  const c = index.get(path);
  if (!c) throw new Error(`kubectl help: no command "${path}" in the manifest of ${m.kubernetes}`);
  return c;
}

/** `kubectl options`' usage, as its writes. upstream: templates.go OptionsUsageTemplate */
function optionsChunks(m: Manifest, t: HelpTarget): string[] {
  if (m.globalFlags.length === 0) return [];
  return ['The following options can be passed to any command:\n\n', flagsUsages(m.globalFlags, t)];
}

/**
 * What cobra's Help() writes for the command at `path` ("" is kubectl itself): the description,
 * then the usage string. upstream: templater.go HelpFunc with MainHelpTemplate; `options` has
 * OptionsHelpTemplate, which is empty (UseOptionsTemplates).
 */
export function renderHelp(m: Manifest, path: string, t: HelpTarget): string {
  const index = byPath(m);
  const c = lookup(m, path, index);
  if (path === 'options') return '';
  const limit = terminalLimit(t.out);
  // {{with or .Long .Short}}{{. | trim}}{{end}}: the manifest keeps the trimmed text
  let text = c.help.long === '' ? '' : writeWrapped(c.help.long, limit);
  if (c.help.runnable !== false || c.subcommands.length > 0) text += writeWrapped(usageChunks(c, t, index).join(''), limit);
  return text;
}

/**
 * What cobra's Usage() writes for the command at `path`, straight to a stream (each template write
 * wrapped on its own). upstream: templater.go UsageFunc
 */
export function renderUsage(m: Manifest, path: string, t: HelpTarget): string {
  const index = byPath(m);
  const c = lookup(m, path, index);
  const limit = terminalLimit(t.out);
  const chunks = path === 'options' ? optionsChunks(m, t) : usageChunks(c, t, index);
  return chunks.map((s) => writeWrapped(s, limit)).join('');
}
