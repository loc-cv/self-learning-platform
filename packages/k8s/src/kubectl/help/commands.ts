// What kubectl prints for help, `kubectl help`, `kubectl options` and the command groups whose Run
// prints help: the text, the stream it goes to and the exit status, each as the real binary does
// (checked against v1.37.2 in fixtures/golden/v1.37.2/client/help*.yaml).

import { manifest as vendored, type Manifest } from '../manifest.ts';
import { findCommand } from './find.ts';
import { goQuote, goSharpQuoteSlice } from './goquote.ts';
import { renderHelp, renderUsage } from './render.ts';

/** The terminal widths of the streams that are terminals; a stream that is not one is undefined. */
export interface Terminal {
  stdout?: number;
  stderr?: number;
  /** The default --cache-dir shows: $KUBECACHEDIR, else $HOME/.kube/cache (cli-runtime config_flags.go getDefaultCacheDir). */
  cacheDir?: string;
}

export interface HelpResult {
  stdout: string;
  stderr: string;
  exit: number;
}

const toStdout = (t: Terminal) => ({ out: t.stdout, stdout: t.stdout, ...(t.cacheDir !== undefined ? { cacheDir: t.cacheDir } : {}) });
const toStderr = (t: Terminal) => ({ out: t.stderr, stdout: t.stdout, ...(t.cacheDir !== undefined ? { cacheDir: t.cacheDir } : {}) });

/**
 * `kubectl <path> --help` (or -h, or --help=true) on standard output; `cols` is the terminal's
 * width when standard output is one, undefined when it is a pipe or a file.
 */
export function helpText(path: string, cols: number | undefined, m: Manifest = vendored()): string {
  return renderHelp(m, path, { out: cols, stdout: cols });
}

/**
 * `kubectl <path> --help`: help on standard output, exit 0. Cobra checks the flags first, so an
 * unknown flag anywhere on the line is a flag error instead (the dispatcher's job), and positional
 * arguments are ignored. `kubectl options --help` prints nothing (OptionsHelpTemplate is empty).
 */
export function helpFlag(path: string, t: Terminal = {}, m: Manifest = vendored()): HelpResult {
  return { stdout: renderHelp(m, path, toStdout(t)), stderr: '', exit: 0 };
}

/**
 * `kubectl help [words…]`, the words being the positional arguments left after flags.
 * upstream: cobra/command.go InitDefaultHelpCmd: Find from kubectl itself; a word kubectl has no
 * command for prints "Unknown help topic" and kubectl's usage on standard error, still exit 0.
 * Words after a found command are ignored (`kubectl help get pods` is get's help).
 */
export function helpCommand(words: readonly string[], t: Terminal = {}, m: Manifest = vendored()): HelpResult {
  const found = findCommand(m, words);
  if ('error' in found) {
    // c.Printf of the help command, then c.Root().Usage(): both on standard error
    return { stdout: '', stderr: `Unknown help topic ${goSharpQuoteSlice(words)}\n${renderUsage(m, '', toStderr(t))}`, exit: 0 };
  }
  return { stdout: renderHelp(m, found.path, toStdout(t)), stderr: '', exit: 0 };
}

/**
 * `kubectl options [anything]`: the global flags on standard output, exit 0; arguments are
 * ignored. upstream: pkg/cmd/options/options.go NewCmdOptions (Run calls cmd.Usage() with out and
 * err set to standard output). A flag other than the global ones is the dispatcher's flag error,
 * which for `options` ends "Run 'kubectl options' without flags." (templater.go FlagErrorFunc).
 */
export function optionsCommand(t: Terminal = {}, m: Manifest = vendored()): HelpResult {
  return { stdout: renderUsage(m, 'options', toStdout(t)), stderr: '', exit: 0 };
}

/** How a command whose Run only prints help behaves. */
type HelpRun = 'help' | 'help-to-stdout' | 'help-to-stderr';

/**
 * Commands whose Run prints their help. upstream: pkg/cmd/cmd.go runHelp (kubectl itself);
 * pkg/cmd/certificates/certificates.go (cmd.Help()); cmdutil.DefaultSubCommandRun(streams.Out)
 * in rollout/rollout.go and DefaultSubCommandRun(streams.ErrOut) in auth/auth.go,
 * config/config.go, create/create_secret.go, create/create_service.go, kuberc/kuberc.go,
 * plugin/plugin.go, set/set.go, top/top.go. Other commands with subcommands (apply, create,
 * cluster-info) are verbs of their own.
 */
export const HELP_RUN: Readonly<Record<string, HelpRun>> = {
  '': 'help',
  certificate: 'help',
  rollout: 'help-to-stdout',
  auth: 'help-to-stderr',
  config: 'help-to-stderr',
  'create secret': 'help-to-stderr',
  'create service': 'help-to-stderr',
  kuberc: 'help-to-stderr',
  plugin: 'help-to-stderr',
  set: 'help-to-stderr',
  top: 'help-to-stderr',
};

/**
 * `kubectl <path> [args…]` without --help, for a command in HELP_RUN; undefined for any other.
 * `args` are the positional arguments after flags. For kubectl itself the dispatcher has already
 * rejected an unknown first word (cobra legacyArgs), so only `kubectl` alone reaches here.
 * - kubectl, certificate: help on standard output, exit 0, arguments ignored.
 * - DefaultSubCommandRun(out): any argument is "error: unknown command …" on standard error,
 *   exit 1 (RequireNoArguments, UsageErrorf); none prints help on `out` and exits 1 (ErrExit).
 */
export function helpRun(path: string, args: readonly string[], t: Terminal = {}, m: Manifest = vendored()): HelpResult | undefined {
  const run = HELP_RUN[path];
  if (run === undefined) return undefined;
  if (run === 'help') return { stdout: renderHelp(m, path, toStdout(t)), stderr: '', exit: 0 };
  if (args.length > 0) {
    // upstream: cmd/util/helpers.go RequireNoArguments, UsageErrorf; CheckErr adds "error: "
    return { stdout: '', stderr: `error: unknown command ${goQuote(args.join(' '))}\nSee 'kubectl ${path} -h' for help and examples\n`, exit: 1 };
  }
  // DefaultSubCommandRun sets the command's out to the stream: the help is wrapped by that stream's
  // terminal, its flag usages by standard output's (templater.go flagsUsages)
  if (run === 'help-to-stdout') return { stdout: renderHelp(m, path, toStdout(t)), stderr: '', exit: 1 };
  return { stdout: '', stderr: renderHelp(m, path, toStderr(t)), exit: 1 };
}
