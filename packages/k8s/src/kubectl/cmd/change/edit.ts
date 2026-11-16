// kubectl edit: the objects (one, or several as a v1 List) written to a temporary file under the
// header comment, the editor run on it, and what was saved sent back as one strategic merge patch
// per object. A file that fails validation or parsing, or an object the server refuses as invalid,
// reopens the editor with the reasons at the top; quitting it unchanged then keeps the file.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/edit/edit.go NewCmdEdit (flags)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/editor/editoptions.go NewEditOptions,
//             editPrinterOptions.Complete (-o json: no header, .json), Complete (the builder:
//             ResourceTypeOrNameArgs(true, …).Latest(), Subresource), Run and editFn (the loop:
//             the header, ManualStrip of the failed edit, LaunchTempFile, "Edit cancelled, no valid
//             changes were saved.", the validation error as an Invalid reason, "Edit cancelled, no
//             changes made.", "Edit cancelled, saved file was empty.", "The edited file had a
//             syntax error: %v", RequireNamespace, the retryable/notfound endings, the reopen),
//             visitToPatch (by UID, "skipped", the preconditions and "At least one of apiVersion,
//             kind and name was changed", "Patch: %s", the patch with the field manager, field
//             validation and subresource, "edited"), visitAnnotation (--save-config),
//             editHeader.writeTo, editResults.addError, preservedFile ("A copy of your changes has
//             been stored to %q"), hasLines, hashOnLineBreak, "edit cancelled, no objects found"
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go StripComments (yaml.ToJSON, or
//             ManualStrip when that fails), ManualStrip
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/yaml/decoder.go ToJSON, IsJSONBuffer
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/editor/crlf/crlf.go (--windows-line-endings)
//   upstream: staging/src/k8s.io/kubectl/pkg/validation/schema.go paramVerifyingSchema.ValidateBytes
//   fixtures/golden/v1.37.2/change/edit.yaml

import type { Op, ProcApi } from '@simlab/host';
import { FsError } from '@simlab/host';
import { errorBody, invalid, NIL_PATH } from '../../../apimachinery/field.ts';
import { isObject, type JsonObject } from '../../../apimachinery/json.ts';
import { createTwoWayMergePatch } from '../../../apimachinery/strategicpatch/index.ts';
import { yamlToJson } from '../../../apimachinery/yaml/decode.ts';
import { marshalJson } from '../../../apimachinery/yaml/jsonprint.ts';
import type { Status } from '../../../apimachinery/errors.ts';
import { schema } from '../../../openapi/schema.ts';
import type { Invocation, Verb } from '../../cli/command.ts';
import { messageError, type KubectlError } from '../../cli/errors.ts';
import { goQuote, type FlagDef } from '../../cli/flagset.ts';
import { fail, overridesOf, request, resolveConfig, type Session } from '../../client/session.ts';
import { continueOnError, validateDocument, visitText } from '../../resource/files.ts';
import type { ServerState } from '../../resource/server.ts';
import { createOrUpdateAnnotation } from '../../util/apply.ts';
import { CHANGE_FORMATS, toPrinter, validationDirective, type FieldValidation } from '../helpers.ts';
import { parseYaml, toJson, toYaml, YamlMarshalError } from '../printing.ts';
import { find, infoBase, type Info } from './finder.ts';
import { createTemp, defaultEditor, launch } from './launch.ts';

const FLAGS: FlagDef[] = [
  { name: 'field-manager', kind: 'string', default: 'kubectl-edit' },
  { name: 'filename', shorthand: 'f', kind: 'stringSlice', default: [] },
  { name: 'kustomize', shorthand: 'k', kind: 'string', default: '' },
  { name: 'output', shorthand: 'o', kind: 'string', default: '' },
  { name: 'output-patch', kind: 'bool', default: false },
  { name: 'recursive', shorthand: 'R', kind: 'bool', default: false },
  { name: 'save-config', kind: 'bool', default: false },
  { name: 'subresource', kind: 'string', default: '' },
  { name: 'template', kind: 'string', default: '' },
  { name: 'validate', kind: 'string', default: 'strict', noOptDefVal: 'strict' },
  { name: 'windows-line-endings', kind: 'bool', default: false },
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const HEADER = `# Please edit the object below. Lines beginning with a '#' will be ignored,
# and an empty file will abort the edit. If an error occurs while saving this file will be
# reopened with the relevant failures.
#
`;

interface Reason {
  head: string;
  other: string[];
}

interface Results {
  reasons: Reason[];
  retryable: number;
  notfound: number;
  edit: number;
  file: string;
}

const newResults = (file: string): Results => ({ reasons: [], retryable: 0, notfound: 0, edit: 0, file });

/** hashOnLineBreak */
function hashOnLineBreak(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (i + 1 < s.length && ch === '\n' && s[i + 1] !== '#') r += '\n# ';
    else r += ch;
  }
  return r;
}

/** editHeader.writeTo */
function header(reasons: readonly Reason[]): string {
  let out = HEADER;
  for (const r of reasons) {
    out += r.other.length > 0 ? `# ${hashOnLineBreak(r.head)}:\n` : `# ${hashOnLineBreak(r.head)}\n`;
    for (const o of r.other) out += `# * ${hashOnLineBreak(o)}\n`;
    out += '#\n';
  }
  return out;
}

/** The resource string of addError: the plural resource, `.group` when it has one. */
function resourceString(info: Info): string {
  return info.mapping.group === '' ? info.mapping.resource : `${info.mapping.resource}.${info.mapping.group}`;
}

/** The text of an error as Go's %v prints it. */
function errorText(e: KubectlError): string {
  switch (e.type) {
    case 'status':
      return e.status.message ?? '';
    case 'message':
      return e.message;
    case 'aggregate': {
      const texts = [...new Set(e.errors.map(errorText))];
      return texts.length === 1 ? (texts[0] as string) : `[${texts.join(', ')}]`;
    }
    case 'url':
      return `${e.op} "${e.url}": ${e.err}`;
    case 'config':
      return e.errors.join(', ');
    case 'exit':
      return 'exit';
    case 'notSimulated':
      return e.what;
  }
}

/** editResults.addError: the line printed to standard error. */
function addError(r: Results, err: KubectlError, info: Info): string {
  const rs = resourceString(info);
  const status: Status | undefined = err.type === 'status' ? err.status : undefined;
  if (status?.reason === 'Invalid') {
    r.edit++;
    r.reasons.push({ head: `${rs} ${goQuote(info.name)} was not valid`, other: (status.details?.causes ?? []).map((c) => `${c.field ?? ''}: ${c.message ?? ''}`) });
    return `error: ${rs} ${goQuote(info.name)} is invalid`;
  }
  if (status?.reason === 'NotFound') {
    r.notfound++;
    return `error: ${rs} ${goQuote(info.name)} could not be found on the server`;
  }
  r.retryable++;
  return `error: ${rs} ${goQuote(info.name)} could not be patched: ${errorText(err)}`;
}

/** ManualStrip */
function manualStrip(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('#') && !t.startsWith('#!')) return;
    out.push(i < lines.length - 1 ? `${line}\n` : line);
  });
  return out.join('');
}

/** IsJSONBuffer: the first non-space character is `{`. */
const isJsonBuffer = (text: string): boolean => /^\s*\{/u.test(text);

/** StripComments: yaml.ToJSON of the text (as it is when it is JSON already), else ManualStrip. */
function stripComments(text: string): string | { unsupported: string } {
  if (isJsonBuffer(text)) return text;
  const r = yamlToJson(text);
  if (r.ok) return marshalJson(r.value, { sortKeys: true });
  if ('unsupported' in r) return { unsupported: r.unsupported };
  return manualStrip(text);
}

/** hasLines */
function hasLines(text: string): boolean {
  return text.split('\n').some((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('#');
  });
}

/** The object as the edit printer writes it (yaml by default, or json). */
function printEdited(obj: JsonObject, json: boolean): string {
  return json ? toJson(obj) : toYaml(obj);
}

/** encodeToJSON: the unstructured object's JSON. */
const encode = (obj: JsonObject): string => marshalJson(obj, { sortKeys: true });

const uidOf = (o: JsonObject): string => (isObject(o.metadata) ? str(o.metadata.uid) : '');

interface Options {
  directive: FieldValidation;
  json: boolean;
  outputPatch: boolean;
  crlf: boolean;
  saveConfig: boolean;
  fieldManager: string;
  subresource: string;
  output: string;
  template: string;
  namespace: string;
}

/** preservedFile: the message about the kept file (when it exists), then the error. */
function* preserved(p: ProcApi, err: KubectlError, path: string): Op<number> {
  if (path !== '') {
    let exists = true;
    try {
      p.fs().stat(path);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      exists = e.code !== 'ENOENT';
    }
    if (exists) yield* p.write(2, `A copy of your changes has been stored to ${goQuote(path)}\n`);
  }
  return yield* fail(p, err);
}

function removeFile(p: ProcApi, path: string): void {
  try {
    p.fs().unlink(path);
  } catch (e) {
    if (!(e instanceof FsError)) throw e;
  }
}

/** visitToPatch for the objects of the edited file. */
function* visitToPatch(p: ProcApi, s: Session, originals: readonly Info[], updated: readonly Info[], o: Options, results: Results): Op<KubectlError | undefined> {
  for (const info of updated) {
    const original = originals.find((i) => uidOf(i.object) === uidOf(info.object));
    if (!original) return { type: 'notSimulated', what: 'kubectl edit of an object whose UID was changed (kubectl prints the object in Go syntax)' };
    if (encode(original.object) === encode(info.object)) {
      const printer = toPrinter(o.output, 'skipped', 'none', o.template);
      if ('type' in printer) return printer;
      yield* p.write(1, printer.print(info.object));
      continue;
    }
    const t = schema().kind(str(info.object.apiVersion), str(info.object.kind));
    if (!t) return { type: 'notSimulated', what: `kubectl edit of a ${str(info.object.kind)}: a kind without a built-in type is patched with a JSON merge patch, which is not simulated` };
    const r = createTwoWayMergePatch(original.object, info.object, t.id);
    if ('error' in r) return { type: 'notSimulated', what: `a kubectl edit patch that cannot be computed (${r.error})` };
    const patch = r.ok;
    // mergepatch.RequireKeyUnchanged("apiVersion", "kind", "managedFields"), RequireMetadataKeyUnchanged("name")
    const md = isObject(patch.metadata) ? patch.metadata : {};
    if ('apiVersion' in patch || 'kind' in patch || 'managedFields' in patch || 'name' in md) {
      return messageError('At least one of apiVersion, kind and name was changed');
    }
    if (o.outputPatch) yield* p.write(1, `Patch: ${marshalJson(patch, { sortKeys: true })}\n`);
    const res = yield* request(s, {
      verb: 'patch',
      ...infoBase(info),
      name: info.name,
      ...(o.subresource !== '' ? { subresource: o.subresource } : {}),
      body: patch,
      options: { patchType: 'strategic', fieldManager: o.fieldManager, fieldValidation: o.directive },
    });
    if (!res.ok) {
      if ('notSimulated' in res) return { type: 'notSimulated', what: res.notSimulated };
      yield* p.write(2, `${addError(results, { type: 'status', status: res.status }, info)}\n`);
      continue;
    }
    info.object = res.object as JsonObject;
    const printer = toPrinter(o.output, 'edited', 'none', o.template);
    if ('type' in printer) return printer;
    try {
      yield* p.write(1, printer.print(info.object));
    } catch (e) {
      if (!(e instanceof YamlMarshalError)) throw e;
      return messageError(e.message);
    }
  }
  return undefined;
}

/** editFn: the loop until the edit succeeds or is cancelled. */
function* editLoop(p: ProcApi, s: Session, server: ServerState, infos: Info[], o: Options): Op<number> {
  const editor = defaultEditor(p.env);
  let results = newResults('');
  let original = '';
  let edited = '';
  let containsError = false;
  for (;;) {
    const obj: JsonObject =
      infos.length === 1 ? (infos[0] as Info).object : { kind: 'List', apiVersion: 'v1', metadata: {}, items: infos.map((i) => i.object) };
    let buf = o.json ? '' : header(results.reasons);
    if (!containsError) {
      try {
        buf += printEdited(obj, o.json);
      } catch (e) {
        if (!(e instanceof YamlMarshalError)) throw e;
        return yield* preserved(p, messageError(e.message), results.file);
      }
      original = buf;
    } else buf += manualStrip(edited);
    if (o.crlf) buf = buf.replace(/\n/g, '\r\n');
    if (!containsError && o.crlf) original = buf;
    // LaunchTempFile
    const editedDiff = edited;
    const file = createTemp(p, 'kubectl-edit-', o.json ? '.json' : '.yaml', buf);
    if (typeof file !== 'string') return yield* preserved(p, file, results.file);
    const launched = yield* launch(p, editor, file);
    if (launched) return yield* preserved(p, launched, results.file);
    try {
      edited = p.fs().readFile(file);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      return yield* preserved(p, messageError(`open ${file}: no such file or directory`), results.file);
    }
    const strippedEdited = stripComments(edited);
    if (typeof strippedEdited !== 'string') return yield* p.unsupported({ kind: 'behavior', what: strippedEdited.unsupported });
    if (containsError) {
      const before = stripComments(editedDiff);
      if (before === strippedEdited) return yield* preserved(p, messageError('Edit cancelled, no valid changes were saved.'), file);
    }
    if (results.file !== '') removeFile(p, results.file);
    // Validator(directive).ValidateBytes(StripComments(edited))
    if (o.directive !== 'Ignore') {
      const parsed = yamlToJson(strippedEdited);
      let verr: string | undefined;
      if (!parsed.ok) {
        if ('unsupported' in parsed) return yield* p.unsupported({ kind: 'behavior', what: parsed.unsupported });
        verr = parsed.error;
      } else {
        const v = yield* validateDocument(p, parsed.value, o.directive, server);
        if ('unsupported' in v) return yield* p.unsupported({ kind: 'behavior', what: v.unsupported });
        if ('error' in v) verr = v.error;
      }
      if (verr !== undefined) {
        results = newResults(file);
        containsError = true;
        const cause = invalid(NIL_PATH, 'The edited file failed validation', verr);
        const status = { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', code: 422, reason: 'Invalid', details: { causes: [{ reason: 'FieldValueInvalid', field: '<nil>', message: errorBody(cause) }] } } satisfies Status;
        yield* p.write(2, `${addError(results, { type: 'status', status }, infos[0] as Info)}\n`);
        continue;
      }
    }
    const strippedOriginal = stripComments(original);
    if (strippedOriginal === strippedEdited) {
      removeFile(p, file);
      yield* p.write(2, 'Edit cancelled, no changes made.\n');
      return 0;
    }
    if (!hasLines(edited)) {
      removeFile(p, file);
      yield* p.write(2, 'Edit cancelled, saved file was empty.\n');
      return 0;
    }
    results = newResults(file);
    // updatedResultGetter: Stream(edited, "edited-file"), Flatten, Infos()
    const items = yield* visitText(p, edited, 'edited-file', '', false, { server });
    if (!Array.isArray(items)) {
      if (items.type === 'notSimulated') return yield* fail(p, items);
      containsError = true;
      results.reasons.push({ head: `The edited file had a syntax error: ${errorText(items)}`, other: [] });
      continue;
    }
    const errs = items.flatMap((i) => ('error' in i ? [i.error] : []));
    const notSim = errs.find((e) => e.type === 'notSimulated');
    if (notSim) return yield* fail(p, notSim);
    const readErr = continueOnError([], errs);
    if (readErr) {
      containsError = true;
      results.reasons.push({ head: `The edited file had a syntax error: ${errorText(readErr)}`, other: [] });
      continue;
    }
    containsError = false;
    const updated: Info[] = items.flatMap((i) => ('error' in i ? [] : [{ mapping: i.mapping, namespace: i.namespace, name: i.name, source: i.source, object: i.object }]));
    // RequireNamespace(o.CmdNamespace)
    for (const u of updated) {
      if (!u.mapping.namespaced) continue;
      if (u.namespace === '') {
        u.namespace = o.namespace;
        if (!isObject(u.object.metadata)) u.object.metadata = {};
        (u.object.metadata as JsonObject).namespace = o.namespace;
        continue;
      }
      if (u.namespace !== o.namespace) {
        return yield* preserved(
          p,
          messageError(`the namespace from the provided object ${goQuote(u.namespace)} does not match the namespace ${goQuote(o.namespace)}. You must pass '--namespace=${u.namespace}' to perform this operation.`),
          file,
        );
      }
    }
    // visitAnnotation
    if (o.saveConfig) for (const u of updated) createOrUpdateAnnotation(true, u.object);
    const err = yield* visitToPatch(p, s, infos, updated, o, results);
    if (err?.type === 'notSimulated') return yield* fail(p, err);
    if (err) return yield* preserved(p, err, results.file);
    if (results.retryable > 0) {
      yield* p.write(2, `You can run \`kubectl replace -f ${file}\` to try this update again.\n`);
      return yield* fail(p, { type: 'exit' });
    }
    if (results.notfound > 0) {
      yield* p.write(2, `The edits you made on deleted resources have been saved to ${goQuote(file)}\n`);
      return yield* fail(p, { type: 'exit' });
    }
    if (results.edit === 0) {
      removeFile(p, file);
      return 0;
    }
    if (results.reasons.length > 0) containsError = true;
  }
}

function* run(inv: Invocation): Op<number> {
  const { p, flags } = inv;
  const v = flags.values;
  const output = str(v.output);
  const template = str(v.template);
  // editPrinterOptions.Complete: -o binds the edit printer too, which knows json and yaml only.
  const editFormat = output === '' ? 'yaml' : output;
  const config = resolveConfig(p, overridesOf(v), parseYaml);
  if ('type' in config) return yield* fail(p, config);
  const subresource = str(v.subresource);
  if (subresource !== '' && subresource !== 'status') return yield* p.unsupported({ kind: 'flag-value', what: `the flag --subresource=${subresource}` });
  const found = yield* find(p, {
    config,
    args: inv.args,
    filenames: (v.filename as string[] | undefined) ?? [],
    recursive: v.recursive === true,
    kustomize: str(v.kustomize),
    local: false,
    all: false,
    selector: '',
    fieldSelector: '',
    allNamespaces: false,
    latest: true,
    allowEmptySelector: true,
    subresource,
  });
  if (typeof found === 'number') return found;
  if ('error' in found) return yield* fail(p, found.error);
  const directive = validationDirective(str(v.validate));
  if (typeof directive !== 'string') return yield* fail(p, directive);
  // Run: OriginalResult.Infos()
  const errs = found.entries.flatMap((e) => ('error' in e ? [e.error] : []));
  const infoErr = continueOnError(errs, found.readErrors);
  if (infoErr) return yield* fail(p, infoErr);
  const infos = found.entries.flatMap((e) => ('info' in e ? [e.info] : []));
  if (infos.length === 0) return yield* fail(p, messageError('edit cancelled, no objects found'));
  if (editFormat !== 'yaml' && editFormat !== 'json') {
    // editPrinterOptions.PrintObj: JSONYamlPrintFlags.ToPrinter fails before the editor opens.
    if (editFormat === 'kyaml') return yield* p.unsupported({ kind: 'output-format', what: 'the output format "kyaml"' });
    return yield* fail(p, messageError(`unable to match a printer suitable for the output format "${output}", allowed formats are: json,kyaml,yaml`));
  }
  const o: Options = {
    directive,
    json: editFormat === 'json',
    outputPatch: v['output-patch'] === true,
    crlf: v['windows-line-endings'] === true,
    saveConfig: v['save-config'] === true,
    fieldManager: str(v['field-manager']),
    subresource,
    output,
    template,
    namespace: config.namespace,
  };
  const session = found.session as Session;
  return yield* editLoop(p, session, { session }, infos, o);
}

export const editVerb: Verb = {
  path: 'edit',
  flags: FLAGS,
  noEffect: {
    'allow-missing-template-keys': 'only used by template output formats, which print a notice',
    'show-managed-fields': 'objects have no managedFields (DIV-015)',
  },
  partial: {
    filename: 'URLs (http://, https://) print a notice: the simulated machines have no network access',
    kustomize: 'prints a notice: kustomize is not simulated',
    output: 'kyaml and the template formats print a notice',
    template: 'prints a notice: template output is not simulated',
    subresource: 'only status is simulated; other values print a notice',
  },
  outputFormats: { allowed: CHANGE_FORMATS, simulated: ['json', 'yaml', 'name'] },
  run,
};

