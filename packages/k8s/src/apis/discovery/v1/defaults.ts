// EndpointSlice defaulting.
// upstream: pkg/apis/discovery/v1/defaults.go SetDefaults_EndpointPort (name "" and protocol TCP
// when absent); zz_generated.defaults.go SetObjectDefaults_EndpointSlice runs it on every port.

import { isObject, type JsonObject } from '../../../apimachinery/json.ts';

/** SetObjectDefaults_EndpointSlice. */
export function setObjectDefaultsEndpointSlice(eps: JsonObject): void {
  const ports = Array.isArray(eps.ports) ? eps.ports : [];
  for (const p of ports) {
    if (!isObject(p)) continue;
    if (p.name === undefined || p.name === null) p.name = '';
    if (p.protocol === undefined || p.protocol === null) p.protocol = 'TCP';
  }
}
