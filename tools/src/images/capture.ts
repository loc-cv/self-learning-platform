// npm run images:capture [-- --check] [-- --refetch]
//
// What real OCI registries answer for the image references in references.ts, recorded for the
// simulated container runtime (containerd 1.7.28 on linux/amd64 nodes, rank 1 in docs/FIDELITY.md
// §2: the registries themselves). Anonymous HTTPS with Node's fetch; no docker or containerd here.
//
// For each repository: HEAD every listed tag with containerd's resolve Accept header (references.ts
// RESOLVE_ACCEPT) for its repo digest, then for each distinct digest GET the tag's document (an
// index or a manifest), the linux/amd64 manifest and the image config blob, each checked against
// its digest. Patch tags (nginx 1.29.x, …) are read from the minor tag's config Env. Then the
// repository's tags/list, the official image names, the error answers in references.ts
// ERROR_PROBES, and, for one representative image per family (references.ts FAMILIES), the layers:
// streamed, hashed, gunzipped and read as tar to list the entries of the standard PATH directories
// and of the config's own PATH, the entrypoint scripts, and for distroless images every executable.
//
// Docker Hub allows 100 manifest GETs per hour anonymously (ratelimit-limit: 100;w=3600; HEADs and
// blob downloads do not count). Documents are content-addressed, so a digest already in the
// committed catalog.json (or the run cache below) is not fetched again, nor are the layers of a representative whose config
// digest matches its files/<family>.json; --refetch fetches everything (about 70 counted GETs).
// --check re-resolves every tag, refetches tag lists, official names and errors, and reports the
// differences without writing (tags move to new digests over time: expected, rerun the capture).
//
// Outputs:
//   fixtures/reference/images/catalog.json          the capture (catalog.ts Catalog)
//   fixtures/reference/images/files/<family>.json   PATH entries and entrypoints of each representative
//   fixtures/reference/images/scripts/<family>/<path>  entrypoint scripts, verbatim
//   packages/k8s/src/runtime/images/catalog.data.ts  the engine's copy (pure data)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { repoRoot } from '../oracle/paths.ts';
import {
  type Catalog,
  type ErrorRecord,
  type FilesSummary,
  type Json,
  type OfficialImages,
  type RawImage,
  byCodeUnit,
  diffCatalogs,
  droppedLabels,
  envValue,
  isIndex,
  manifestParts,
  rawConfig,
  renderCatalogJson,
  renderModule,
  selectPlatformManifest,
  sortImages,
  sortedRecord,
} from './catalog.ts';
import { envPathDirs, executablesAndLinks, imageFiles, isScript, listedDirs, type ImageFiles, type ListOptions } from './files.ts';
import { FAMILIES, ERROR_PROBES, OFFICIAL_IMAGES_SOURCES, PLATFORM, REGISTRIES, REPOSITORIES, RESOLVE_ACCEPT, familyFor, keepTag, type RepositorySpec } from './references.ts';
import { getBlobJson, getManifest, headManifest, listTags, openBlob, openSession, probe, request, stats, type Head, type Session } from './registry.ts';
import { applyLayer, createTarParser, type Fs, type TarEntry } from './tar.ts';

const COMMAND = 'npm run images:capture';
const outDir = path.join(repoRoot, 'fixtures', 'reference', 'images');
const catalogFile = path.join(outDir, 'catalog.json');
const moduleFile = path.join(repoRoot, 'packages', 'k8s', 'src', 'runtime', 'images', 'catalog.data.ts');
// Records fetched by the last run (git-ignored), so a run that fails after the manifest GETs does
// not spend Docker Hub's hourly allowance again. Content-addressed, like catalog.json.
const cacheFile = path.join(repoRoot, '.upstream', 'images-capture-cache.json');

function fail(msg: string): never {
  console.error(`images:capture: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.error(`images:capture: ${msg}`);
}

// ----- images -----

async function fetchImage(s: Session, repository: string, head: Head): Promise<RawImage> {
  const digest = head.digest as string;
  const top = await getManifest(s, digest);
  if (top.mediaType !== head.mediaType || top.size !== head.size) fail(`${repository}@${digest}: GET answered ${top.mediaType} ${top.size}, HEAD ${head.mediaType} ${head.size}`);
  let manifest = top;
  if (isIndex(top.mediaType)) {
    const d = selectPlatformManifest(top.json, PLATFORM);
    manifest = await getManifest(s, d.digest);
    if (manifest.mediaType !== d.mediaType || manifest.size !== d.size) fail(`${repository}@${d.digest}: the index says ${d.mediaType} ${d.size}, the registry ${manifest.mediaType} ${manifest.size}`);
  }
  const parts = manifestParts(manifest.json);
  const blob = await getBlobJson(s, parts.config.digest);
  if (blob.size !== parts.config.size) fail(`${repository}: config ${parts.config.digest} is ${blob.size} bytes, the manifest says ${parts.config.size}`);
  const config = rawConfig(parts.config, blob.json);
  if (config.os !== PLATFORM.os || config.architecture !== PLATFORM.architecture) fail(`${repository}@${digest}: config is ${config.os}/${config.architecture}`);
  return {
    repository,
    tags: [],
    digest,
    ...(isIndex(top.mediaType) ? { index: { mediaType: top.mediaType, size: top.size } } : {}),
    manifest: { digest: manifest.digest, mediaType: manifest.mediaType, size: manifest.size },
    config,
    layers: parts.layers,
  };
}

interface RepoResult {
  references: [string, string][];
  missing: { reference: string; status: number }[];
  images: RawImage[];
  tags: string[];
}

async function captureRepository(spec: RepositorySpec, known: Map<string, RawImage>, refetch: boolean): Promise<RepoResult> {
  const repository = `${spec.registry}/${spec.path}`;
  const s = await openSession(spec.registry, spec.path);
  if (s.token !== undefined && s.token.status !== 200) fail(`${s.token.url}: HTTP ${s.token.status}`);
  const result: RepoResult = { references: [], missing: [], images: [], tags: [] };
  const byDigest = new Map<string, RawImage>();
  const resolve = async (tag: string): Promise<RawImage | undefined> => {
    const ref = `${repository}:${tag}`;
    const head = await headManifest(s, tag);
    if (head.status !== 200 || head.digest === undefined) {
      result.missing.push({ reference: ref, status: head.status });
      log(`${ref}: HTTP ${head.status}, dropped`);
      return undefined;
    }
    let im = byDigest.get(head.digest);
    if (im === undefined) {
      const prev = refetch ? undefined : known.get(`${repository}@${head.digest}`);
      im = prev !== undefined ? { ...structuredClone(prev), tags: [] } : await fetchImage(s, repository, head);
      byDigest.set(head.digest, im);
    }
    im.tags.push(tag);
    result.references.push([ref, head.digest]);
    return im;
  };
  for (const tag of spec.tags) await resolve(tag);
  for (const rule of spec.patchTags ?? []) {
    const from = [...byDigest.values()].find((im) => im.tags.includes(rule.from));
    const patch = from === undefined ? undefined : envValue(from.config, rule.env);
    if (patch === undefined) fail(`${repository}:${rule.from} has no ${rule.env} in its Env`);
    const extra = rule.minor === true ? [patch.split('.').slice(0, 2).join('.'), patch] : [patch];
    for (const t of extra) if (!spec.tags.includes(t) && ![...byDigest.values()].some((im) => im.tags.includes(t))) await resolve(t);
  }
  const captured = [...byDigest.values()].flatMap((im) => im.tags);
  result.tags = (await listTags(s)).filter((t) => keepTag(repository, t, captured)).sort(byCodeUnit);
  for (const t of captured) if (!result.tags.includes(t)) fail(`${repository}: tags/list lacks the resolved tag ${t}`);
  for (const im of byDigest.values()) {
    const fam = familyFor(repository, im.tags);
    if (fam !== undefined) im.family = fam.family;
    else delete im.family;
    result.images.push(im);
  }
  return result;
}

// ----- errors -----

async function captureErrors(): Promise<ErrorRecord[]> {
  const out: ErrorRecord[] = [];
  for (const p of ERROR_PROBES) {
    const s = await openSession(p.registry, p.path);
    const requests = [await probe(s, p.tag, 'HEAD'), await probe(s, p.tag, 'GET')];
    out.push({
      reference: p.reference,
      what: p.what,
      ...(s.token !== undefined ? { token: s.token } : {}),
      requests: requests.map((r, i) => ({ method: i === 0 ? 'HEAD' : 'GET', ...r })),
    });
  }
  return out;
}

// ----- official images -----

async function getJson(url: string): Promise<Json> {
  const res = await request(url, { headers: { Accept: 'application/json' } });
  if (res.status !== 200) fail(`${url}: HTTP ${res.status}`);
  return (await res.json()) as Json;
}

async function captureOfficialImages(): Promise<OfficialImages> {
  // Anonymous Hub API requests cannot page past the first 100 results ("pagination offset too
  // large for anonymous requests"): the first page in name order and in reverse name order cover
  // up to 200 names, and must add up to the reported count.
  const hub = new Set<string>();
  let count = 0;
  for (const ordering of ['name', '-name']) {
    const page = (await getJson(`${OFFICIAL_IMAGES_SOURCES.hub}&ordering=${ordering}`)) as { count: number; results: { name: string }[] };
    count = page.count;
    for (const r of page.results) hub.add(r.name);
  }
  if (hub.size !== count) fail(`Docker Hub lists ${count} library repositories, ${hub.size} could be read anonymously`);
  const hubNames = [...hub].sort(byCodeUnit);
  const gh = OFFICIAL_IMAGES_SOURCES.github;
  const commits = (await getJson(`https://api.github.com/repos/${gh.repository}/commits?path=${gh.path}&per_page=1`)) as { sha: string; commit: { committer: { date: string } } }[];
  const head = commits[0];
  if (head === undefined) fail(`${gh.repository}: no commits for ${gh.path}`);
  const listing = (await getJson(`https://api.github.com/repos/${gh.repository}/contents/${gh.path}?ref=${head.sha}`)) as { name: string; type: string }[];
  const ghNames = listing.filter((e) => e.type === 'file').map((e) => e.name);
  const names = [...new Set([...hubNames, ...ghNames])].sort(byCodeUnit);
  return {
    hub: { url: OFFICIAL_IMAGES_SOURCES.hub, count: hubNames.length },
    github: { repository: gh.repository, path: gh.path, commit: head.sha, date: head.commit.committer.date, count: ghNames.length },
    names,
    hubOnly: hubNames.filter((n) => !ghNames.includes(n)).sort(byCodeUnit),
  };
}

// ----- files -----

const GZIP_LAYERS = ['application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'];
const layerCache = new Map<string, TarEntry[]>();

async function layerEntries(s: Session, layer: { digest: string; mediaType: string; size: number }): Promise<TarEntry[]> {
  const cached = layerCache.get(layer.digest);
  if (cached !== undefined) return cached;
  if (!GZIP_LAYERS.includes(layer.mediaType) && layer.mediaType !== 'application/vnd.oci.image.layer.v1.tar') fail(`layer ${layer.digest}: unsupported media type ${layer.mediaType}`);
  const entries: TarEntry[] = [];
  const parser = createTarParser((e) => entries.push(e), isScript);
  const hash = createHash('sha256');
  let size = 0;
  const body = await openBlob(s, layer.digest);
  if (GZIP_LAYERS.includes(layer.mediaType)) {
    const gunzip = createGunzip();
    gunzip.on('data', (c: Buffer) => parser.push(new Uint8Array(c.buffer, c.byteOffset, c.length)));
    const done = new Promise<void>((resolve, reject) => {
      gunzip.on('end', resolve);
      gunzip.on('error', reject);
    });
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
      if (!gunzip.write(chunk)) await new Promise((r) => gunzip.once('drain', r));
    }
    gunzip.end();
    await done;
  } else {
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
      parser.push(chunk);
    }
  }
  parser.end();
  const digest = `sha256:${hash.digest('hex')}`;
  if (digest !== layer.digest || size !== layer.size) fail(`layer ${layer.digest}: downloaded ${size} bytes hashing to ${digest}`);
  layerCache.set(layer.digest, entries);
  return entries;
}

interface FamilyFile {
  family: string;
  reference: string;
  configDigest: string;
  layers: string[];
  /** What was listed: the directories (PATH_DIRS, then the config's own PATH) and whether every executable was. */
  listing: { dirs: string[]; allExecutables: boolean };
  dirs: ImageFiles['dirs'];
  files: ImageFiles['files'];
  scripts: string[];
}

function familyJsonPath(family: string): string {
  return path.join(outDir, 'files', `${family}.json`);
}

function scriptPath(family: string, p: string): string {
  return path.join(outDir, 'scripts', family, p.slice(1));
}

/** The committed listing of a family, when it is of this exact image and its scripts are on disk. */
function storedFamily(family: string, configDigest: string, listing: FamilyFile['listing']): { file: FamilyFile; scripts: Record<string, string> } | undefined {
  const p = familyJsonPath(family);
  if (!existsSync(p)) return undefined;
  const file = JSON.parse(readFileSync(p, 'utf8')) as FamilyFile;
  if (file.configDigest !== configDigest || JSON.stringify(file.listing) !== JSON.stringify(listing)) return undefined;
  const scripts: Record<string, string> = {};
  for (const sp of file.scripts) {
    const disk = scriptPath(family, sp);
    if (!existsSync(disk)) return undefined;
    scripts[sp] = readFileSync(disk, 'utf8');
  }
  return { file, scripts };
}

async function captureFamily(im: RawImage, family: string, reference: string, distroless: boolean, refetch: boolean): Promise<{ file: FamilyFile; scripts: Record<string, string> }> {
  const env = im.config.config['Env'];
  const opts: ListOptions = { envPath: envPathDirs(Array.isArray(env) ? env.filter((e): e is string => typeof e === 'string') : []), allExecutables: distroless };
  const listing = { dirs: listedDirs(opts), allExecutables: distroless };
  const stored = refetch ? undefined : storedFamily(family, im.config.digest, listing);
  if (stored !== undefined) return stored;
  const [registry, ...rest] = im.repository.split('/');
  const s = await openSession(registry as string, rest.join('/'));
  const fs: Fs = new Map();
  for (const layer of im.layers) applyLayer(fs, await layerEntries(s, layer));
  const f = imageFiles(fs, opts);
  log(`${reference}: ${im.layers.length} layers, ${fs.size} entries, ${f.files.length} recorded, scripts ${Object.keys(f.scripts).join(' ') || 'none'}`);
  return {
    file: { family, reference, configDigest: im.config.digest, layers: im.layers.map((l) => l.digest), listing, dirs: f.dirs, files: f.files, scripts: Object.keys(f.scripts) },
    scripts: f.scripts,
  };
}

// ----- main -----

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const refetch = process.argv.includes('--refetch');
  const stored = existsSync(catalogFile) ? (JSON.parse(readFileSync(catalogFile, 'utf8')) as Catalog) : undefined;
  if (check && stored === undefined) fail(`no ${path.relative(repoRoot, catalogFile)}; run ${COMMAND}`);
  const cached = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as RawImage[]) : [];
  const known = new Map([...cached, ...(stored?.images ?? [])].map((im) => [`${im.repository}@${im.digest}`, im]));

  const references: [string, string][] = [];
  const missing: { reference: string; status: number }[] = [];
  const images: RawImage[] = [];
  const repositoryTags: [string, string[]][] = [];
  for (const spec of REPOSITORIES) {
    const r = await captureRepository(spec, known, refetch);
    references.push(...r.references);
    missing.push(...r.missing);
    images.push(...r.images);
    repositoryTags.push([`${spec.registry}/${spec.path}`, r.tags]);
    log(`${spec.registry}/${spec.path}: ${r.references.length} tags, ${r.images.length} images, ${r.tags.length} tags listed`);
  }
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify([...known.values(), ...images]));
  const errors = await captureErrors();
  const officialImages = await captureOfficialImages();
  sortImages(images);

  const families: Catalog['families'] = [];
  const familyFiles: { file: FamilyFile; scripts: Record<string, string> }[] = [];
  const summaries: Record<string, FilesSummary> = {};
  for (const fam of FAMILIES) {
    const im = images.find((x) => x.repository === fam.repository && x.tags.includes(fam.tag));
    if (im === undefined) fail(`family ${fam.family}: ${fam.repository}:${fam.tag} was not captured`);
    const reference = `${fam.repository}:${fam.tag}`;
    const ff = await captureFamily(im, fam.family, reference, fam.distroless === true, refetch);
    families.push({ family: fam.family, reference, configDigest: im.config.digest });
    familyFiles.push(ff);
    summaries[im.config.digest] = executablesAndLinks({ dirs: ff.file.dirs, files: ff.file.files, scripts: ff.scripts });
  }

  const captured = check && stored !== undefined ? stored.header.captured : new Date().toISOString().slice(0, 10);
  const catalog: Catalog = {
    header: {
      producedBy: `${COMMAND} (tools/src/images/capture.ts): anonymous HTTPS queries with Node's fetch, documents checked against their digests`,
      captured,
      platform: `${PLATFORM.os}/${PLATFORM.architecture}`,
      accept: RESOLVE_ACCEPT,
      registries: REGISTRIES,
      notes: [
        'references: every tag resolved, with the Docker-Content-Digest of its document (HEAD /v2/<path>/manifests/<tag>)',
        'images: one per distinct digest; config.config keeps only User, Env, Entrypoint, Cmd, WorkingDir, ExposedPorts, StopSignal and Labels, verbatim',
        'missing: listed tags the registry does not have (HEAD status), dropped from the catalog',
        'errors: HEAD (what containerd sends) and GET answers for references that do not exist; volatile headers left out',
        'repositoryTags: tags/list, sorted; kube-* on registry.k8s.io keep only v1.3x.* and captured tags; cosign sha256-*.sig/.att/.sbom tags dropped',
        'families: images whose layers were listed (files/<family>.json); other images take their family representative\'s files (an approximation)',
      ],
    },
    references: sortedRecord(references),
    missing,
    images,
    errors,
    repositoryTags: Object.fromEntries(repositoryTags.sort((a, b) => byCodeUnit(a[0], b[0]))),
    officialImages,
    families,
  };

  const want = new Map<string, string>();
  want.set('catalog.json', renderCatalogJson(catalog));
  for (const ff of familyFiles) {
    want.set(path.relative(outDir, familyJsonPath(ff.file.family)), `${JSON.stringify(ff.file, null, 2)}\n`);
    for (const [p, text] of Object.entries(ff.scripts)) want.set(path.relative(outDir, scriptPath(ff.file.family, p)), text);
  }
  const moduleText = renderModule(catalog, summaries, COMMAND);

  log(`requests: ${[...stats.requests.entries()].map(([h, n]) => `${h} ${n}`).join(', ')}; Docker Hub pulls left this hour: ${stats.rateLimitRemaining ?? 'not reported'}`);
  const dropped = droppedLabels(images);
  if (dropped.length > 0) log(`labels left out of the engine's copy (too large): ${dropped.join(', ')}`);

  if (check) {
    const diffs = stored === undefined ? [] : diffCatalogs(stored, catalog);
    for (const d of diffs) console.error(`  ${d}`);
    let differ = diffs.length > 0;
    for (const [rel, text] of want) {
      const p = path.join(outDir, rel);
      const have = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
      if (have !== text) {
        differ = true;
        console.error(`${path.relative(repoRoot, p)}: ${have === undefined ? 'missing' : 'differs from a fresh capture'}`);
      }
    }
    for (const rel of walk(outDir)) {
      if (!want.has(rel)) {
        differ = true;
        console.error(`${path.relative(repoRoot, path.join(outDir, rel))}: not produced by a fresh capture`);
      }
    }
    const haveModule = existsSync(moduleFile) ? readFileSync(moduleFile, 'utf8') : undefined;
    if (haveModule !== moduleText) {
      differ = true;
      console.error(`${path.relative(repoRoot, moduleFile)}: ${haveModule === undefined ? 'missing' : 'differs from a fresh capture'}`);
    }
    if (differ) fail(`the committed capture is out of date; run ${COMMAND}`);
    console.log(`images:capture: ${want.size + 1} files match a fresh capture`);
    return;
  }
  rmSync(outDir, { recursive: true, force: true });
  for (const [rel, text] of want) {
    const p = path.join(outDir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  mkdirSync(path.dirname(moduleFile), { recursive: true });
  writeFileSync(moduleFile, moduleText);
  console.log(`images:capture: ${images.length} images, ${references.length} tags; wrote ${want.size} files to ${path.relative(repoRoot, outDir)} and ${path.relative(repoRoot, moduleFile)}`);
}

await main();
