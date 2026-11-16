// The data sources of `kubectl create configmap` and `kubectl create secret generic`: literals
// (`--from-literal=key=value`), files and directories (`--from-file=[key=]path`), env files
// (`--from-env-file=path`), the key checks and the --append-hash suffix.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_configmap.go createConfigMap,
//             handleConfigMapFrom{Literal,File,EnvFile}Sources, addKeyFromFileToConfigMap,
//             addKeyFromLiteralToConfigMap, validateNewConfigMap
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/create/create_secret.go createSecret,
//             handleSecretFrom{Literal,File,EnvFile}Sources, addKeyFromLiteralToSecret
//   upstream: staging/src/k8s.io/kubectl/pkg/util/util.go ParseFileSource, ParseLiteralSource
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/env_file.go processEnvFileLine, AddFromEnvFile
//             (bufio.ScanLines: lines split at \n, a trailing \r dropped)
//   upstream: staging/src/k8s.io/kubectl/pkg/util/hash/hash.go ConfigMapHash, SecretHash, encodeHash
//   upstream: .upstream/go src/path/path.go Base; src/unicode/graphic.go IsSpace
// The simulated file system holds text, so every file is valid UTF-8 and lands in `data`
// (binaryData stays empty; DIV in the report).

import { FsError, type Fs } from '@simlab/host';
import { encodeBase64, utf8Bytes } from '../../../apimachinery/base64.ts';
import { marshalJson } from '../../../apimachinery/yaml/jsonprint.ts';
import { isConfigMapKey, isEnvVarName } from '../../../apimachinery/validation/names.ts';
import { goQuote } from '../../cli/flagset.ts';
import { errnoText } from '../../resource/files.ts';
import { sha256Hex } from './sha256.ts';

export type SourceResult = { error: string } | undefined;

/** Go's path.Base */
export function pathBase(p: string): string {
  if (p === '') return '.';
  let s = p;
  while (s.length > 0 && s.endsWith('/')) s = s.slice(0, -1);
  const i = s.lastIndexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  return s === '' ? '/' : s;
}

/** ParseFileSource */
export function parseFileSource(source: string): { key: string; path: string } | { error: string } {
  const n = source.split('=').length - 1;
  if (n === 0) return { key: pathBase(source), path: source };
  if (n === 1 && source.startsWith('=')) return { error: `key name for file path ${source.slice(1)} missing` };
  if (n === 1 && source.endsWith('=')) return { error: `file path for key name ${source.slice(0, -1)} missing` };
  if (n > 1) return { error: "key names or file paths cannot contain '='" };
  const [key, path] = source.split('=') as [string, string];
  return { key, path };
}

/** ParseLiteralSource */
export function parseLiteralSource(source: string): { key: string; value: string } | { error: string } {
  const i = source.indexOf('=');
  if (i <= 0) return { error: `invalid literal source ${source}, expected key=value` };
  return { key: source.slice(0, i), value: source.slice(i + 1) };
}

/** filepath.Join(dir, name) for a clean directory path and a plain name. */
function join(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, '');
  return d === '' ? `/${name}` : `${d}/${name}`;
}

function goErr(e: unknown, op: string, path: string): string {
  if (!(e instanceof FsError)) throw e;
  return `${op} ${path}: ${errnoText[e.code] ?? e.code.toLowerCase()}`;
}

function errnoOf(e: unknown): string {
  if (!(e instanceof FsError)) throw e;
  return errnoText[e.code] ?? e.code.toLowerCase();
}

/** Where a key goes: a ConfigMap's or a Secret's add function (its checks and messages differ). */
export type AddKey = (key: string, value: string) => SourceResult;

/** handle…FromFileSources: files by basename or key, directories by each regular file's name. */
export function addFileSources(fs: Fs, sources: readonly string[], add: AddKey): SourceResult {
  for (const source of sources) {
    const parsed = parseFileSource(source);
    if ('error' in parsed) return parsed;
    const { path } = parsed;
    let isDir: boolean;
    try {
      isDir = fs.stat(path).type === 'dir';
    } catch (e) {
      return { error: `error reading ${path}: ${errnoOf(e)}` };
    }
    if (isDir) {
      if (source.includes('=')) return { error: 'cannot give a key name for a directory path' };
      let names: string[];
      try {
        names = fs.readdir(path);
      } catch (e) {
        return { error: `error listing files in ${path}: ${goErr(e, 'open', path)}` };
      }
      for (const name of names) {
        const item = join(path, name);
        // os.ReadDir's DirEntry types come from lstat: symlinks and subdirectories are skipped.
        let regular: boolean;
        try {
          regular = fs.lstat(item).type === 'file';
        } catch {
          continue;
        }
        if (!regular) continue;
        const r = addFile(fs, name, item, add);
        if (r) return r;
      }
      continue;
    }
    const r = addFile(fs, parsed.key, path, add);
    if (r) return r;
  }
  return undefined;
}

function addFile(fs: Fs, key: string, path: string, add: AddKey): SourceResult {
  let data: string;
  try {
    data = fs.readFile(path);
  } catch (e) {
    return { error: goErr(e, 'open', path) };
  }
  return add(key, data);
}

/** handle…FromLiteralSources */
export function addLiteralSources(sources: readonly string[], add: AddKey): SourceResult {
  for (const source of sources) {
    const parsed = parseLiteralSource(source);
    if ('error' in parsed) return parsed;
    const r = add(parsed.key, parsed.value);
    if (r) return r;
  }
  return undefined;
}

/** unicode.IsSpace */
const GO_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** processEnvFileLine: the key and value of one line, or nothing for a blank line or a comment. */
export function envFileLine(raw: string, index: number, env: Readonly<Record<string, string>>): { key: string; value: string } | { error: string } | undefined {
  let line = index === 0 && raw.startsWith('﻿') ? raw.slice(1) : raw;
  line = line.replace(GO_SPACE, '');
  if (line === '' || line.startsWith('#')) return undefined;
  const eq = line.indexOf('=');
  const key = eq < 0 ? line : line.slice(0, eq);
  const errs = isEnvVarName(key);
  if (errs.length > 0) return { error: `${goQuote(key)} is not a valid key name: ${errs.join(';')}` };
  // A line without `=` takes the value of the variable in kubectl's own environment.
  return { key, value: eq < 0 ? (env[key] ?? '') : line.slice(eq + 1) };
}

/** bufio.ScanLines over a file's text. */
export function scanLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** handle…FromEnvFileSources; `dirError` is the command's own text for a directory. */
export function addEnvFileSources(fs: Fs, sources: readonly string[], env: Readonly<Record<string, string>>, dirError: string, add: AddKey): SourceResult {
  for (const source of sources) {
    let isDir: boolean;
    try {
      isDir = fs.stat(source).type === 'dir';
    } catch (e) {
      return { error: `error reading ${source}: ${errnoOf(e)}` };
    }
    if (isDir) return { error: dirError };
    let text: string;
    try {
      text = fs.readFile(source);
    } catch (e) {
      return { error: goErr(e, 'open', source) };
    }
    const lines = scanLines(text);
    for (let i = 0; i < lines.length; i++) {
      const r = envFileLine(lines[i] as string, i, env);
      if (r === undefined) continue;
      if ('error' in r) return r;
      const added = add(r.key, r.value);
      if (added) return added;
    }
  }
  return undefined;
}

// ---- the two kinds ----

export interface ConfigMapData {
  name: string;
  data: Record<string, string>;
}

/** addKeyFromLiteralToConfigMap with validateNewConfigMap */
export function configMapAdder(cm: ConfigMapData): AddKey {
  return (key, value) => {
    const errs = isConfigMapKey(key);
    if (errs.length > 0) return { error: `${goQuote(key)} is not a valid key name for a ConfigMap: ${errs.join(',')}` };
    if (Object.hasOwn(cm.data, key)) return { error: `cannot add key ${goQuote(key)}, another key by that name already exists in Data for ConfigMap ${goQuote(cm.name)}` };
    cm.data[key] = value;
    return undefined;
  };
}

export interface SecretData {
  name: string;
  type: string;
  /** Values as base64, the JSON form of []byte. */
  data: Record<string, string>;
}

/** addKeyFromLiteralToSecret */
export function secretAdder(s: SecretData): AddKey {
  return (key, value) => {
    const errs = isConfigMapKey(key);
    if (errs.length > 0) return { error: `${goQuote(key)} is not valid key name for a Secret ${errs.join(';')}` };
    if (Object.hasOwn(s.data, key)) return { error: `cannot add key ${key}, another key by that name already exists` };
    s.data[key] = encodeBase64(utf8Bytes(value));
    return undefined;
  };
}

/** encodeHash: the first ten hex digits with 0, 1, 3, a and e replaced (no vowels, no look-alikes). */
function encodeHash(hex: string): string {
  const swap: Record<string, string> = { '0': 'g', '1': 'h', '3': 'k', a: 'm', e: 't' };
  return [...hex.slice(0, 10)].map((c) => swap[c] ?? c).join('');
}

/** ConfigMapHash (no immutable field and no binaryData: neither can be set by the generator here). */
export function configMapHash(cm: ConfigMapData): string {
  return encodeHash(sha256Hex(utf8Bytes(marshalJson({ data: cm.data, kind: 'ConfigMap', name: cm.name }, { sortKeys: true }))));
}

/** SecretHash */
export function secretHash(s: SecretData): string {
  return encodeHash(sha256Hex(utf8Bytes(marshalJson({ data: s.data, kind: 'Secret', name: s.name, type: s.type }, { sortKeys: true }))));
}
