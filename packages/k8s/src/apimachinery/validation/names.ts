// Name and value checks returning plain messages, as upstream's Is* functions do.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go (DNS names, ports,
// percent, env var names, config map keys: length messages say "characters") and
// staging/src/k8s.io/apimachinery/pkg/api/validate/content/{kube,dns,identifier,errors}.go
// (label keys and values, C identifiers: length messages say "bytes"). Go's len() counts bytes.

/** UTF-8 length, Go's len(string). */
export function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export function regexError(msg: string, re: string, ...examples: string[]): string {
  if (examples.length === 0) return `${msg} (regex used for validation is '${re}')`;
  let out = `${msg} (e.g. `;
  examples.forEach((ex, i) => {
    if (i > 0) out += ' or ';
    out += `'${ex}', `;
  });
  return `${out}regex used for validation is '${re}')`;
}

/** util/validation MaxLenError. */
export const maxLenError = (n: number): string => `must be no more than ${n} characters`;
/** api/validate/content MaxLenError. */
const maxLenBytes = (n: number): string => `must be no more than ${n} bytes`;
export const emptyError = (): string => 'must be non-empty';
export const inclusiveRangeError = (lo: number, hi: number): string => `must be between ${lo} and ${hi}, inclusive`;

const DNS1123_LABEL_FMT = '[a-z0-9]([-a-z0-9]*[a-z0-9])?';
const DNS1123_LABEL_MSG = "a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character";
const DNS1123_SUBDOMAIN_FMT = `${DNS1123_LABEL_FMT}(\\.${DNS1123_LABEL_FMT})*`;
const DNS1123_SUBDOMAIN_MSG = "a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character";
const DNS1035_LABEL_FMT = '[a-z]([-a-z0-9]*[a-z0-9])?';
const DNS1035_LABEL_MSG = "a DNS-1035 label must consist of lower case alphanumeric characters or '-', start with an alphabetic character, and end with an alphanumeric character";
const full = (fmt: string): RegExp => new RegExp(`^(?:${fmt})$`);
const dns1123Label = full(DNS1123_LABEL_FMT);
const dns1123Subdomain = full(DNS1123_SUBDOMAIN_FMT);
const dns1035Label = full(DNS1035_LABEL_FMT);

export function isDNS1123Label(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 63) errs.push(maxLenError(63));
  if (!dns1123Label.test(value)) {
    errs.push(dns1123Subdomain.test(value) ? 'must not contain dots' : regexError(DNS1123_LABEL_MSG, DNS1123_LABEL_FMT, 'my-name', '123-abc'));
  }
  return errs;
}

export function isDNS1123Subdomain(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 253) errs.push(maxLenError(253));
  if (!dns1123Subdomain.test(value)) errs.push(regexError(DNS1123_SUBDOMAIN_MSG, DNS1123_SUBDOMAIN_FMT, 'example.com'));
  return errs;
}

/** content.IsDNS1123Subdomain: the same check with byte-length wording (label key prefixes). */
function isDNS1123SubdomainContent(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 253) errs.push(maxLenBytes(253));
  if (!dns1123Subdomain.test(value)) errs.push(regexError(DNS1123_SUBDOMAIN_MSG, DNS1123_SUBDOMAIN_FMT, 'example.com'));
  return errs;
}

export function isDNS1035Label(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 63) errs.push(maxLenError(63));
  if (!dns1035Label.test(value)) errs.push(regexError(DNS1035_LABEL_MSG, DNS1035_LABEL_FMT, 'my-name', 'abc-123'));
  return errs;
}

const LABEL_KEY_FMT = '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]';
const LABEL_KEY_MSG = "must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character";
const labelKey = full(LABEL_KEY_FMT);

/** content.IsLabelKey, also IsQualifiedName. */
export function isQualifiedName(value: string): string[] {
  const errs: string[] = [];
  const parts = value.split('/');
  let name: string;
  if (parts.length === 1) name = parts[0] as string;
  else if (parts.length === 2) {
    const prefix = parts[0] as string;
    name = parts[1] as string;
    if (prefix.length === 0) errs.push(`prefix part ${emptyError()}`);
    else for (const m of isDNS1123SubdomainContent(prefix)) errs.push(`prefix part ${m}`);
  } else {
    return [`a valid label key ${regexError(LABEL_KEY_MSG, LABEL_KEY_FMT, 'MyName', 'my.name', '123-abc')} with an optional DNS subdomain prefix and '/' (e.g. 'example.com/MyName')`];
  }
  if (name.length === 0) errs.push(`name part ${emptyError()}`);
  else if (byteLength(name) > 63) errs.push(`name part ${maxLenBytes(63)}`);
  if (!labelKey.test(name)) errs.push(`name part ${regexError(LABEL_KEY_MSG, LABEL_KEY_FMT, 'MyName', 'my.name', '123-abc')}`);
  return errs;
}

const LABEL_VALUE_FMT = `(${LABEL_KEY_FMT})?`;
const LABEL_VALUE_MSG = "a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character";
const labelValue = full(LABEL_VALUE_FMT);

export function isValidLabelValue(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 63) errs.push(maxLenBytes(63));
  if (!labelValue.test(value)) errs.push(regexError(LABEL_VALUE_MSG, LABEL_VALUE_FMT, 'MyValue', 'my_value', '12345'));
  return errs;
}

const C_IDENTIFIER_FMT = '[A-Za-z_][A-Za-z0-9_]*';
export function isCIdentifier(value: string): string[] {
  if (full(C_IDENTIFIER_FMT).test(value)) return [];
  return [regexError("a valid C identifier must start with alphabetic character or '_', followed by a string of alphanumeric characters or '_'", C_IDENTIFIER_FMT, 'my_name', 'MY_NAME', 'MyName')];
}

export function isValidPortNum(port: number): string[] {
  return port >= 1 && port <= 65535 ? [] : [inclusiveRangeError(1, 65535)];
}

export function isInRange(value: number, min: number, max: number): string[] {
  return value >= min && value <= max ? [] : [inclusiveRangeError(min, max)];
}

export function isValidPortName(port: string): string[] {
  const errs: string[] = [];
  if (byteLength(port) > 15) errs.push(maxLenError(15));
  if (!/^[-a-z0-9]+$/.test(port)) errs.push('must contain only alpha-numeric characters (a-z, 0-9), and hyphens (-)');
  if (!/[a-z]/.test(port)) errs.push('must contain at least one letter (a-z)');
  if (port.includes('--')) errs.push('must not contain consecutive hyphens');
  if (port.length > 0 && (port.startsWith('-') || port.endsWith('-'))) errs.push('must not begin or end with a hyphen');
  return errs;
}

export function isValidPercent(percent: string): string[] {
  return /^[0-9]+%$/.test(percent) ? [] : [regexError("a valid percent string must be a numeric string followed by an ending '%'", '[0-9]+%', '1%', '93%')];
}

function hasChDirPrefix(value: string): string[] {
  if (value === '.') return ["must not be '.'"];
  if (value === '..') return ["must not be '..'"];
  if (value.startsWith('..')) return ["must not start with '..'"];
  return [];
}

const ENV_VAR_FMT = '[-._a-zA-Z][-._a-zA-Z0-9]*';
export function isEnvVarName(value: string): string[] {
  const errs: string[] = [];
  if (!full(ENV_VAR_FMT).test(value)) errs.push(regexError("a valid environment variable name must consist of alphabetic characters, digits, '_', '-', or '.', and must not start with a digit", ENV_VAR_FMT, 'my.env-name', 'MY_ENV.NAME', 'MyEnvName1'));
  return [...errs, ...hasChDirPrefix(value)];
}

/** IsRelaxedEnvVarName: printable ASCII other than '='. */
export function isRelaxedEnvVarName(value: string): string[] {
  const errs: string[] = [];
  if (value.length === 0) errs.push(`environment variable name ${emptyError()}`);
  for (const ch of value) {
    const c = ch.codePointAt(0) as number;
    if (c > 0x7f || c < 0x20 || c === 0x7f || ch === '=') {
      errs.push("a valid environment variable name must consist only of printable ASCII characters other than '='");
      break;
    }
  }
  return errs;
}

const CONFIG_MAP_KEY_FMT = '[-._a-zA-Z0-9]+';
export function isConfigMapKey(value: string): string[] {
  const errs: string[] = [];
  if (byteLength(value) > 253) errs.push(maxLenError(253));
  if (!full(CONFIG_MAP_KEY_FMT).test(value)) errs.push(regexError("a valid config key must consist of alphanumeric characters, '-', '_' or '.'", CONFIG_MAP_KEY_FMT, 'key.name', 'KEY_NAME', 'key-name'));
  return [...errs, ...hasChDirPrefix(value)];
}

/** A name validation function: upstream's ValidateNameFunc(name, prefix). */
export type NameFn = (name: string, prefix: boolean) => string[];

/** upstream: apimachinery/pkg/api/validation/generic.go maskTrailingDash */
export function maskTrailingDash(name: string): string {
  return name.length > 1 && name.endsWith('-') ? `${name.slice(0, -2)}a` : name;
}

export const nameIsDNSSubdomain: NameFn = (name, prefix) => isDNS1123Subdomain(prefix ? maskTrailingDash(name) : name);
export const nameIsDNSLabel: NameFn = (name, prefix) => isDNS1123Label(prefix ? maskTrailingDash(name) : name);
export const nameIsDNS1035Label: NameFn = (name, prefix) => isDNS1035Label(prefix ? maskTrailingDash(name) : name);

/** upstream: apimachinery/pkg/api/validate/content/path.go IsPathSegmentPrefix */
export function isPathSegmentPrefix(name: string): string[] {
  const errs: string[] = [];
  if (name.includes('/')) errs.push("may not contain '/'");
  if (name.includes('%')) errs.push("may not contain '%'");
  return errs;
}

/** upstream: apimachinery/pkg/api/validate/content/path.go IsPathSegmentName */
export function isValidPathSegmentName(name: string): string[] {
  if (name === '.') return ["may not be '.'"];
  if (name === '..') return ["may not be '..'"];
  return isPathSegmentPrefix(name);
}
