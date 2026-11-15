// ConfigMap. upstream: pkg/registry/core/configmap/strategy.go (namespaced, no status, create on
// update not allowed, unconditional update allowed, PrepareForCreate/Update only drop disabled
// fields), pkg/registry/core/configmap/storage/storage.go (Status on delete).

import type { Strategy } from '../../apiserver/types.ts';
import { validateConfigMap, validateConfigMapUpdate } from '../../apis/core/validation/configmap.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

export const configMapStrategy: Strategy = {
  group: '',
  resource: 'configmaps',
  kind: 'ConfigMap',
  storage: 'configmaps',
  storageVersion: 'v1',
  validate: (obj) => validateConfigMap(obj),
  validateUpdate: (obj, old) => validateConfigMapUpdate(obj, old),
  allowCreateOnUpdate: false,
  allowUnconditionalUpdate: true,
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
};
