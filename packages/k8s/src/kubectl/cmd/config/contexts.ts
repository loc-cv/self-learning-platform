// kubectl config get-contexts, current-context, use-context, set-context and delete-context.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/config/get_contexts.go Complete (the output
//             check), RunGetContexts (names sorted, missing ones collected as errors after the
//             table), printContextHeaders, printContext
//   upstream: config/current_context.go RunCurrentContext
//   upstream: config/use_context.go complete (helpErrorf: help, then the error), run, validate;
//             the message is printed after ModifyConfig
//   upstream: config/set_context.go complete, run, modifyContext (a flag given, even empty, sets
//             its field), validate; "Context %q modified." or "created."
//   upstream: config/delete_context.go runDeleteContext (one argument or help with exit 0; the
//             file named is --kubeconfig or GetDefaultFilename; the warning before the write)
//   upstream: config/config.go helpErrorf
//   fixtures/golden/v1.37.2/config/contexts.yaml, client/config.yaml

import type { ProcApi } from '@simlab/host';
import type { Invocation, Op, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { fail } from '../../client/session.ts';
import { goQuote } from '../../help/goquote.ts';
import { GET_TABWRITER, render, type Cells } from '../../printers/tabwriter.ts';
import { goStrings } from '../helpers.ts';
import { helpOutput } from '../help.ts';
import { defaultFilename, pathOptions, startingConfig } from './access.ts';
import { cloneConfig, newContext, type Config } from '../../client/kubeconfigmodel.ts';
import { modifyConfig } from './modify.ts';

const TABWRITER = { ...GET_TABWRITER, rememberWidths: false };

function* starting(p: ProcApi, flags: Invocation['flags']): Op<Config | number> {
  const r = startingConfig(p, pathOptions(p, flags.values.kubeconfig as string));
  if ('type' in r) return yield* fail(p, r);
  return r;
}

/** helpErrorf: the command's help on standard output, then the error. */
function* helpError(p: ProcApi, path: string, message: string): Op<number> {
  yield* helpOutput(p, path);
  return yield* fail(p, messageError(message));
}

function* getContexts({ p, flags, args }: Invocation): Op<number> {
  const output = flags.values.output as string;
  if (output !== '' && output !== 'name') {
    return yield* fail(p, messageError(`--output ${output} is not available in kubectl config get-contexts; resetting to default output format`));
  }
  const nameOnly = output === 'name';
  const showHeaders = !(flags.values['no-headers'] === true || nameOnly);
  const config = yield* starting(p, flags);
  if (typeof config === 'number') return config;
  const errors: KubectlError[] = [];
  const toPrint: string[] = [];
  if (args.length === 0) toPrint.push(...Object.keys(config.contexts));
  else {
    for (const name of args) {
      if (name in config.contexts) toPrint.push(name);
      else errors.push(messageError(`context ${name} not found`));
    }
  }
  toPrint.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: Cells[] = [];
  if (showHeaders) lines.push(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE']);
  let names = '';
  for (const name of toPrint) {
    const ctx = config.contexts[name]?.value ?? newContext();
    if (nameOnly) names += `${name}\n`;
    else lines.push([config.currentContext === name ? '*' : ' ', name, ctx.cluster, ctx.authInfo, ctx.namespace]);
  }
  yield* p.write(1, nameOnly ? names : render(lines, TABWRITER));
  if (errors.length > 0) return yield* fail(p, { type: 'aggregate', errors });
  return 0;
}

function* currentContext({ p, flags }: Invocation): Op<number> {
  const config = yield* starting(p, flags);
  if (typeof config === 'number') return config;
  if (config.currentContext === '') return yield* fail(p, messageError('current-context is not set'));
  yield* p.write(1, `${config.currentContext}\n`);
  return 0;
}

function* useContext({ p, path, flags, args }: Invocation): Op<number> {
  if (args.length !== 1) return yield* helpError(p, path, `Unexpected args: ${goStrings(args)}`);
  const name = args[0] as string;
  const o = pathOptions(p, flags.values.kubeconfig as string);
  const config = startingConfig(p, o);
  if ('type' in config) return yield* fail(p, config);
  if (name === '') return yield* fail(p, messageError('empty context names are not allowed'));
  if (!(name in config.contexts)) return yield* fail(p, messageError(`no context exists with the name: ${goQuote(name)}`));
  const next = cloneConfig(config);
  next.currentContext = name;
  const e = modifyConfig(p, o, next);
  if (e) return yield* fail(p, e);
  yield* p.write(1, `Switched to context ${goQuote(name)}.\n`);
  return 0;
}

function* setContext({ p, path, flags, args }: Invocation): Op<number> {
  if (args.length > 1) return yield* helpError(p, path, `Unexpected args: ${goStrings(args)}`);
  const v = flags.values;
  const current = v.current === true;
  let name = args[0] ?? '';
  if (name === '' && !current) return yield* fail(p, messageError('you must specify a non-empty context name or --current'));
  if (name !== '' && current) return yield* fail(p, messageError('you cannot specify both a context name and --current'));
  const o = pathOptions(p, v.kubeconfig as string);
  const config = startingConfig(p, o);
  if ('type' in config) return yield* fail(p, config);
  if (current) {
    if (config.currentContext === '') return yield* fail(p, messageError('no current context is set'));
    name = config.currentContext;
  }
  const next = cloneConfig(config);
  const existing = next.contexts[name];
  const entry = existing ?? { value: newContext(), origin: '' };
  if (flags.changed.includes('cluster')) entry.value.cluster = v.cluster as string;
  if (flags.changed.includes('user')) entry.value.authInfo = v.user as string;
  if (flags.changed.includes('namespace')) entry.value.namespace = v.namespace as string;
  next.contexts[name] = entry;
  const e = modifyConfig(p, o, next);
  if (e) return yield* fail(p, e);
  yield* p.write(1, `Context ${goQuote(name)} ${existing ? 'modified' : 'created'}.\n`);
  return 0;
}

function* deleteContext({ p, path, flags, args }: Invocation): Op<number> {
  const o = pathOptions(p, flags.values.kubeconfig as string);
  const config = startingConfig(p, o);
  if ('type' in config) return yield* fail(p, config);
  if (args.length !== 1) return yield* helpOutput(p, path);
  const configFile = o.explicit !== '' ? o.explicit : defaultFilename(p, o);
  const name = args[0] as string;
  if (!(name in config.contexts)) return yield* fail(p, messageError(`cannot delete context ${name}, not in ${configFile}`));
  if (config.currentContext === name) {
    yield* p.write(2, 'warning: this removed your active context, use "kubectl config use-context" to select a different one\n');
  }
  const next = cloneConfig(config);
  delete next.contexts[name];
  const e = modifyConfig(p, o, next);
  if (e) return yield* fail(p, e);
  yield* p.write(1, `deleted context ${name} from ${configFile}\n`);
  return 0;
}

function* getNames({ p, path, flags }: Invocation): Op<number> {
  const config = yield* starting(p, flags);
  if (typeof config === 'number') return config;
  // get-clusters ranges over the map (Go's order is random; sorted here), get-users sorts.
  const names = Object.keys(path === 'config get-clusters' ? config.clusters : config.users).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  yield* p.write(1, `NAME\n${names.map((n) => `${n}\n`).join('')}`);
  return 0;
}

export const configGetContextsVerb: Verb = {
  path: 'config get-contexts',
  flags: [
    { name: 'no-headers', kind: 'bool', default: false },
    { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  ],
  run: getContexts,
};

export const configCurrentContextVerb: Verb = { path: 'config current-context', flags: [], run: currentContext };

export const configUseContextVerb: Verb = { path: 'config use-context', flags: [], run: useContext };

export const configSetContextVerb: Verb = {
  path: 'config set-context',
  flags: [
    { name: 'current', kind: 'bool', default: false },
    { name: 'cluster', kind: 'string', default: '' },
    { name: 'user', kind: 'string', default: '' },
    { name: 'namespace', shorthand: 'n', kind: 'string', default: '' },
  ],
  run: setContext,
};

export const configDeleteContextVerb: Verb = { path: 'config delete-context', flags: [], run: deleteContext };

export const configGetClustersVerb: Verb = { path: 'config get-clusters', flags: [], run: getNames };

export const configGetUsersVerb: Verb = { path: 'config get-users', flags: [], run: getNames };
