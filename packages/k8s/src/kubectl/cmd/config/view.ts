// kubectl config view: the merged kubeconfig (or one file with --merge=false), minified to the
// current context, flattened, or with its secrets redacted and its data shortened.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/config/view.go Complete (arguments, the printer,
//             --context), Validate, Run, getStartingConfig
//   upstream: staging/src/k8s.io/client-go/tools/clientcmd/api/helpers.go MinifyConfig,
//             FlattenConfig, FlattenContent, ResolvePath, MakeAbs, RedactSecrets (the fields with a
//             datapolicy tag: client-key-data, token, password), ShortenConfig (DATA+OMITTED)
//   upstream: staging/src/k8s.io/cli-runtime/pkg/genericclioptions print_flags.go (the formats
//             and their error), cli-runtime/pkg/printers json.go, yaml.go, name.go
//   fixtures/golden/v1.37.2/config/view.yaml, client/config.yaml
// --merge is a Tristate whose default counts as provided, so an explicit file is still loaded
// through the merging rules unless --merge=false is given (view.go's IsExplicitFile branch never
// sets it): checked against the real binary, `config view --kubeconfig <dir>`.

import { FsError, type ProcApi } from '@simlab/host';
import { decodeBase64, utf8Bytes } from '../../../apimachinery/base64.ts';
import { printJson } from '../../../apimachinery/yaml/jsonprint.ts';
import type { Invocation, Op, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { fail } from '../../client/session.ts';
import { CHANGE_FORMATS, goStrings, namePrinted, usageError } from '../helpers.ts';
import { toYaml } from '../printing.ts';
import { absPath, dirOf, loadFromFile, osError, pathOptions, startingConfig } from './access.ts';
import { toV1, type Config } from '../../client/kubeconfigmodel.ts';
import { joinPath } from '../../resource/glob.ts';

const TEMPLATE_FORMATS = new Set(['go-template', 'go-template-file', 'template', 'templatefile', 'jsonpath', 'jsonpath-as-json', 'jsonpath-file']);

type ViewPrinter = 'yaml' | 'json' | 'name';

function printerFor(output: string, template: string): ViewPrinter | KubectlError {
  let format = output;
  if (format === '' && template !== '') format = 'go-template';
  const lower = format.toLowerCase();
  if (lower === 'json') return 'json';
  if (lower === 'yaml') return 'yaml';
  if (lower === 'kyaml') return { type: 'notSimulated', what: 'the output format "kyaml"' };
  if (lower === 'name' || lower === '') return 'name';
  const name = format.includes('=') ? format.slice(0, format.indexOf('=')) : format;
  if (TEMPLATE_FORMATS.has(name)) return { type: 'notSimulated', what: `the output format "${name}"` };
  return messageError(`unable to match a printer suitable for the output format "${output}", allowed formats are: ${CHANGE_FORMATS.join(',')}`);
}

/** MinifyConfig */
function minify(c: Config): KubectlError | undefined {
  if (c.currentContext === '') return messageError('current-context must exist in order to minify');
  const ctx = c.contexts[c.currentContext];
  if (!ctx) return messageError(`cannot locate context ${c.currentContext}`);
  const clusters: Config['clusters'] = {};
  if (ctx.value.cluster !== '') {
    const cl = c.clusters[ctx.value.cluster];
    if (!cl) return messageError(`cannot locate cluster ${ctx.value.cluster}`);
    clusters[ctx.value.cluster] = cl;
  }
  const users: Config['users'] = {};
  if (ctx.value.authInfo !== '') {
    const u = c.users[ctx.value.authInfo];
    if (!u) return messageError(`cannot locate user ${ctx.value.authInfo}`);
    users[ctx.value.authInfo] = u;
  }
  c.clusters = clusters;
  c.users = users;
  c.contexts = { [c.currentContext]: ctx };
  return undefined;
}

/** FlattenContent: the file's bytes in place of its path. */
function flattenContent(p: ProcApi, path: string, contents: string | undefined, baseDir: string): { path: string; contents: string | undefined } | KubectlError {
  if (path === '') return { path, contents };
  if (contents !== undefined && contents.length > 0) return messageError('cannot have values for both path and contents');
  const abs = path.startsWith('/') ? path : joinPath(baseDir, path);
  try {
    return { path: '', contents: utf8Bytes(p.fs().readFile(abs)) };
  } catch (e) {
    if (e instanceof FsError) return messageError(osError(e.code === 'EISDIR' ? 'read' : 'open', abs, e));
    throw e;
  }
}

/** FlattenConfig */
function flatten(p: ProcApi, c: Config): KubectlError | undefined {
  for (const key of Object.keys(c.users).sort()) {
    const entry = c.users[key];
    if (!entry) continue;
    const u = entry.value;
    const base = absPath(p, dirOf(entry.origin));
    const cert = flattenContent(p, u.clientCertificate, u.clientCertificateData, base);
    if ('type' in cert) return cert;
    const certKey = flattenContent(p, u.clientKey, u.clientKeyData, base);
    if ('type' in certKey) return certKey;
    u.clientCertificate = cert.path;
    if (cert.contents !== undefined) u.clientCertificateData = cert.contents;
    u.clientKey = certKey.path;
    if (certKey.contents !== undefined) u.clientKeyData = certKey.contents;
  }
  for (const key of Object.keys(c.clusters).sort()) {
    const entry = c.clusters[key];
    if (!entry) continue;
    const base = absPath(p, dirOf(entry.origin));
    const ca = flattenContent(p, entry.value.certificateAuthority, entry.value.certificateAuthorityData, base);
    if ('type' in ca) return ca;
    entry.value.certificateAuthority = ca.path;
    if (ca.contents !== undefined) entry.value.certificateAuthorityData = ca.contents;
  }
  return undefined;
}

const DATA_OMITTED = decodeBase64('DATA+OMITTED') as string;
const REDACTED_BYTES = 'REDACTED';

/** RedactSecrets, then ShortenConfig. */
function redactAndShorten(c: Config): void {
  for (const entry of Object.values(c.users)) {
    const u = entry.value;
    // RedactSecrets: a non-nil []byte and a non-empty string with a datapolicy tag.
    if (u.clientKeyData !== undefined) u.clientKeyData = REDACTED_BYTES;
    if (u.token !== '') u.token = 'REDACTED';
    if (u.password !== '') u.password = 'REDACTED';
    // ShortenConfig
    if (u.clientKeyData !== undefined && u.clientKeyData.length > 0) u.clientKeyData = DATA_OMITTED;
    if (u.clientCertificateData !== undefined && u.clientCertificateData.length > 0) u.clientCertificateData = DATA_OMITTED;
    if (u.token !== '') u.token = 'REDACTED';
  }
  for (const entry of Object.values(c.clusters)) {
    const cl = entry.value;
    if (cl.certificateAuthorityData !== undefined && cl.certificateAuthorityData.length > 0) cl.certificateAuthorityData = DATA_OMITTED;
  }
}

function* run({ p, path, flags, args }: Invocation): Op<number> {
  const v = flags.values;
  if (args.length !== 0) return yield* fail(p, usageError(path, `unexpected arguments: ${goStrings(args)}`));
  const printer = printerFor(v.output as string, v.template as string);
  if (typeof printer !== 'string') return yield* fail(p, printer);
  const context = v.context as string;
  const o = pathOptions(p, v.kubeconfig as string);
  const merge = v.merge === true;
  if (!merge && o.explicit === '') return yield* fail(p, messageError('if merge==false a precise file must be specified'));
  let config: Config;
  if (!merge) {
    const r = loadFromFile(p, o.explicit);
    if ('missing' in r) return yield* fail(p, messageError(`open ${o.explicit}: no such file or directory`));
    if ('error' in r) return yield* fail(p, r.error);
    config = r.config;
  } else {
    const r = startingConfig(p, o);
    if ('type' in r) return yield* fail(p, r);
    config = r;
  }
  if (v.minify === true) {
    if (context !== '') config.currentContext = context;
    const e = minify(config);
    if (e) return yield* fail(p, e);
  }
  if (v.flatten === true) {
    const e = flatten(p, config);
    if (e) return yield* fail(p, e);
  } else if (v.raw !== true) redactAndShorten(config);
  const obj = toV1(config);
  let out: string;
  if (printer === 'json') out = printJson(obj);
  else if (printer === 'yaml') out = toYaml(obj);
  else out = namePrinted(obj, '');
  yield* p.write(1, out);
  return 0;
}

export const configViewVerb: Verb = {
  path: 'config view',
  flags: [
    { name: 'output', shorthand: 'o', kind: 'string', default: 'yaml' },
    { name: 'template', kind: 'string', default: '' },
    { name: 'merge', kind: 'bool', default: true },
    { name: 'raw', kind: 'bool', default: false },
    { name: 'flatten', kind: 'bool', default: false },
    { name: 'minify', kind: 'bool', default: false },
  ],
  noEffect: {
    'allow-missing-template-keys': 'templates print a notice; no other printer reads it',
    'show-managed-fields': 'a kubeconfig has no managed fields to show or strip',
  },
  partial: { output: 'kyaml, go-template, template and jsonpath formats print a notice', template: 'go templates print a notice' },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'name', 'yaml'] },
  run,
};
