// Secret. upstream: pkg/registry/core/secret/strategy.go (namespaced, no status, create on
// update not allowed, unconditional update allowed; PrepareForUpdate keeps the old type when
// the new one is empty; warningsForSecret: the tls.X509KeyPair error of a kubernetes.io/tls
// Secret; SelectableFields adds `type`), pkg/registry/core/secret/storage/storage.go (Status on
// delete), pkg/apis/core/v1/conversion.go (field labels: metadata.name, metadata.namespace, type).

import { decodeBase64 } from '../../apimachinery/base64.ts';
import { isObject, type JsonObject } from '../../apimachinery/json.ts';
import { x509KeyPairPem } from '../../apimachinery/pem.ts';
import { convertSecretStringData, setObjectDefaultsSecret } from '../../apis/core/v1/defaults/secret.ts';
import { SECRET_TYPE_TLS, TLS_CERT_KEY, TLS_PRIVATE_KEY_KEY, validateSecret, validateSecretUpdate } from '../../apis/core/validation/secret.ts';
import type { Strategy, StrategyCtx } from '../../apiserver/types.ts';
import { objectMetaFields } from '../meta.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** warningsForSecret. */
function warningsForSecret(secret: JsonObject, s: StrategyCtx): string[] {
  if (str(secret.type) !== SECRET_TYPE_TLS) return [];
  const data = isObject(secret.data) ? secret.data : {};
  const bytes = (k: string): string => decodeBase64(str(data[k])) ?? '';
  const r = x509KeyPairPem(bytes(TLS_CERT_KEY), bytes(TLS_PRIVATE_KEY_KEY));
  if ('error' in r) return [r.error];
  // Both inputs hold PEM blocks of the right types: the real server goes on to parse the
  // certificate and key (x509.ParseCertificate, parsePrivateKey) and to compare their public
  // keys, any failure becoming a warning. That part is not simulated.
  s.notPorted('the certificate and key checks of a kubernetes.io/tls Secret (warnings of tls.X509KeyPair)');
  return [];
}

export const secretStrategy: Strategy = {
  group: '',
  resource: 'secrets',
  kind: 'Secret',
  storage: 'secrets',
  storageVersion: 'v1',
  defaults(obj) {
    setObjectDefaultsSecret(obj);
    convertSecretStringData(obj);
  },
  prepareForUpdate(obj, old) {
    if (str(obj.type) === '') obj.type = old.type ?? '';
  },
  validate: (obj) => validateSecret(obj),
  validateUpdate: (obj, old) => validateSecretUpdate(obj, old),
  warningsOnCreate: (obj, s) => warningsForSecret(obj, s),
  warningsOnUpdate: (obj, _old, s) => warningsForSecret(obj, s),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields: (o) => ({ ...objectMetaFields(o, true), type: str(o.type) }),
  convertFieldLabel(label, value) {
    // upstream: pkg/apis/core/v1/conversion.go AddFieldLabelConversionsForSecret.
    if (label === 'metadata.name' || label === 'metadata.namespace' || label === 'type') return { label, value };
    return { error: `field label not supported: ${label}` };
  },
};
