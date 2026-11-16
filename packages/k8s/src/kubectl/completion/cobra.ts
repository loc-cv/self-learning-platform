// cobra's `__complete`: the candidates for the last word of a command line, with descriptions,
// and the directive that tells the shell script what to do with them. kubectl's own completion
// functions (functions.ts) answer for arguments and flag values.
//   upstream: vendor/github.com/spf13/cobra/completions.go getCompletions, checkIfFlagCompletion,
//             getFlagNameCompletions, completeRequireFlags, helpOrVersionFlagPresent, findFlag,
//             ShellCompDirective (Error 1, NoSpace 2, NoFileComp 4, FilterFileExt 8,
//             FilterDirs 16, KeepOrder 32) and its string(); initCompleteCmd (the output: one
//             candidate per line, `:<directive>`, then `Completion ended with directive: …` on
//             standard error); CompErrorln (`[Debug] [Error] <msg>`), CompDebugln (`[Debug] <msg>`)
//   upstream: vendor/github.com/spf13/cobra/command.go InitDefaultHelpCmd (the help command's
//             ValidArgsFunction: the available commands of the command its arguments name)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/plugin/plugin_completion.go SetupPluginCompletion
//             (an unknown first command clears the global flags, "Cleared global flags for plugin
//             completion")
//   reference: fixtures/golden/v1.37.2/completion/*.yaml (the real binary's answers)

import { findCommand } from '../help/find.ts';
import { manifest } from '../manifest.ts';
import { lookup, parseFlags, type FlagValue, type ParsedFlags } from '../cli/flagset.ts';
import { commandAt, globalFlags, inheritedFlags, parseSet, rootCommand, type CompCommand, type CompFlag } from './model.ts';

export const DIRECTIVE = { error: 1, noSpace: 2, noFileComp: 4, filterFileExt: 8, filterDirs: 16, keepOrder: 32 } as const;

/** What a completion function returns: candidates (`name\tdescription` or `name`) and a directive. */
export interface Completions {
  comps: string[];
  directive: number;
}

/** What kubectl's completion functions get: the command, its parsed flags and positional arguments. */
export interface CompletionCall {
  cmd: CompCommand;
  /** Values of every flag the command parses. */
  values: Record<string, FlagValue>;
  /** Values of kubectl's own flags (what the factory's config flags read); shadowed ones absent. */
  rootValues: Record<string, FlagValue>;
  args: string[];
  toComplete: string;
}

export type CompletionFn = (call: CompletionCall) => Completions;

/** kubectl's registrations: ValidArgsFunction, ValidArgs and flag completion functions. */
export interface Registrations {
  validArgsFunction(path: string): CompletionFn | undefined;
  validArgs(path: string): string[] | undefined;
  flagFunction(path: string, flag: string): CompletionFn | undefined;
  /** The BashCompFilenameExt annotation of a flag: the extensions, or undefined. */
  filenameExt(path: string, flag: string): string[] | undefined;
}

export interface CompleteResult {
  comps: string[];
  directive: number;
  /** Lines cobra writes to standard error before the closing line. */
  debug: string[];
  /**
   * The command found writes its errors to standard output, so the closing line goes there
   * (staging/src/k8s.io/kubectl/pkg/cmd/options/options.go NewCmdOptions: cmd.SetErr(out)).
   */
  errToOut?: boolean;
}

/** Go's %v of a []string. */
const goList = (xs: readonly string[]): string => `[${xs.join(' ')}]`;

/** cobra isFlagArg */
function isFlagArg(arg: string): boolean {
  return (arg.length >= 3 && arg.startsWith('--')) || (arg.length >= 2 && arg[0] === '-' && arg[1] !== '-');
}

function noOptDefVal(f: CompFlag): string {
  return f.def.kind === 'bool' ? 'true' : (f.def.noOptDefVal ?? '');
}

/** cobra findFlag: a shorthand among the local then the inherited flags; a name among both. */
function findFlag(cmd: CompCommand, inherited: readonly CompFlag[], name: string): CompFlag | undefined {
  const all = [...cmd.local, ...inherited];
  if (name.length === 1) return all.find((f) => f.shorthand === name);
  const fs = parseSet(cmd, inherited);
  const d = lookup(fs, name);
  return d ? all.find((f) => f.name === d.name) : undefined;
}

/** cobra getFlagNameCompletions */
function flagNameCompletions(f: CompFlag, toComplete: string): string[] {
  if (f.deprecated) return [];
  const out: string[] = [];
  if (`--${f.name}`.startsWith(toComplete)) out.push(`--${f.name}\t${f.usage}`);
  if (f.shorthand && `-${f.shorthand}`.startsWith(toComplete)) out.push(`-${f.shorthand}\t${f.usage}`);
  return out;
}

interface FlagCheck {
  flag?: CompFlag;
  args: string[];
  toComplete: string;
  error?: string;
}

/** cobra checkIfFlagCompletion */
function checkIfFlagCompletion(cmd: CompCommand, inherited: readonly CompFlag[], args: string[], lastArg: string): FlagCheck {
  let flagName = '';
  let trimmed = args;
  let withEqual = false;
  const orig = lastArg;
  if (lastArg.startsWith('-')) {
    const i = lastArg.indexOf('=');
    if (i < 0) return { args, toComplete: lastArg };
    flagName = lastArg.slice(0, i).startsWith('--') ? lastArg.slice(2, i) : lastArg.slice(i - 1, i);
    lastArg = lastArg.slice(i + 1);
    withEqual = true;
  }
  if (flagName === '' && args.length > 0) {
    const prev = args[args.length - 1] as string;
    if (isFlagArg(prev) && !prev.includes('=')) {
      flagName = prev.startsWith('--') ? prev.slice(2) : prev.slice(-1);
      trimmed = args.slice(0, -1);
    }
  }
  if (flagName === '') return { args: trimmed, toComplete: lastArg };
  const flag = findFlag(cmd, inherited, flagName);
  if (!flag) return { args, toComplete: orig, error: `Subcommand '${cmd.name}' does not support flag '${flagName}'` };
  // A flag with a NoOptDefVal takes no value after a space: noun completion instead.
  if (!withEqual && noOptDefVal(flag) !== '') return { args, toComplete: lastArg };
  return { flag, args: trimmed, toComplete: lastArg };
}

function availableChildren(cmd: CompCommand): CompCommand[] {
  return cmd.children;
}

/** The help command's ValidArgsFunction. */
function helpCompletion(args: readonly string[], toComplete: string): Completions {
  const found = findCommand(manifest(), args);
  if ('error' in found) return { comps: [], directive: DIRECTIVE.noFileComp };
  const cmd = commandAt(found.path) ?? rootCommand();
  const comps = availableChildren(cmd)
    .filter((c) => c.name.startsWith(toComplete))
    .map((c) => `${c.name}\t${c.short}`);
  return { comps, directive: DIRECTIVE.noFileComp };
}

/** getCompletions for `kubectl __complete <args…>`. */
export function getCompletions(args: readonly string[], reg: Registrations): CompleteResult {
  const debug: string[] = [];
  const root = rootCommand();
  let inherited: readonly CompFlag[] = globalFlags();
  // SetupPluginCompletion, from kubectl's PersistentPreRunE.
  if (args.length > 1 && !(args[0] as string).startsWith('-') && !root.children.some((c) => c.name === args[0])) {
    inherited = [];
    debug.push('[Debug] Cleared global flags for plugin completion');
  }
  const toComplete0 = args[args.length - 1] ?? '';
  const trimmedArgs = args.slice(0, -1);
  const found = findCommand(manifest(), trimmedArgs);
  if ('error' in found) {
    debug.push(`[Debug] [Error] unable to find a command for arguments: ${goList(trimmedArgs)}`);
    return { comps: [], directive: 0, debug };
  }
  const cmd = commandAt(found.path) as CompCommand;
  if (cmd.path === 'options') return { ...completeFor(cmd, found.args, toComplete0, inherited, reg, debug), errToOut: true };
  return completeFor(cmd, found.args, toComplete0, inherited, reg, debug);
}

function completeFor(cmd: CompCommand, foundArgs: string[], toComplete0: string, globals: readonly CompFlag[], reg: Registrations, debug: string[]): CompleteResult {
  const inherited = inheritedFlags(cmd, globals);
  const fs = parseSet(cmd, inherited);
  const check = checkIfFlagCompletion(cmd, inherited, foundArgs, toComplete0);
  const toComplete = check.toComplete;
  let finalArgs = check.args;
  const withDash = parseFlags(fs, [...finalArgs, '--']);
  const parsed = parseFlags(fs, finalArgs);
  if ('error' in parsed) {
    debug.push(`[Debug] [Error] Error while parsing flags from args ${goList(finalArgs)}: ${parsed.error}`);
    return { comps: [], directive: 0, debug };
  }
  const p = parsed;
  let flagCompletion = true;
  if (!('error' in withDash) && withDash.args.length > p.args.length) flagCompletion = false;
  if (check.error !== undefined && flagCompletion) {
    debug.push(`[Debug] [Error] ${check.error}`);
    return { comps: [], directive: 0, debug };
  }
  if (p.changed.includes('help')) return { comps: [], directive: DIRECTIVE.noFileComp, debug };
  finalArgs = p.args;
  const flag = flagCompletion ? check.flag : undefined;
  if (flag) {
    const exts = reg.filenameExt(cmd.path, flag.name);
    if (exts && exts.length > 0) return { comps: [...exts], directive: DIRECTIVE.filterFileExt, debug };
  }
  let comps: string[] = [];
  let directive: number;
  if (!flag && toComplete.startsWith('-') && !toComplete.includes('=') && flagCompletion) {
    comps = requiredFlags(cmd, inherited, p, toComplete);
    if (comps.length === 0) {
      for (const f of [...inherited, ...cmd.local]) {
        if (!p.changed.includes(f.name) || f.multi) comps.push(...flagNameCompletions(f, toComplete));
      }
    }
    directive = DIRECTIVE.noFileComp;
    if (comps.length === 1 && (comps[0] as string).endsWith('=')) directive = DIRECTIVE.noSpace;
    return { comps, directive, debug };
  }
  directive = 0;
  if (!flag) {
    // Any local flag set stops subcommand completion (TraverseChildren is off in kubectl).
    const localSet = cmd.local.some((l) => p.changed.includes(l.name));
    if (finalArgs.length === 0 && !localSet) {
      for (const c of availableChildren(cmd)) {
        if (c.name.startsWith(toComplete)) comps.push(`${c.name}\t${c.short}`);
        directive = DIRECTIVE.noFileComp;
      }
    }
    comps.push(...requiredFlags(cmd, inherited, p, toComplete));
    const valid = reg.validArgs(cmd.path);
    if (valid) {
      if (finalArgs.length === 0) {
        comps.push(...valid.filter((v) => v.startsWith(toComplete)));
        directive = DIRECTIVE.noFileComp;
      }
      return { comps, directive, debug };
    }
  }
  const rootValues: Record<string, FlagValue> = {};
  for (const f of inherited) if (f.origin === '' && f.name in p.values) rootValues[f.name] = p.values[f.name] as FlagValue;
  const call = { cmd, values: p.values, rootValues, args: finalArgs, toComplete };
  let fn: CompletionFn | undefined;
  if (flag) fn = reg.flagFunction(cmd.path, flag.name);
  else if (cmd.path === 'help') fn = (c) => helpCompletion(c.args, c.toComplete);
  else fn = reg.validArgsFunction(cmd.path);
  if (fn) {
    const r = fn(call);
    comps.push(...r.comps);
    directive = r.directive;
  }
  return { comps, directive, debug };
}

/** cobra completeRequireFlags: flags marked required (MarkFlagRequired) and not set yet. */
function requiredFlags(cmd: CompCommand, inherited: readonly CompFlag[], p: ParsedFlags, toComplete: string): string[] {
  const out: string[] = [];
  for (const f of [...inherited, ...cmd.local]) {
    if (!REQUIRED.has(`${cmd.path} --${f.name}`) || p.changed.includes(f.name)) continue;
    out.push(...flagNameCompletions(f, toComplete));
  }
  return out;
}

/**
 * Flags kubectl marks required (cobra's BashCompOneRequiredFlag annotation).
 * upstream: grep MarkFlagRequired in staging/src/k8s.io/kubectl/pkg/cmd: autoscale.go (max),
 * create_clusterrolebinding.go (clusterrole), create_service.go (external-name),
 * create_cronjob.go (image, schedule), create_deployment.go (image), scale.go (replicas),
 * run.go (image), kuberc/set.go (section)
 */
const REQUIRED = new Set([
  'autoscale --max',
  'create clusterrolebinding --clusterrole',
  'create service externalname --external-name',
  'create cronjob --image',
  'create cronjob --schedule',
  'create deployment --image',
  'scale --replicas',
  'run --image',
  'kuberc set --section',
]);

/** The directive as cobra names it on standard error. */
export function directiveString(d: number): string {
  const names: string[] = [];
  if (d & DIRECTIVE.error) names.push('ShellCompDirectiveError');
  if (d & DIRECTIVE.noSpace) names.push('ShellCompDirectiveNoSpace');
  if (d & DIRECTIVE.noFileComp) names.push('ShellCompDirectiveNoFileComp');
  if (d & DIRECTIVE.filterFileExt) names.push('ShellCompDirectiveFilterFileExt');
  if (d & DIRECTIVE.filterDirs) names.push('ShellCompDirectiveFilterDirs');
  if (d & DIRECTIVE.keepOrder) names.push('ShellCompDirectiveKeepOrder');
  if (names.length === 0) names.push('ShellCompDirectiveDefault');
  if (d >= 64) return `ERROR: unexpected ShellCompDirective value: ${d}`;
  return names.join(', ');
}

/**
 * What `kubectl __complete` (or `__completeNoDesc`) prints: each candidate on a line (its first
 * line, trimmed; without the description for `__completeNoDesc` or when
 * KUBECTL_COMPLETION_DESCRIPTIONS is false), then `:<directive>`.
 * upstream: completions.go initCompleteCmd Run; getEnvConfig (`KUBECTL_` + suffix, the program
 * name upper-cased with `-` and `.` as `_`), configEnvVarSuffixDescriptions "COMPLETION_DESCRIPTIONS"
 */
export function completeOutput(r: CompleteResult, noDesc: boolean, env: Readonly<Record<string, string>>): { stdout: string; stderr: string } {
  let noDescriptions = noDesc;
  if (!noDescriptions) {
    const v = parseBoolEnv(env['KUBECTL_COMPLETION_DESCRIPTIONS']);
    if (v !== undefined) noDescriptions = !v;
  }
  let stdout = '';
  for (let comp of r.comps) {
    if (noDescriptions) comp = comp.split('\t')[0] as string;
    comp = (comp.split('\n')[0] as string).trim();
    stdout += `${comp}\n`;
  }
  stdout += `:${r.directive}\n`;
  const closing = `Completion ended with directive: ${directiveString(r.directive)}\n`;
  const stderr = r.debug.map((l) => `${l}\n`).join('') + (r.errToOut ? '' : closing);
  return { stdout: r.errToOut ? stdout + closing : stdout, stderr };
}

/** strconv.ParseBool */
function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(v)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(v)) return false;
  return undefined;
}
