// Secret defaulting and the v1 ↔ internal conversion that folds stringData into data.
// upstream: pkg/apis/core/v1/defaults.go SetDefaults_Secret (zz_generated.defaults.go
// SetObjectDefaults_Secret runs only it); pkg/apis/core/v1/conversion.go
// Convert_v1_Secret_To_core_Secret ("StringData overwrites Data": each value as its UTF-8
// bytes). The internal Secret has no stringData, so the object written back has none; Go
// encodes the data map with its keys sorted.

import { isObject, type JsonObject } from '../../../../apimachinery/json.ts';
import { encodeBase64, utf8Bytes } from '../../../../apimachinery/base64.ts';

/** SetObjectDefaults_Secret. */
export function setObjectDefaultsSecret(secret: JsonObject): void {
  if (typeof secret.type !== 'string' || secret.type === '') secret.type = 'Opaque';
}

/** Convert_v1_Secret_To_core_Secret, then back to v1: stringData merged into data and dropped. */
export function convertSecretStringData(secret: JsonObject): void {
  const stringData = isObject(secret.stringData) ? secret.stringData : {};
  delete secret.stringData;
  const keys = Object.keys(stringData);
  if (keys.length === 0) return;
  const data: JsonObject = isObject(secret.data) ? { ...secret.data } : {};
  for (const k of keys) {
    const v = stringData[k];
    data[k] = encodeBase64(utf8Bytes(typeof v === 'string' ? v : ''));
  }
  const sortedData: JsonObject = {};
  for (const k of Object.keys(data).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) sortedData[k] = data[k] as string;
  secret.data = sortedData;
}
