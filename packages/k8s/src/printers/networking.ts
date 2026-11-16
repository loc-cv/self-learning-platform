// Printers of EndpointSlice (discovery.k8s.io), IPAddress and ServiceCIDR (networking.k8s.io)
// and Lease (coordination.k8s.io).
// upstream: pkg/printers/internalversion/printers.go printEndpointSlice (formatDiscoveryPorts,
// formatDiscoveryEndpoints, listWithMoreString), printIPAddress, printServiceCIDR, printLease.

import type { JsonObject } from '../apimachinery/json.ts';
import { age, lower, nameOf, num, obj, objs, row, str, strs, type GenerateOptions } from './helpers.ts';
import type { TableRow } from './types.ts';

function listWithMoreString(list: string[], more: boolean, count: number, max: number): string {
  const ret = list.join(',');
  if (more) return `${ret} + ${count - max} more...`;
  return ret === '' ? '<unset>' : ret;
}

/** formatDiscoveryPorts: up to three port numbers (a name when there is no number, else "*"). */
export function formatDiscoveryPorts(ports: JsonObject[]): string {
  const list: string[] = [];
  const max = 3;
  let more = false;
  let count = 0;
  for (const port of ports) {
    if (list.length < max) {
      let portNum = '*';
      if (port.port !== undefined && port.port !== null) portNum = String(num(port.port));
      else if (port.name !== undefined && port.name !== null) portNum = str(port.name);
      list.push(portNum);
    } else if (list.length === max) more = true;
    count++;
  }
  return listWithMoreString(list, more, count, max);
}

/** formatDiscoveryEndpoints: up to three addresses over all endpoints. */
export function formatDiscoveryEndpoints(endpoints: JsonObject[]): string {
  const list: string[] = [];
  const max = 3;
  let more = false;
  let count = 0;
  for (const ep of endpoints) {
    for (const address of strs(ep.addresses)) {
      if (list.length < max) list.push(address);
      else if (list.length === max) more = true;
      count++;
    }
  }
  return listWithMoreString(list, more, count, max);
}

export function printEndpointSlice(es: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(es, [nameOf(es), str(es.addressType), formatDiscoveryPorts(objs(es.ports)), formatDiscoveryEndpoints(objs(es.endpoints)), age(es, o)])];
}

export function printIPAddress(ip: JsonObject, o: GenerateOptions): TableRow[] {
  let parentRefName = '<none>';
  const ref = obj(ip.spec).parentRef;
  if (ref !== undefined && ref !== null) {
    const r = obj(ref);
    // schema.GroupResource.String(): resource, or resource.group.
    parentRefName = lower(str(r.group) === '' ? str(r.resource) : `${str(r.resource)}.${str(r.group)}`);
    if (str(r.namespace) !== '') parentRefName += `/${str(r.namespace)}`;
    parentRefName += `/${str(r.name)}`;
  }
  // Three cells for two column definitions: kubectl prints only as many cells as there are columns.
  return [row(ip, [nameOf(ip), parentRefName, age(ip, o)])];
}

export function printServiceCIDR(sc: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(sc, [nameOf(sc), strs(obj(sc.spec).cidrs).join(','), age(sc, o)])];
}

export function printLease(lease: JsonObject, o: GenerateOptions): TableRow[] {
  return [row(lease, [nameOf(lease), str(obj(lease.spec).holderIdentity), age(lease, o)])];
}
