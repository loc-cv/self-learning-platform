// Endpoints defaulting.
// upstream: pkg/apis/core/v1/defaults.go SetDefaults_Endpoints (zz_generated.defaults.go
// SetObjectDefaults_Endpoints runs only it): every port's protocol defaults to TCP.

import { isObject, type JsonObject } from '../../../../apimachinery/json.ts';

/** SetObjectDefaults_Endpoints. */
export function setObjectDefaultsEndpoints(ep: JsonObject): void {
  const subsets = Array.isArray(ep.subsets) ? ep.subsets : [];
  for (const ss of subsets) {
    if (!isObject(ss) || !Array.isArray(ss.ports)) continue;
    for (const p of ss.ports) {
      if (isObject(p) && (typeof p.protocol !== 'string' || p.protocol === '')) p.protocol = 'TCP';
    }
  }
}
