// Help as the dispatcher prints it: `--help`/`-h`, `kubectl help …`, `kubectl options`, and the
// commands whose Run only prints help (kubectl/help/). Widths are those of the streams that are
// terminals; the cache directory default is kubectl's getDefaultCacheDir
// (upstream: staging/src/k8s.io/cli-runtime/pkg/genericclioptions/config_flags.go).

import type { Op, ProcApi } from '@simlab/host';
import { helpCommand, helpFlag, helpRun, optionsCommand, type HelpResult, type Terminal } from '../help/index.ts';

function terminal(p: ProcApi): Terminal {
  const cols = p.winsize()?.cols;
  const home = p.env.HOME ?? '';
  return {
    ...(p.isatty(1) && cols !== undefined ? { stdout: cols } : {}),
    ...(p.isatty(2) && cols !== undefined ? { stderr: cols } : {}),
    cacheDir: p.env.KUBECACHEDIR || `${home}/.kube/cache`,
  };
}

function* print(p: ProcApi, r: HelpResult): Op<number> {
  if (r.stdout !== '') yield* p.write(1, r.stdout);
  if (r.stderr !== '') yield* p.write(2, r.stderr);
  return r.exit;
}

/** `kubectl <path> --help`. */
export function* helpOutput(p: ProcApi, path: string): Op<number> {
  return yield* print(p, helpFlag(path, terminal(p)));
}

/**
 * The commands that are help itself: `help`, `options`, and those whose Run prints help. Undefined
 * for any other command.
 */
export function* helpCommands(p: ProcApi, path: string, args: readonly string[]): Op<number | undefined> {
  if (path === 'help') return yield* print(p, helpCommand(args, terminal(p)));
  if (path === 'options') return yield* print(p, optionsCommand(terminal(p)));
  const r = helpRun(path, args, terminal(p));
  if (!r) return undefined;
  return yield* print(p, r);
}
