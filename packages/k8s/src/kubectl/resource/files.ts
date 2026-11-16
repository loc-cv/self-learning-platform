// Reading manifests with -f: kubectl's resource builder over files, directories, patterns and
// standard input (FilenameParam), each file decoded document by document (StreamVisitor), checked
// (the --validate schema), decoded into an unstructured object, mapped to its resource, lists
// flattened into their items, filtered by -l, and given its namespace. What the builder records
// before any file is read (a missing path, a bad pattern) is returned as one error; everything
// found while visiting comes back in visit order, objects and errors alike, with the stage each
// error belongs to (see FileItem).
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/builder.go FilenameParam, Stdin, URL,
//             Path (pathNotExistError, "cannot be accessed", "recognized file extensions"),
//             expandIfFilePattern, visitByPaths, Do (the helpers SetNamespace, RequireNamespace,
//             FilterNamespace, then ContinueOnErrorVisitor), FileExtensions, StdinMultiUseError,
//             FilenameOptions.validate
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/visitor.go EagerVisitorList,
//             ContinueOnErrorVisitor, FlattenListVisitor, ExpandPathsToFileVisitors (filepath.Walk,
//             ignoreFile), FileVisitor (os.Open, the UTF-8 BOM), StreamVisitor ("error parsing %s",
//             "error validating %q", empty and null documents skipped), ValidateSchema
//             (stopValidateMessage), RequireNamespace, FilterNamespace, FilterByLabelSelector
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/mapper.go infoForData ("unable to decode
//             %q", "resource mapping not found for name: %q namespace: %q from %q: %w\nensure CRDs
//             are installed first", "unable to recognize %q"), infoForObject ("unable to recognize %v")
//   upstream: staging/src/k8s.io/cli-runtime/pkg/resource/metadata_decoder.go (metadata decoded
//             into ObjectMeta); staging/src/k8s.io/apimachinery/pkg/apis/meta/v1/unstructured/
//             helpers.go unstructuredJSONScheme.decode (detector, decodeToList: items inherit the
//             list's kind without "List" and its apiVersion), runtime/error.go missingKindErr
//   upstream: staging/src/k8s.io/kubectl/pkg/validation/validation.go getObjectKind, validateList;
//             schema.go paramVerifyingSchema (the klog warning at schema.go:145);
//             staging/src/k8s.io/cli-runtime/pkg/resource/query_param_verifier_v3.go and
//             query_param_verifier.go HasSupport (a kind with a PATCH path supports fieldValidation;
//             v1 List never does), fallback_query_param_verifier.go
//   upstream: staging/src/k8s.io/apimachinery/pkg/runtime/schema/group_version.go ParseGroupVersion
//   fixtures/golden/v1.37.2/create/from-files.yaml, create/no-server.yaml, errors/validation.yaml,
//   client/yaml-input.yaml (the texts)

import { FsError, UnsupportedError, type Op, type ProcApi } from '@simlab/host';
import { isObject, type Json, type JsonObject } from '../../apimachinery/json.ts';
import { decode } from '../../apimachinery/gojson.ts';
import { decodeManifestStream } from '../../apimachinery/yaml/stream.ts';
import { marshalJson } from '../../apimachinery/yaml/jsonprint.ts';
import { isSelectorError, parseSelector, selectorMatches } from '../../apimachinery/labels.ts';
import { registry } from '../../discovery/registry.ts';
import { schema, type TypeExpr } from '../../openapi/schema.ts';
import { messageError, type KubectlError } from '../cli/errors.ts';
import { goQuote } from '../cli/flagset.ts';
import { mappingForKind, type Mapping } from '../client/restmapper.ts';
import { klogLine } from '../client/session.ts';
import { extOf, globPaths, joinPath } from './glob.ts';
import { discoveryError, openApiError, type ServerState } from './server.ts';

export interface FileOptions {
  filenames: string[];
  recursive: boolean;
  /** -k: kustomize is not simulated (a notice). */
  kustomize?: string;
}

export interface ReadOptions {
  /** The --validate directive of create and apply; absent: no schema (delete, describe). */
  validation?: 'Strict' | 'Warn';
  /** -l: only objects whose labels match. */
  selector?: string;
  server: ServerState;
}

/**
 * One object from a manifest, or an error, in visit order. `stage: 'read'` errors are the
 * EagerVisitorList's (a file that cannot be read, parsed or validated, a document that cannot be
 * decoded or mapped): kubectl collects them and reports them together after everything else.
 * `stage: 'visit'` errors (a namespace mismatch) are returned to the command's visitor like its
 * own errors, in order. `continueOnError` combines them as kubectl does.
 */
export type FileItem =
  | { source: string; object: JsonObject; mapping: Mapping; namespace: string; name: string }
  | { error: KubectlError; stage: 'read' | 'visit' };

/** builder.go FileExtensions */
const FILE_EXTENSIONS = ['.json', '.yaml', '.yml'];
const STDIN = 'STDIN';
const STOP_VALIDATE = 'if you choose to ignore these errors, turn validation off with --validate=false';

type Source = { kind: 'stdin' } | { kind: 'file'; path: string };

const errnoText: Record<string, string> = {
  // upstream: .upstream/go src/syscall/zerrors_linux_amd64.go (the errors table)
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  ELOOP: 'too many levels of symbolic links',
  ENAMETOOLONG: 'file name too long',
};

function goErr(e: FsError, op: string, path: string): string {
  return `${op} ${path}: ${errnoText[e.code] ?? e.code.toLowerCase()}`;
}

/** ContinueOnErrorVisitor's result: the command's errors in order, then the reader's as one aggregate. */
export function continueOnError(errors: readonly KubectlError[], readErrors: readonly KubectlError[]): KubectlError | undefined {
  const errs = [...errors];
  if (readErrors.length > 0) errs.push(readErrors.length === 1 ? (readErrors[0] as KubectlError) : { type: 'aggregate', errors: [...readErrors] });
  if (errs.length === 0) return undefined;
  return errs.length === 1 ? errs[0] : { type: 'aggregate', errors: errs };
}

function aggregate(errs: KubectlError[]): KubectlError {
  return errs.length === 1 ? (errs[0] as KubectlError) : { type: 'aggregate', errors: errs };
}

// ---- paths ----

interface Expanded {
  sources: Source[];
  errors: KubectlError[];
  urls: string[];
}

/** filepath.Walk over a path, as ExpandPathsToFileVisitors does: the files to read, or the error. */
function walk(p: ProcApi, root: string, recursive: boolean): string[] | string {
  const fs = p.fs();
  const out: string[] = [];
  const dir = (path: string): string | undefined => {
    let names: string[];
    try {
      names = fs.readdir(path);
    } catch (e) {
      if (e instanceof FsError) return goErr(e, 'open', path);
      throw e;
    }
    for (const name of names) {
      const child = joinPath(path, name);
      let type: string;
      try {
        type = fs.lstat(child).type;
      } catch (e) {
        if (e instanceof FsError) return goErr(e, 'lstat', child);
        throw e;
      }
      if (type === 'dir') {
        if (!recursive) continue;
        const err = dir(child);
        if (err !== undefined) return err;
        continue;
      }
      // ignoreFile: only a path passed explicitly is read whatever its extension.
      if (!FILE_EXTENSIONS.includes(extOf(child))) continue;
      out.push(child);
    }
    return undefined;
  };
  let rootType: string;
  try {
    rootType = fs.lstat(root).type;
  } catch (e) {
    if (e instanceof FsError) return goErr(e, 'lstat', root);
    throw e;
  }
  if (rootType !== 'dir') return [root];
  const err = dir(root);
  return err ?? out;
}

function expand(p: ProcApi, opts: FileOptions): Expanded {
  const fs = p.fs();
  const errors: KubectlError[] = [];
  const sources: Source[] = [];
  const urls: string[] = [];
  let stdinInUse = false;
  let paths = 0;
  for (const s of opts.filenames) {
    if (s === '-') {
      if (stdinInUse) errors.push(messageError('standard input cannot be used for multiple arguments'));
      stdinInUse = true;
      sources.push({ kind: 'stdin' });
      paths++;
      continue;
    }
    if (s.startsWith('http://') || s.startsWith('https://')) {
      urls.push(s);
      paths++;
      continue;
    }
    // expandIfFilePattern
    let matches: string[];
    let exists = true;
    try {
      fs.stat(s);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code === 'ENOENT') exists = false;
    }
    if (!exists) {
      const g = globPaths(fs, s);
      if (!Array.isArray(g)) {
        errors.push(messageError(`pattern ${goQuote(s)} is not valid: ${g.error}`));
        continue;
      }
      if (g.length === 0) {
        errors.push(messageError(`the path ${goQuote(s)} does not exist`));
        continue;
      }
      matches = g;
    } else matches = [s];
    // Path
    const found: string[] = [];
    for (const m of matches) {
      try {
        fs.stat(m);
      } catch (e) {
        if (!(e instanceof FsError)) throw e;
        if (e.code === 'ENOENT') errors.push(messageError(`the path ${goQuote(m)} does not exist`));
        else errors.push(messageError(`the path ${goQuote(m)} cannot be accessed: ${goErr(e, 'stat', m)}`));
        continue;
      }
      const files = walk(p, m, opts.recursive);
      if (typeof files === 'string') {
        errors.push(messageError(`error reading ${goQuote(m)}: ${files}`));
        continue;
      }
      found.push(...files);
    }
    for (const f of found) sources.push({ kind: 'file', path: f });
    paths += found.length;
    if (paths === 0 && errors.length === 0) {
      errors.push(messageError(`error reading [${matches.join(' ')}]: recognized file extensions are [${FILE_EXTENSIONS.join(' ')}]`));
    }
  }
  return { sources, errors, urls };
}

// ---- reading ----

/** What a FileVisitor reads: the text, or the error it stops with. */
function* readSource(p: ProcApi, src: Source): Op<{ text: string } | { error: string; parsing?: true } | { unsupported: string }> {
  if (src.kind === 'stdin') {
    let text = '';
    for (;;) {
      const chunk = yield* p.read(0);
      if (chunk === null) break;
      text += chunk;
    }
    return { text };
  }
  try {
    return { text: p.fs().readFile(src.path) };
  } catch (e) {
    if (e instanceof UnsupportedError) return { unsupported: e.what };
    if (!(e instanceof FsError)) throw e;
    // os.Open succeeds on a directory; reading it fails inside the decoder.
    if (e.code === 'EISDIR') return { error: goErr(e, 'read', src.path), parsing: true };
    return { error: goErr(e, 'open', src.path) };
  }
}

/** schema.ParseGroupVersion */
function parseGroupVersion(gv: string): { group: string; version: string } | { error: string } {
  if (gv === '' || gv === '/') return { group: '', version: '' };
  const parts = gv.split('/');
  if (parts.length === 1) return { group: '', version: gv };
  if (parts.length === 2) return { group: parts[0] as string, version: parts[1] as string };
  return { error: `unexpected GroupVersion string: ${gv}` };
}

/** validation.go getObjectKind: the GVK, or its errors. */
function objectKind(obj: Json): { group: string; version: string; kind: string } | { errors: string[] } {
  if (!isObject(obj)) return { errors: ['invalid object to validate'] };
  const errors: string[] = [];
  let group = '';
  let version = '';
  const apiVersion = obj.apiVersion;
  if (apiVersion === undefined || apiVersion === null) errors.push('apiVersion not set');
  else if (typeof apiVersion !== 'string') errors.push("apiVersion isn't string type");
  else {
    const gv = parseGroupVersion(apiVersion);
    if ('error' in gv) errors.push(gv.error);
    else ({ group, version } = gv);
  }
  const kind = obj.kind;
  if (kind === undefined || kind === null) errors.push('kind not set');
  else if (typeof kind !== 'string') errors.push("kind isn't string type");
  if (errors.length > 0) return { errors };
  return { group, version, kind: kind as string };
}

/** aggregate.Error of plain texts */
function joinErrors(errs: readonly string[]): string {
  const seen = [...new Set(errs)];
  return seen.length === 1 ? (seen[0] as string) : `[${seen.join(', ')}]`;
}

/** HasSupport: whether the server validates fields of this kind (it has a PATCH path). */
function supportsFieldValidation(gvk: { group: string; version: string; kind: string }): boolean {
  if (gvk.group === '' && gvk.version === 'v1' && gvk.kind === 'List') return false;
  return registry().all.some((r) => r.group === gvk.group && r.version === gvk.version && r.kind === gvk.kind && r.verbs.includes('patch'));
}

/** Whether a value has something kubectl's client-side OpenAPI validation would report. */
function modelProblems(value: Json, t: TypeExpr): boolean {
  if (t.k !== 'named') return false;
  const r = decode(value, t.id);
  if (r.error !== undefined || r.unknown.length > 0) return true;
  return missingRequired(value, t);
}

function missingRequired(v: Json | undefined, t: TypeExpr): boolean {
  if (v === undefined || v === null) return false;
  switch (t.k) {
    case 'ptr':
      return missingRequired(v, t.elem);
    case 'slice':
      return Array.isArray(v) && v.some((x) => missingRequired(x, t.elem));
    case 'map':
      return isObject(v) && Object.values(v).some((x) => missingRequired(x, t.elem));
    case 'named': {
      const nt = schema().type(t.id);
      if (nt.underlying) return missingRequired(v, nt.underlying);
      if (!nt.struct || !isObject(v)) return false;
      for (const f of nt.struct.fields) {
        if (f.required && !(f.json in v)) return true;
        if (f.json in v && missingRequired(v[f.json], f.type)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

type Validated = { ok: true } | { error: string } | { unsupported: string };

/** paramVerifyingSchema.ValidateBytes for one document. */
function* validateDocument(p: ProcApi, doc: Json, directive: 'Strict' | 'Warn', server: ServerState): Op<Validated> {
  const gvk = objectKind(doc);
  if ('errors' in gvk) return { error: joinErrors(gvk.errors) };
  const isList = gvk.group === '' && gvk.version === 'v1' && gvk.kind === 'List';
  if (!isList) {
    const download = openApiError(server);
    if (download !== undefined) return { error: download };
  }
  if (supportsFieldValidation(gvk)) return { ok: true };
  if (directive === 'Warn') {
    yield* p.write(2, klogLine(p, 'W', 'schema.go:145', 'cannot perform warn validation if server-side field validation is unsupported, skipping validation'));
    return { ok: true };
  }
  // Client-side validation against the OpenAPI v2 schema (validation.ValidateModel). The checks are
  // not ported: a document they would pass goes on, one they might reject prints a notice.
  if ('refused' in server) return { unsupported: "kubectl's client-side schema validation of a List with no server to download the schema from" };
  const unsupported = { unsupported: "kubectl's client-side schema validation (OpenAPI v2) of a document the server cannot validate itself" };
  if (isList) {
    const items = (doc as JsonObject).items;
    if (!Array.isArray(items)) return { error: 'invalid object to validate' };
    const errs: string[] = [];
    for (const item of items) {
      const k = objectKind(item);
      if ('errors' in k) {
        errs.push(...k.errors);
        continue;
      }
      const t = schema().kind(k.group === '' ? k.version : `${k.group}/${k.version}`, k.kind);
      if (t && modelProblems(item, { k: 'named', id: t.id })) return unsupported;
    }
    return errs.length > 0 ? { error: joinErrors(errs) } : { ok: true };
  }
  const t = schema().kind(gvk.group === '' ? gvk.version : `${gvk.group}/${gvk.version}`, gvk.kind);
  if (t && modelProblems(doc, { k: 'named', id: t.id })) return unsupported;
  return { ok: true };
}

const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');

/** The JSON type name Go's decoder reports for a value. */
function jsonTypeName(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : 'string';
}

type Info = { object: JsonObject; mapping: Mapping; name: string; namespace: string };

/** metadataValidatingDecoder: the metadata must decode into ObjectMeta. */
function metadataError(obj: JsonObject): string | { unsupported: string } | undefined {
  const md = obj.metadata;
  if (md === undefined || md === null) return undefined;
  if (!isObject(md)) return { unsupported: 'a manifest whose metadata is not a mapping' };
  const cm = schema().kind('v1', 'ConfigMap');
  if (!cm) throw new Error('no ConfigMap type');
  // Decoding only metadata through a type that embeds ObjectMeta under `metadata` names the field
  // as the real decoder does (`Go struct field ObjectMeta.metadata.labels`).
  return decode({ metadata: md }, cm.id).error;
}

type Decoded = { infos: Info[]; errors: KubectlError[] } | { error: string } | { unsupported: string };

/** mapper.infoForData (and FlattenListVisitor for a list) for one document. */
function* infoForData(p: ProcApi, doc: JsonObject | Json, raw: string, source: string, server: ServerState): Op<Decoded> {
  const decodeErr = (m: string): { error: string } => ({ error: `unable to decode ${goQuote(source)}: ${m}` });
  if (!isObject(doc)) return decodeErr(`json: cannot unmarshal ${jsonTypeName(doc)} into Go value of type unstructured.detector`);
  const isList = 'items' in doc;
  if (isList && doc.items !== null && !Array.isArray(doc.items)) return { unsupported: 'a manifest whose items field is not a list' };
  if (isList && Array.isArray(doc.items) && doc.items.some((i) => !isObject(i))) return { unsupported: 'a list whose items are not all objects' };
  const kind = str(doc.kind);
  if (kind === '') return decodeErr(`Object 'Kind' is missing in '${raw}'`);
  const md = metadataError(doc);
  if (typeof md === 'object') return md;
  if (md !== undefined) return decodeErr(md);
  const meta = isObject(doc.metadata) ? doc.metadata : {};
  const name = str(meta.name);
  const namespace = str(meta.namespace);
  const gv = typeof doc.apiVersion === 'string' ? parseGroupVersion(doc.apiVersion) : { group: '', version: '' };
  if ('error' in gv || gv.version === '') return { unsupported: 'a manifest without a valid apiVersion (read with --validate=false)' };
  const unreachable = yield* discoveryError(p, server);
  if (unreachable !== undefined) return { error: `unable to recognize ${goQuote(source)}: ${unreachable}` };
  const km = mappingForKind(gv.group, gv.version, kind);
  if ('noMatch' in km) {
    return { error: `resource mapping not found for name: ${goQuote(name)} namespace: ${goQuote(namespace)} from ${goQuote(source)}: ${km.noMatch}\nensure CRDs are installed first` };
  }
  if (!isList) {
    if (km.list) return { unsupported: `a ${kind} that has no items` };
    return { infos: [{ object: doc, mapping: km.mapping, name, namespace }], errors: [] };
  }
  // FlattenListVisitor
  const itemKind = kind.endsWith('List') ? kind.slice(0, -'List'.length) : kind;
  const infos: Info[] = [];
  const errors: KubectlError[] = [];
  for (const it of (doc.items as JsonObject[] | null) ?? []) {
    const item = it;
    if (item.kind === undefined && item.apiVersion === undefined) {
      item.kind = itemKind;
      item.apiVersion = doc.apiVersion as string;
    }
    if (Array.isArray(item.items)) return { unsupported: 'a list inside a list' };
    const ik = str(item.kind);
    const igv = typeof item.apiVersion === 'string' ? parseGroupVersion(item.apiVersion) : { error: '' };
    if (ik === '' || 'error' in igv || igv.version === '') return { unsupported: 'a list item without a kind or apiVersion (read with --validate=false)' };
    const im = mappingForKind(igv.group, igv.version, ik);
    if ('noMatch' in im) {
      errors.push(messageError(`unable to recognize ${im.noMatch}`));
      continue;
    }
    if (im.list) return { unsupported: `a list item of kind ${ik}` };
    const imd = isObject(item.metadata) ? item.metadata : {};
    infos.push({ object: item, mapping: im.mapping, name: str(imd.name), namespace: str(imd.namespace) });
  }
  return { infos, errors };
}

/** unstructured SetNamespace: an empty namespace removes the field. */
function setNamespace(obj: JsonObject, ns: string): void {
  if (ns === '') {
    if (isObject(obj.metadata)) delete obj.metadata.namespace;
    return;
  }
  if (!isObject(obj.metadata)) obj.metadata = {};
  (obj.metadata as JsonObject).namespace = ns;
}

/**
 * Every object of the -f manifests, in visit order, with the errors met on the way (see
 * FileItem); or the error the builder reports before visiting (a missing path, a bad pattern,
 * -f with -k, an invalid selector), or a notice for input the simulator does not read (URLs, -k).
 */
export function* visitFiles(p: ProcApi, opts: FileOptions, defaultNamespace: string, enforceNamespace: boolean, r: ReadOptions): Op<FileItem[] | KubectlError> {
  // FilenameOptions.validate
  const optErrs: KubectlError[] = [];
  if (opts.filenames.length > 0 && opts.kustomize) optErrs.push(messageError('only one of -f or -k can be specified'));
  if (opts.kustomize && opts.recursive) optErrs.push(messageError("the -k flag can't be used with -f or -R"));
  if (optErrs.length > 0) return aggregate(optErrs);
  const ex = expand(p, opts);
  if (ex.errors.length > 0) return aggregate(ex.errors);
  // visitByPaths: the selector is parsed once the paths are known.
  const selectorText = (r.selector ?? '').trim();
  let selector: ReturnType<typeof parseSelector> | undefined;
  if (selectorText !== '') {
    selector = parseSelector(selectorText);
    if (isSelectorError(selector)) return messageError(`the provided selector ${goQuote(selectorText)} is not valid: ${selector.error}`);
  }
  if (ex.urls.length > 0) return { type: 'notSimulated', what: `reading manifests from a URL (${ex.urls[0] as string}; the simulated machines have no network)` };
  if (opts.kustomize) return { type: 'notSimulated', what: 'kustomize (-k)' };

  const items: FileItem[] = [];
  const readError = (m: string): void => {
    items.push({ error: messageError(m), stage: 'read' });
  };
  for (const src of ex.sources) {
    const source = src.kind === 'stdin' ? STDIN : src.path;
    const content = yield* readSource(p, src);
    if ('unsupported' in content) return { type: 'notSimulated', what: content.unsupported };
    if ('error' in content) {
      readError(content.parsing ? `error parsing ${source}: ${content.error}` : content.error);
      continue;
    }
    // FileVisitor decodes through a UTF-8 BOM override.
    const text = content.text.startsWith('﻿') ? content.text.slice(1) : content.text;
    const stream = decodeManifestStream(text);
    if (stream.unsupported !== undefined) return { type: 'notSimulated', what: stream.unsupported };
    let stopped = false;
    for (let i = 0; i < stream.docs.length; i++) {
      const doc = stream.docs[i] as Json;
      if (doc === null) continue;
      if (r.validation) {
        const v = yield* validateDocument(p, doc, r.validation, r.server);
        if ('unsupported' in v) return { type: 'notSimulated', what: v.unsupported };
        if ('error' in v) {
          readError(`error validating ${goQuote(source)}: error validating data: ${v.error}; ${STOP_VALIDATE}`);
          stopped = true;
          break;
        }
      }
      const raw = stream.raw?.[i] ?? marshalJson(doc, { sortKeys: true });
      const d = yield* infoForData(p, doc, raw, source, r.server);
      if ('unsupported' in d) return { type: 'notSimulated', what: d.unsupported };
      if ('error' in d) {
        readError(d.error);
        continue;
      }
      for (const info of d.infos) {
        // FilterByLabelSelector
        if (selector && !isSelectorError(selector)) {
          const labels = isObject(info.object.metadata) && isObject(info.object.metadata.labels) ? info.object.metadata.labels : {};
          if (!selectorMatches(selector, labels as Record<string, string>)) continue;
        }
        // Do's helpers: SetNamespace, RequireNamespace, FilterNamespace.
        let ns = info.namespace;
        if (info.mapping.namespaced) {
          if (ns === '') {
            ns = defaultNamespace;
            setNamespace(info.object, ns);
          }
          if (enforceNamespace && ns !== defaultNamespace) {
            items.push({
              error: messageError(`the namespace from the provided object ${goQuote(ns)} does not match the namespace ${goQuote(defaultNamespace)}. You must pass '--namespace=${ns}' to perform this operation.`),
              stage: 'visit',
            });
            continue;
          }
        } else {
          ns = '';
          setNamespace(info.object, '');
        }
        items.push({ source, object: info.object, mapping: info.mapping, namespace: ns, name: info.name });
      }
      if (d.errors.length > 0) items.push({ error: aggregate(d.errors), stage: 'read' });
    }
    if (!stopped && stream.error !== undefined) readError(`error parsing ${source}: ${stream.error}`);
  }
  return items;
}
