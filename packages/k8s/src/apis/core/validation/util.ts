// Small helpers shared by the Pod validation files: typed reads of the versioned JSON (absent means
// the Go zero value, see apiserver/pipeline.ts), the core group's name checks, path checks.
// upstream: pkg/apis/core/validation/validation.go ValidateDNS1123Label, ValidateQualifiedName,
// ValidateDNS1123Subdomain, ValidateDNS1123SubdomainWithUnderScore, validateLocalDescendingPath,
// validatePathNoBacksteps, ValidateLocalNonReservedPath, validateUserField;
// staging/src/k8s.io/apimachinery/pkg/util/validation/validation.go IsValidUserID, IsValidGroupID,
// IsDNS1123SubdomainWithUnderscore, IsHTTPHeaderName.

import { invalid, type FieldError, type Path } from '../../../apimachinery/field.ts';
import { isObject, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { byteLength, inclusiveRangeError, isDNS1123Label, isDNS1123Subdomain, isQualifiedName, maxLenError, regexError } from '../../../apimachinery/validation/names.ts';

export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
export const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
export const obj = (v: Json | undefined): JsonObject | undefined => (isObject(v) ? v : undefined);
export const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
export const objs = (v: Json | undefined): JsonObject[] => arr(v).map((x) => (isObject(x) ? x : {}));
export const strs = (v: Json | undefined): string[] => arr(v).map(str);
export const strMap = (v: Json | undefined): Record<string, string> => (isObject(v) ? (v as Record<string, string>) : {});
/** A pointer field: present (non-null) in the JSON. */
export const isSet = (v: Json | undefined): boolean => v !== undefined && v !== null;
/** Go's sort order of strings (byte order for ASCII, which is what keys are). */
export const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
export const sortStrings = (xs: readonly string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function validateDNS1123Label(value: string, path: Path): FieldError[] {
  return isDNS1123Label(value).map((m) => invalid(path, value, m));
}

export function validateDNS1123Subdomain(value: string, path: Path): FieldError[] {
  return isDNS1123Subdomain(value).map((m) => invalid(path, value, m));
}

export function validateQualifiedName(value: string, path: Path): FieldError[] {
  return isQualifiedName(value).map((m) => invalid(path, value, m));
}

const DNS1123_LABEL_FMT_US = '_?[a-z0-9]([-_a-z0-9]*[a-z0-9])?';
const DNS1123_SUBDOMAIN_FMT_US = `${DNS1123_LABEL_FMT_US}(\\.${DNS1123_LABEL_FMT_US})*`;
const dns1123SubdomainUS = new RegExp(`^(?:${DNS1123_SUBDOMAIN_FMT_US})$`);

export function validateDNS1123SubdomainWithUnderScore(value: string, path: Path): FieldError[] {
  const msgs: string[] = [];
  if (byteLength(value) > 253) msgs.push(maxLenError(253));
  if (!dns1123SubdomainUS.test(value)) {
    msgs.push(regexError("a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '_', '-' or '.', and must start and end with an alphanumeric character", DNS1123_SUBDOMAIN_FMT_US, 'example.com'));
  }
  return msgs.map((m) => invalid(path, value, m));
}

const MAX_INT32 = 2147483647;
export const isValidUserID = (uid: number): string[] => (uid >= 0 && uid <= MAX_INT32 ? [] : [inclusiveRangeError(0, MAX_INT32)]);
export const isValidGroupID = (gid: number): string[] => (gid >= 0 && gid <= MAX_INT32 ? [] : [inclusiveRangeError(0, MAX_INT32)]);

export function validateUserField(user: Json | undefined, path: Path): FieldError[] {
  if (typeof user !== 'number') return [];
  return isValidUserID(user).map((m) => invalid(path, user, m));
}

export function isHTTPHeaderName(value: string): string[] {
  if (/^[-A-Za-z0-9]+$/.test(value)) return [];
  return [regexError("a valid HTTP header must consist of alphanumeric characters or '-'", '[-A-Za-z0-9]+', 'X-Header-Name')];
}

/** validatePathNoBacksteps: no `..` element (one error is enough). */
export function validatePathNoBacksteps(target: string, path: Path): FieldError[] {
  // filepath.ToSlash is the identity on Linux.
  return target.split('/').includes('..') ? [invalid(path, target, "must not contain '..'")] : [];
}

/** validateLocalDescendingPath: relative, and no `..` element. */
export function validateLocalDescendingPath(target: string, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (target.startsWith('/')) errs.push(invalid(path, target, 'must be a relative path'));
  errs.push(...validatePathNoBacksteps(target, path));
  return errs;
}

/** ValidateLocalNonReservedPath: also no leading `..` (unless the `..` element check caught it). */
export function validateLocalNonReservedPath(target: string, path: Path): FieldError[] {
  const errs = validateLocalDescendingPath(target, path);
  if (target.startsWith('..') && !target.startsWith('../')) errs.push(invalid(path, target, "must not start with '..'"));
  return errs;
}

export const FILE_MODE_ERROR = 'must be a number between 0 and 0777 (octal), both inclusive';
export const EMPTY_DIR_MODE_ERROR = 'must be a number between 0 and 01777 (octal), both inclusive';
export const IS_NEGATIVE_ERROR = 'must be greater than or equal to 0';

/** strings.TrimSpace: Go's unicode.IsSpace set (U+FEFF is not a space to Go). */
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'gu');
export const goTrimSpace = (s: string): string => s.replace(GO_TRIM, '');
