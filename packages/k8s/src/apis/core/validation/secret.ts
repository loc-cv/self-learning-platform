// Secret validation.
// upstream: pkg/apis/core/validation/validation.go ValidateSecret, ValidateSecretUpdate,
// ValidateSecretName (NameIsDNSSubdomain); key names and types from pkg/apis/core/types.go
// (SecretType*, DockerConfigKey, BasicAuth*Key, SSHAuthPrivateKey, TLSCertKey,
// TLSPrivateKeyKey, ServiceAccountNameKey, MaxSecretSize). Go iterates the data map in random
// order; this port goes in key order (D-040).

import { decodeBase64, decodedLength } from '../../../apimachinery/base64.ts';
import { forbidden, invalid, newPath, required, tooLong, type FieldError } from '../../../apimachinery/field.ts';
import { unmarshalMapError } from '../../../apimachinery/gojsonsyntax.ts';
import { isObject, jsonEqual, type JsonObject } from '../../../apimachinery/json.ts';
import { validateImmutableField } from '../../../apimachinery/validation/objectmeta.ts';
import { isConfigMapKey, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { MAX_SECRET_SIZE } from './configmap.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';

export const SECRET_TYPE_OPAQUE = 'Opaque';
export const SECRET_TYPE_SERVICE_ACCOUNT_TOKEN = 'kubernetes.io/service-account-token';
export const SECRET_TYPE_DOCKERCFG = 'kubernetes.io/dockercfg';
export const SECRET_TYPE_DOCKER_CONFIG_JSON = 'kubernetes.io/dockerconfigjson';
export const SECRET_TYPE_BASIC_AUTH = 'kubernetes.io/basic-auth';
export const SECRET_TYPE_SSH_AUTH = 'kubernetes.io/ssh-auth';
export const SECRET_TYPE_TLS = 'kubernetes.io/tls';

export const SERVICE_ACCOUNT_NAME_KEY = 'kubernetes.io/service-account.name';
export const DOCKER_CONFIG_KEY = '.dockercfg';
export const DOCKER_CONFIG_JSON_KEY = '.dockerconfigjson';
export const BASIC_AUTH_USERNAME_KEY = 'username';
export const BASIC_AUTH_PASSWORD_KEY = 'password';
export const SSH_AUTH_PRIVATE_KEY = 'ssh-privatekey';
export const TLS_CERT_KEY = 'tls.crt';
export const TLS_PRIVATE_KEY_KEY = 'tls.key';

/** Shown instead of the bytes in errors about secret contents. */
const REDACTED = '<secret contents redacted>';

const sorted = (o: JsonObject): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function validateSecret(secret: JsonObject): FieldError[] {
  const meta = isObject(secret.metadata) ? secret.metadata : {};
  const errs = validateObjectMeta(meta, true, nameIsDNSSubdomain, newPath('metadata'));
  const dataPath = newPath('data');
  const data = isObject(secret.data) ? secret.data : {};
  let total = 0;
  for (const key of sorted(data)) {
    for (const m of isConfigMapKey(key)) errs.push(invalid(dataPath.key(key), key, m));
    total += decodedLength(str(data[key]));
  }
  if (total > MAX_SECRET_SIZE) errs.push(tooLong(dataPath, MAX_SECRET_SIZE));

  const has = (k: string): boolean => k in data;
  switch (str(secret.type)) {
    case SECRET_TYPE_SERVICE_ACCOUNT_TOKEN: {
      const annotations = isObject(meta.annotations) ? meta.annotations : {};
      if (str(annotations[SERVICE_ACCOUNT_NAME_KEY]) === '') errs.push(required(newPath('metadata', 'annotations').key(SERVICE_ACCOUNT_NAME_KEY), ''));
      break;
    }
    case SECRET_TYPE_OPAQUE:
    case '':
      break;
    case SECRET_TYPE_DOCKERCFG:
    case SECRET_TYPE_DOCKER_CONFIG_JSON: {
      const key = str(secret.type) === SECRET_TYPE_DOCKERCFG ? DOCKER_CONFIG_KEY : DOCKER_CONFIG_JSON_KEY;
      if (!has(key)) {
        errs.push(required(dataPath.key(key), ''));
        break;
      }
      const err = unmarshalMapError(decodeBase64(str(data[key])) ?? '');
      if (err !== undefined) errs.push(invalid(dataPath.key(key), REDACTED, err));
      break;
    }
    case SECRET_TYPE_BASIC_AUTH:
      // Username or password may be empty, but one of the keys must be there.
      if (!has(BASIC_AUTH_USERNAME_KEY) && !has(BASIC_AUTH_PASSWORD_KEY)) {
        errs.push(required(dataPath.key(BASIC_AUTH_USERNAME_KEY), ''));
        errs.push(required(dataPath.key(BASIC_AUTH_PASSWORD_KEY), ''));
      }
      break;
    case SECRET_TYPE_SSH_AUTH:
      if (decodedLength(str(data[SSH_AUTH_PRIVATE_KEY])) === 0) errs.push(required(dataPath.key(SSH_AUTH_PRIVATE_KEY), ''));
      break;
    case SECRET_TYPE_TLS:
      if (!has(TLS_CERT_KEY)) errs.push(required(dataPath.key(TLS_CERT_KEY), ''));
      if (!has(TLS_PRIVATE_KEY_KEY)) errs.push(required(dataPath.key(TLS_PRIVATE_KEY_KEY), ''));
      break;
    default:
  }
  return errs;
}

export function validateSecretUpdate(secret: JsonObject, old: JsonObject): FieldError[] {
  const errs = validateObjectMetaUpdate(secret.metadata as JsonObject, old.metadata as JsonObject, newPath('metadata'));
  errs.push(...validateImmutableField(str(secret.type), str(old.type), newPath('type')));
  if (old.immutable === true) {
    if (secret.immutable !== true) errs.push(forbidden(newPath('immutable'), 'field is immutable when `immutable` is set'));
    // reflect.DeepEqual of two maps: a nil map differs from an empty one, but both encode the same.
    if (!jsonEqual(secret.data ?? null, old.data ?? null)) errs.push(forbidden(newPath('data'), 'field is immutable when `immutable` is set'));
  }
  return [...errs, ...validateSecret(secret)];
}
