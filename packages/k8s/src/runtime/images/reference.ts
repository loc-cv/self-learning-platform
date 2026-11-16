// Image references as the kubelet parses them: github.com/distribution/reference's
// ParseNormalizedNamed (Docker Hub's `docker.io/library/` normalization, the grammar and its
// errors), wrapped by pkg/util/parsers ParseImageName, which adds the default tag `latest`.
//
// upstream: vendor/github.com/distribution/reference/normalize.go ParseNormalizedNamed,
// splitDockerDomain; reference.go Parse and its errors; regexp.go (the grammar);
// pkg/util/parsers/parsers.go ParseImageName ("couldn't parse image name %q: %v").

const ALNUM = '[a-z0-9]+';
const SEPARATOR = '(?:[._]|__|[-]+)';
const PATH_COMPONENT = `${ALNUM}(?:${SEPARATOR}${ALNUM})*`;
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN_NAME = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*`;
const HOST = `(?:${DOMAIN_NAME}|\\[(?:[a-fA-F0-9:]+)\\])`;
const DOMAIN_AND_PORT = `${HOST}(?::[0-9]+)?`;
const REMOTE_NAME = `${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;
const NAME = `(?:${DOMAIN_AND_PORT}/)?${REMOTE_NAME}`;
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST = '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*[:][0-9a-fA-F]{32,}';
const REFERENCE = new RegExp(`^(${NAME})(?::(${TAG}))?(?:@(${DIGEST}))?$`);
const ANCHORED_NAME = new RegExp(`^(?:(${DOMAIN_AND_PORT})/)?(${REMOTE_NAME})$`);
const IDENTIFIER = /^[a-f0-9]{64}$/;

const DEFAULT_DOMAIN = 'docker.io';
const LEGACY_DEFAULT_DOMAIN = 'index.docker.io';
const OFFICIAL_REPO_PREFIX = 'library/';
/** reference.go RepositoryNameTotalLengthMax. */
const NAME_TOTAL_LENGTH_MAX = 255;

export interface ImageName {
  /** `docker.io` */
  domain: string;
  /** `library/nginx` */
  path: string;
  /** `docker.io/library/nginx` */
  repository: string;
  tag?: string;
  digest?: string;
}

function splitDockerDomain(name: string): [string, string] {
  const slash = name.indexOf('/');
  if (slash < 0) return [DEFAULT_DOMAIN, OFFICIAL_REPO_PREFIX + name];
  const maybeDomain = name.slice(0, slash);
  const rest = name.slice(slash + 1);
  if (maybeDomain === 'localhost') return [maybeDomain, rest];
  if (maybeDomain === LEGACY_DEFAULT_DOMAIN) return [DEFAULT_DOMAIN, rest];
  if (/[.:]/.test(maybeDomain)) return [maybeDomain, rest];
  if (maybeDomain.toLowerCase() !== maybeDomain) return [maybeDomain, rest];
  return [DEFAULT_DOMAIN, name];
}

/** ParseNormalizedNamed. Returns the parsed name or the library's error text. */
export function parseNormalizedNamed(s: string): ImageName | { error: string } {
  if (IDENTIFIER.test(s)) return { error: `invalid repository name (${s}), cannot specify 64-byte hexadecimal strings` };
  const [domain, remainder] = splitDockerDomain(s);
  const colon = remainder.indexOf(':');
  const remote = colon > -1 ? remainder.slice(0, colon) : remainder;
  if (remote.toLowerCase() !== remote) return { error: `invalid reference format: repository name (${remote}) must be lowercase` };
  const full = `${domain}/${remainder}`;
  const m = REFERENCE.exec(full);
  if (!m) {
    if (full === '') return { error: 'repository name must have at least one component' };
    if (REFERENCE.test(full.toLowerCase())) return { error: 'repository name must be lowercase' };
    return { error: 'invalid reference format' };
  }
  const nm = ANCHORED_NAME.exec(m[1] as string);
  const d = nm?.[1] ?? '';
  const path = nm?.[2] ?? (m[1] as string);
  if (path.length > NAME_TOTAL_LENGTH_MAX) return { error: `repository name must not be more than ${NAME_TOTAL_LENGTH_MAX} characters` };
  return { domain: d, path, repository: d ? `${d}/${path}` : path, ...(m[2] ? { tag: m[2] } : {}), ...(m[3] ? { digest: m[3] } : {}) };
}

/** ParseImageName: repository, tag (default `latest` when neither tag nor digest) and digest. */
export function parseImageName(image: string): ImageName | { error: string } {
  const r = parseNormalizedNamed(image);
  if ('error' in r) return { error: `couldn't parse image name ${goQuote(image)}: ${r.error}` };
  if (r.tag === undefined && r.digest === undefined) return { ...r, tag: 'latest' };
  return r;
}

/** The reference the kubelet hands the CRI (applyDefaultImageTag): `docker.io/library/nginx:latest`. */
export function imageReference(n: ImageName): string {
  return `${n.repository}${n.tag !== undefined ? `:${n.tag}` : ''}${n.digest !== undefined ? `@${n.digest}` : ''}`;
}

/** Go's %q for the strings image names can hold. */
export function goQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}
