// Endpoints. upstream: pkg/registry/core/endpoint/strategy.go (namespaced; PrepareForCreate and
// PrepareForUpdate do nothing; create on update and unconditional update allowed;
// endpointsWarnings: GetWarningsForIP of every address unless the endpoints controller manages
// the object), pkg/registry/core/endpoint/storage/storage.go (Status on delete, field labels by
// the default conversion).
// v1 Endpoints is deprecated (staging/src/k8s.io/api/core/v1/lifecycle.go: 1.33, replacement
// discovery.k8s.io/v1 EndpointSlice): the installer adds the warning to every request on the
// resource (staging/src/k8s.io/apiserver/pkg/endpoints/installer.go, deprecation.WarningMessage).
// Here it is added to creates and updates only; get, list, delete and failed requests lack it
// until the pipeline carries per-resource warnings.

import type { JsonObject } from '../../apimachinery/json.ts';
import { newPath } from '../../apimachinery/field.ts';
import { getWarningsForIP } from '../../apimachinery/validation/ip.ts';
import type { Strategy } from '../../apiserver/types.ts';
import { setObjectDefaultsEndpoints } from '../../apis/core/v1/defaults/endpoints.ts';
import { validateEndpointsCreate, validateEndpointsUpdate } from '../../apis/core/validation/endpoints.ts';
import { objs, str, strMap } from '../../apis/core/validation/util.ts';
import { defaultFieldLabel, objectMetaFields } from '../meta.ts';

export const ENDPOINTS_DEPRECATION_WARNING = 'v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice';

/** endpointscontroller.LabelManagedBy and ControllerName (pkg/controller/endpoint/endpoints_controller.go). */
const LABEL_MANAGED_BY = 'endpoints.kubernetes.io/managed-by';
const CONTROLLER_NAME = 'endpoint-controller';

function endpointsWarnings(ep: JsonObject): string[] {
  const labels = strMap((ep.metadata as JsonObject | undefined)?.labels);
  if (labels[LABEL_MANAGED_BY] === CONTROLLER_NAME) return [];
  const w: string[] = [];
  objs(ep.subsets).forEach((ss, i) => {
    objs(ss.addresses).forEach((a, j) => w.push(...getWarningsForIP(newPath('subsets').index(i).child('addresses').index(j).child('ip'), str(a.ip))));
    objs(ss.notReadyAddresses).forEach((a, j) => w.push(...getWarningsForIP(newPath('subsets').index(i).child('notReadyAddresses').index(j).child('ip'), str(a.ip))));
  });
  return w;
}

export const endpointsStrategy: Strategy = {
  group: '',
  resource: 'endpoints',
  kind: 'Endpoints',
  storage: 'endpoints',
  storageVersion: 'v1',
  defaults: (obj) => setObjectDefaultsEndpoints(obj),
  validate: (obj) => validateEndpointsCreate(obj),
  validateUpdate: (obj, old) => validateEndpointsUpdate(obj, old),
  deprecationWarning: ENDPOINTS_DEPRECATION_WARNING,
  warningsOnCreate: (obj) => endpointsWarnings(obj),
  warningsOnUpdate: (obj) => endpointsWarnings(obj),
  allowCreateOnUpdate: true,
  allowUnconditionalUpdate: true,
  fields: (o) => objectMetaFields(o, true),
  convertFieldLabel: defaultFieldLabel,
};
