// kubectl version: the client's version, Kustomize's, and the server's from GET /version, as text,
// YAML or JSON, with the version-skew warning.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/version/version.go Complete (--client returns
//             before the arguments are kept, so they are not checked), Validate, Run (the server
//             error is returned after the output is printed)
//   upstream: staging/src/k8s.io/client-go/discovery/discovery_client.go ServerVersion (GET /version)
//   fixtures/golden/v1.37.2/info/version.yaml, info/no-server.yaml, client/no-server.yaml

import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { marshalIndentJson } from '../../../apimachinery/yaml/jsonprint.ts';
import type { Invocation, Op, Verb } from '../../cli/command.ts';
import { messageError } from '../../cli/errors.ts';
import type { ClientConfig } from '../../client/kubeconfig.ts';
import { fail, getNonResourcePath, overridesOf, resolveConfig } from '../../client/session.ts';
import { openServer } from '../../resource/server.ts';
import { goStrings } from '../helpers.ts';
import { parseYaml, toYaml } from '../printing.ts';
import { CLIENT_VERSION_INFO, KUSTOMIZE_VERSION } from './buildinfo.ts';
import { versionSkewWarning } from './skew.ts';

function* run({ p, flags, args }: Invocation): Op<number> {
  const v = flags.values;
  const clientOnly = v.client === true;
  const output = v.output as string;
  // Complete
  // ToDiscoveryClient: the configuration is resolved here, the server reached in Run.
  let config: ClientConfig | undefined;
  if (!clientOnly) {
    const c = resolveConfig(p, overridesOf(v), parseYaml);
    if ('type' in c) return yield* fail(p, c);
    config = c;
    // Validate
    if (args.length !== 0) return yield* fail(p, messageError(`extra arguments: ${goStrings(args)}`));
  }
  if (output !== '' && output !== 'yaml' && output !== 'json') return yield* fail(p, messageError(`--output must be 'yaml' or 'json'`));
  // Run
  const info: JsonObject = { clientVersion: { ...CLIENT_VERSION_INFO }, kustomizeVersion: KUSTOMIZE_VERSION };
  let serverErr: { url: string; dial: string } | undefined;
  if (config) {
    const s = yield* openServer(p, config);
    if (typeof s === 'number') return s;
    if ('session' in s) {
      const r = getNonResourcePath(s.session, '/version');
      if (!r.ok) {
        if ('notSimulated' in r) return yield* p.unsupported({ kind: 'behavior', what: r.notSimulated });
        return yield* fail(p, { type: 'status', status: r.status });
      }
      info.serverVersion = r.object;
    } else {
      serverErr = { url: `${s.refused.base}/version?timeout=32s`, dial: `dial tcp ${s.refused.dialAddress}: connect: connection refused` };
    }
  }
  const server = info.serverVersion as JsonObject | undefined;
  if (output === '') {
    let text = `Client Version: ${CLIENT_VERSION_INFO.gitVersion as string}\nKustomize Version: ${KUSTOMIZE_VERSION}\n`;
    if (server) text += `Server Version: ${server.gitVersion as string}\n`;
    yield* p.write(1, text);
  } else if (output === 'yaml') {
    // fmt.Fprintln of yaml.Marshal's output, which already ends in a newline.
    yield* p.write(1, `${toYaml(info as Json)}\n`);
  } else {
    yield* p.write(1, `${marshalIndentJson(info, '', '  ')}\n`);
  }
  if (server) {
    const warning = versionSkewWarning(CLIENT_VERSION_INFO.gitVersion as string, server.gitVersion as string);
    if (warning === undefined) return yield* p.unsupported({ kind: 'behavior', what: 'a server version that is not a semantic version' });
    // The plain "Warning: " prefix: version.go writes it with Fprintf, not the warning printer.
    if (warning !== '') yield* p.write(2, `Warning: ${warning}\n`);
  }
  if (serverErr) return yield* fail(p, { type: 'url', op: 'Get', url: serverErr.url, err: serverErr.dial });
  return 0;
}

export const versionVerb: Verb = {
  path: 'version',
  flags: [
    { name: 'client', kind: 'bool', default: false },
    { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  ],
  run,
};
