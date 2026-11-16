// The pure half of `npm run images:capture`: the catalog's shape, how a registry's documents become
// a record, and how the committed files are rendered and compared. No I/O here (catalog.test.ts).

import type { RegistrySpec } from './references.ts';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface Descriptor {
  digest: string;
  mediaType: string;
  size: number;
}

/** The fields of the image config's `config` object the runtime uses, verbatim (Docker's names). */
export const CONFIG_FIELDS = ['User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'ExposedPorts', 'StopSignal', 'Labels'] as const;

export interface RawConfig {
  digest: string;
  size: number;
  mediaType: string;
  created: string;
  architecture: string;
  os: string;
  variant?: string;
  /** Only CONFIG_FIELDS, as the config blob has them (absent fields stay absent, nulls stay null). */
  config: JsonObject;
}

export interface RawImage {
  repository: string;
  tags: string[];
  /** The repo digest: Docker-Content-Digest of the document the tag names. */
  digest: string;
  /** The tag's document when it is an index (OCI image index or Docker manifest list). */
  index?: { mediaType: string; size: number };
  manifest: Descriptor;
  config: RawConfig;
  layers: Descriptor[];
  /** The family whose representative's files stand for this image's (references.ts FAMILIES). */
  family?: string;
}

export interface ErrorRequest {
  method: 'HEAD' | 'GET';
  url: string;
  status: number;
  contentType?: string;
  wwwAuthenticate?: string;
  /** Parsed JSON when the answer is JSON, otherwise the text; absent for HEAD. */
  body?: Json;
}

export interface ErrorRecord {
  reference: string;
  what: string;
  token?: { url: string; status: number };
  requests: ErrorRequest[];
}

export interface CatalogHeader {
  producedBy: string;
  captured: string;
  platform: string;
  accept: string;
  registries: readonly RegistrySpec[];
  notes: string[];
}

export interface Catalog {
  header: CatalogHeader;
  /** Every recorded reference → its repo digest, sorted by reference. */
  references: Record<string, string>;
  /** Listed tags the registry does not have, with the HEAD status it answered. */
  missing: { reference: string; status: number }[];
  images: RawImage[];
  errors: ErrorRecord[];
  /** Each captured repository's tags/list, filtered (references.ts keepTag) and sorted. */
  repositoryTags: Record<string, string[]>;
  officialImages: OfficialImages;
  /** The representative image of each family, whose layers were listed (files/<family>.json). */
  families: { family: string; reference: string; configDigest: string }[];
}

export interface OfficialImages {
  /** Docker Hub's listing of the library namespace (deprecated images included). */
  hub: { url: string; count: number };
  /** docker-library/official-images library/ at a commit (maintained images). */
  github: { repository: string; path: string; commit: string; date: string; count: number };
  /** The union, sorted: docker.io/library/<name> exists exactly for these names. */
  names: string[];
  /** On Docker Hub but no longer in library/ (deprecated official images). */
  hubOnly: string[];
}

/** The engine's summary of a family representative's files. */
export interface FilesSummary {
  executables: string[];
  links: Record<string, string>;
}

export const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
export const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];

export function isIndex(mediaType: string): boolean {
  return INDEX_TYPES.includes(mediaType);
}

function asObject(v: unknown, what: string): JsonObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not a JSON object`);
  return v as JsonObject;
}

function descriptor(v: Json | undefined, what: string): Descriptor {
  const o = asObject(v, what);
  const { digest, mediaType, size } = o;
  if (typeof digest !== 'string' || typeof mediaType !== 'string' || typeof size !== 'number') throw new Error(`${what} is not a descriptor`);
  return { digest, mediaType, size };
}

/**
 * The manifest a linux/amd64 node pulls from an index: the first entry whose platform matches, as
 * containerd's platform matcher picks it (amd64 has no variants; attestation entries carry
 * unknown/unknown and never match).
 */
export function selectPlatformManifest(index: Json, platform: { os: string; architecture: string }): Descriptor {
  const manifests = asObject(index, 'index')['manifests'];
  if (!Array.isArray(manifests)) throw new Error('index has no manifests');
  for (const [i, m] of manifests.entries()) {
    const p = asObject(m, `manifests[${i}]`)['platform'];
    if (p === undefined) continue;
    const po = asObject(p, `manifests[${i}].platform`);
    if (po['os'] === platform.os && po['architecture'] === platform.architecture) return descriptor(m, `manifests[${i}]`);
  }
  throw new Error(`index has no ${platform.os}/${platform.architecture} manifest`);
}

/** The config descriptor and layers of an image manifest. */
export function manifestParts(manifest: Json): { config: Descriptor; layers: Descriptor[] } {
  const o = asObject(manifest, 'manifest');
  const layers = o['layers'];
  if (!Array.isArray(layers)) throw new Error('manifest has no layers');
  return { config: descriptor(o['config'], 'manifest config'), layers: layers.map((l, i) => descriptor(l, `layers[${i}]`)) };
}

export function rawConfig(desc: Descriptor, blob: Json): RawConfig {
  const o = asObject(blob, 'image config');
  const { created, architecture, os, variant } = o;
  if (typeof created !== 'string' || typeof architecture !== 'string' || typeof os !== 'string') throw new Error('image config lacks created, architecture or os');
  const inner = o['config'] === undefined || o['config'] === null ? {} : asObject(o['config'], 'image config.config');
  const config: JsonObject = {};
  for (const f of CONFIG_FIELDS) {
    const v = inner[f];
    if (v !== undefined) config[f] = f === 'Labels' && v !== null ? sortKeys(asObject(v, 'Labels')) : v;
  }
  return {
    digest: desc.digest,
    size: desc.size,
    mediaType: desc.mediaType,
    created,
    architecture,
    os,
    ...(typeof variant === 'string' ? { variant } : {}),
    config,
  };
}

function sortKeys(o: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] as Json]));
}

/** Code-unit order, so the output never depends on the locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Images sorted by repository, then by first tag; each image's tags sorted. */
export function sortImages(images: RawImage[]): RawImage[] {
  for (const im of images) im.tags.sort(byCodeUnit);
  return images.sort((a, b) => byCodeUnit(a.repository, b.repository) || byCodeUnit(a.tags[0] ?? '', b.tags[0] ?? ''));
}

export function sortedRecord(entries: [string, string][]): Record<string, string> {
  return Object.fromEntries([...entries].sort((a, b) => byCodeUnit(a[0], b[0])));
}

/** The value of NAME in an image config's Env, e.g. NGINX_VERSION. */
export function envValue(config: RawConfig, name: string): string | undefined {
  const env = config.config['Env'];
  if (!Array.isArray(env)) return undefined;
  for (const e of env) if (typeof e === 'string' && e.startsWith(`${name}=`)) return e.slice(name.length + 1);
  return undefined;
}

/**
 * Splits a reference the way the catalog writes it: registry/path:tag, path may hold slashes.
 * (The tool only builds normalized references; this is not a general reference parser.)
 */
export function splitReference(ref: string): { repository: string; tag: string } {
  const colon = ref.lastIndexOf(':');
  if (colon <= ref.lastIndexOf('/')) throw new Error(`${ref} has no tag`);
  return { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

export function renderCatalogJson(c: Catalog): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

// ----- the engine's copy -----

export interface CapturedImage {
  repository: string;
  tags: string[];
  digest: string;
  index?: { mediaType: string; size: number };
  manifest: { digest: string; mediaType: string; size: number };
  config: {
    digest: string;
    size: number;
    created: string;
    user?: string;
    env: string[];
    entrypoint?: string[];
    cmd?: string[];
    workingDir?: string;
    exposedPorts?: string[];
    stopSignal?: string;
    labels?: Record<string, string>;
  };
  layers: { digest: string; mediaType: string; size: number }[];
  filesFrom?: string;
}

/** Labels larger than this (keys and values, in JSON) are left out of the engine's copy; catalog.json keeps them. */
export const MODULE_LABEL_LIMIT = 400;

function strings(v: Json | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((s) => {
    if (typeof s !== 'string') throw new Error('expected an array of strings');
    return s;
  });
}

function nonEmpty(v: Json | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function capturedImage(im: RawImage, filesFrom?: string): CapturedImage {
  const c = im.config.config;
  const user = nonEmpty(c['User']);
  const entrypoint = strings(c['Entrypoint']);
  const cmd = strings(c['Cmd']);
  const workingDir = nonEmpty(c['WorkingDir']);
  const ports = c['ExposedPorts'];
  const exposedPorts = ports !== undefined && ports !== null ? Object.keys(asObject(ports, 'ExposedPorts')).sort(byCodeUnit) : undefined;
  const stopSignal = nonEmpty(c['StopSignal']);
  const labelsRaw = c['Labels'];
  let labels: Record<string, string> | undefined;
  if (labelsRaw !== undefined && labelsRaw !== null && JSON.stringify(labelsRaw).length <= MODULE_LABEL_LIMIT) {
    labels = {};
    for (const [k, v] of Object.entries(asObject(labelsRaw, 'Labels'))) if (typeof v === 'string') labels[k] = v;
    if (Object.keys(labels).length === 0) labels = undefined;
  }
  return {
    repository: im.repository,
    tags: [...im.tags],
    digest: im.digest,
    ...(im.index ? { index: { ...im.index } } : {}),
    manifest: { ...im.manifest },
    config: {
      digest: im.config.digest,
      size: im.config.size,
      created: im.config.created,
      ...(user !== undefined ? { user } : {}),
      env: strings(c['Env']) ?? [],
      ...(entrypoint !== undefined ? { entrypoint } : {}),
      ...(cmd !== undefined ? { cmd } : {}),
      ...(workingDir !== undefined ? { workingDir } : {}),
      ...(exposedPorts !== undefined ? { exposedPorts } : {}),
      ...(stopSignal !== undefined ? { stopSignal } : {}),
      ...(labels !== undefined ? { labels } : {}),
    },
    layers: im.layers.map((l) => ({ ...l })),
    ...(filesFrom !== undefined ? { filesFrom } : {}),
  };
}

/** Images whose labels the engine's copy leaves out (too large), for the capture's report. */
export function droppedLabels(images: RawImage[]): string[] {
  return images.filter((im) => {
    const l = im.config.config['Labels'];
    return l !== undefined && l !== null && JSON.stringify(l).length > MODULE_LABEL_LIMIT;
  }).map((im) => `${im.repository}:${im.tags[0] ?? ''}`);
}

export function renderModule(c: Catalog, files: Record<string, FilesSummary>, command: string): string {
  const representative = new Map(c.families.map((f) => [f.family, f.configDigest]));
  const images = c.images.map((im) => {
    const rep = im.family === undefined ? undefined : representative.get(im.family);
    return capturedImage(im, rep !== undefined && rep !== im.config.digest ? rep : undefined);
  });
  const body = images.map((im) => `  ${JSON.stringify(im)},`).join('\n');
  const repoTags = Object.entries(c.repositoryTags)
    .map(([r, tags]) => `  ${JSON.stringify(r)}: ${JSON.stringify(tags)},`)
    .join('\n');
  const fileEntries = Object.entries(files)
    .sort((a, b) => byCodeUnit(a[0], b[0]))
    .map(([digest, f]) => `  ${JSON.stringify(digest)}: {\n    executables: ${JSON.stringify(f.executables)},\n    links: ${JSON.stringify(f.links)},\n  },`)
    .join('\n');
  return `// Generated by ${command} (tools/src/images/capture.ts) from fixtures/reference/images/catalog.json.
// Do not edit. Facts the registries answered on ${c.header.captured} for the image references the
// tool lists, as a ${c.header.platform} node running containerd resolves them: the repo digest of each
// tag, the ${c.header.platform} manifest, the image config (its digest is the image ID crictl shows) and
// the layers. Labels over ${MODULE_LABEL_LIMIT} bytes of JSON are left out; catalog.json keeps them.

export interface CapturedImage {
  /** Normalized repository, e.g. docker.io/library/nginx. */
  repository: string;
  /** Tags that named this image at capture time, sorted. */
  tags: string[];
  /** Repo digest: Docker-Content-Digest of the tag's document (usually an index). */
  digest: string;
  /** The tag's document when it is an OCI image index or Docker manifest list. */
  index?: { mediaType: string; size: number };
  /** The ${c.header.platform} image manifest (the tag's document itself when there is no index). */
  manifest: { digest: string; mediaType: string; size: number };
  /** The image config blob; digest is the image ID. */
  config: {
    digest: string;
    size: number;
    created: string;
    user?: string;
    env: string[];
    entrypoint?: string[];
    cmd?: string[];
    workingDir?: string;
    exposedPorts?: string[];
    stopSignal?: string;
    labels?: Record<string, string>;
  };
  /** Compressed layers, in order. */
  layers: { digest: string; mediaType: string; size: number }[];
  /**
   * Config digest of the image whose files (IMAGE_FILES) stand for this one's: its family's
   * representative, the only images whose layers were listed. An approximation: another tag of the
   * same family can add or drop a binary. Absent on the representatives themselves.
   */
  filesFrom?: string;
}

export const IMAGE_CATALOG_CAPTURED: string = ${JSON.stringify(c.header.captured)};

export const IMAGE_CATALOG: readonly CapturedImage[] = [
${body}
];

/**
 * Each captured repository's tags (tags/list) at capture time, sorted. registry.k8s.io kube-*
 * repositories keep only v1.30 to v1.39 and the captured tags; cosign sha256-<hex>.sig/.att/.sbom
 * tags are dropped everywhere. A tag missing here does not exist (at capture time); a tag here
 * without an IMAGE_CATALOG entry exists but was not captured.
 */
export const IMAGE_REPOSITORY_TAGS: Readonly<Record<string, readonly string[]>> = {
${repoTags}
};

/**
 * Names of Docker Hub's official images (docker.io/library/<name>) at capture time: Docker Hub's
 * listing of the library namespace (deprecated images included, they still pull) united with
 * docker-library/official-images library/ at ${c.officialImages.github.commit.slice(0, 12)}. A name outside
 * this list does not exist.
 */
export const DOCKER_OFFICIAL_IMAGES: readonly string[] = ${JSON.stringify(c.officialImages.names)};

/**
 * Files of the family representatives, by config digest (fixtures/reference/images/files/):
 * executables are the absolute paths of executable regular files, and of symlinks and hardlinks to
 * them, directly in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin and in the
 * directories of the image config's own PATH (e.g. httpd's /usr/local/apache2/bin), executables at
 * /, /docker-entrypoint* and /docker-entrypoint.d/*, and for the distroless images (pause, coredns,
 * etcd, kube-apiserver, kube-controller-manager, kube-scheduler) every executable regular file
 * wherever it is. Paths are as stored: a PATH directory that is a
 * symlink (merged /usr: /bin → /usr/bin) lists nothing of its own and appears in links instead.
 * links maps each symlink and hardlink among them to the absolute path it finally names.
 */
export const IMAGE_FILES: Readonly<Record<string, { readonly executables: readonly string[]; readonly links: Readonly<Record<string, string>> }>> = {
${fileEntries}
};
`;
}

// ----- --check -----

/** What changed between the committed catalog and a fresh one, one line per difference. */
export function diffCatalogs(old: Catalog, fresh: Catalog): string[] {
  const out: string[] = [];
  const refs = new Set([...Object.keys(old.references), ...Object.keys(fresh.references)]);
  for (const r of [...refs].sort(byCodeUnit)) {
    const a = old.references[r];
    const b = fresh.references[r];
    if (a === b) continue;
    if (a === undefined) out.push(`${r}: new, ${b ?? ''}`);
    else if (b === undefined) out.push(`${r}: no longer resolves (was ${a})`);
    else out.push(`${r}: moved ${a} -> ${b}`);
  }
  const missing = (c: Catalog): string => JSON.stringify(c.missing);
  if (missing(old) !== missing(fresh)) out.push(`missing tags: ${missing(old)} -> ${missing(fresh)}`);
  const imageKey = (im: RawImage): string => `${im.repository}@${im.digest}`;
  const oldImages = new Map(old.images.map((im) => [imageKey(im), im]));
  for (const im of fresh.images) {
    const prev = oldImages.get(imageKey(im));
    if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(im)) out.push(`${imageKey(im)}: record differs (tags ${prev.tags.join(',')} -> ${im.tags.join(',')})`);
  }
  const oldErrors = new Map(old.errors.map((e) => [e.reference, JSON.stringify(e)]));
  for (const e of fresh.errors) {
    const prev = oldErrors.get(e.reference);
    if (prev !== JSON.stringify(e)) out.push(`errors ${e.reference}: ${prev ?? 'new'} -> ${JSON.stringify(e)}`);
  }
  for (const r of oldErrors.keys()) if (!fresh.errors.some((e) => e.reference === r)) out.push(`errors ${r}: no longer probed`);
  const repos = new Set([...Object.keys(old.repositoryTags), ...Object.keys(fresh.repositoryTags)]);
  for (const r of [...repos].sort(byCodeUnit)) {
    const a = new Set(old.repositoryTags[r] ?? []);
    const b = new Set(fresh.repositoryTags[r] ?? []);
    const added = [...b].filter((t) => !a.has(t));
    const removed = [...a].filter((t) => !b.has(t));
    if (added.length > 0) out.push(`${r} tags added: ${added.join(' ')}`);
    if (removed.length > 0) out.push(`${r} tags removed: ${removed.join(' ')}`);
  }
  const oi = (c: Catalog): string => JSON.stringify(c.officialImages.names);
  if (oi(old) !== oi(fresh)) out.push(`official images: ${oi(old)} -> ${oi(fresh)}`);
  else if (old.officialImages.github.commit !== fresh.officialImages.github.commit) out.push(`official-images library/ commit ${old.officialImages.github.commit} -> ${fresh.officialImages.github.commit} (same names)`);
  return out;
}
