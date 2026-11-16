// describe service.
//   upstream: staging/src/k8s.io/kubectl/pkg/describe/describe.go describeService,
//             buildIngressString, formatEndpointSlices (at most three endpoints, then "+ N more...";
//             not-ready endpoints left out), DescribeEvents
//   upstream: staging/src/k8s.io/apimachinery/pkg/labels/labels.go FormatLabels (`<none>` when
//             empty); Go src/net/ipsock.go JoinHostPort

import type { Millis } from '@simlab/kernel';
import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { formatLabels } from '../../apimachinery/labels.ts';
import { describeEvents, meta, obj, objs, printAnnotationsMultiline, printLabelsMultiline, strMap } from './common.ts';
import { d, LEVEL_0, s, tabbedString } from './writer.ts';

const strs = (v: Json | undefined): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : []);
const joinHostPort = (host: string, port: string): string => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`);

function buildIngressString(ingress: JsonObject[]): string {
  return ingress.map((i) => (s(i.ip) !== '' ? `${s(i.ip)}${typeof i.ipMode === 'string' ? ` (${i.ipMode})` : ''}` : s(i.hostname))).join(', ');
}

/** formatEndpointSlices for the named port (ports = sets.New(sp.Name)). */
function formatEndpointSlices(slices: JsonObject[], portName: string): string {
  if (slices.length === 0) return '<none>';
  const list: string[] = [];
  const max = 3;
  let more = false;
  let count = 0;
  const ready = (e: JsonObject) => obj(e.conditions).ready !== false;
  for (const slice of slices) {
    const ports = objs(slice.ports);
    const endpoints = objs(slice.endpoints);
    if (ports.length === 0) {
      for (const e of endpoints) {
        if (list.length === max) more = true;
        if (!ready(e)) continue;
        if (!more) list.push(strs(e.addresses)[0] ?? '');
        count++;
      }
      continue;
    }
    for (const port of ports) {
      if (s(port.name) !== portName) continue;
      for (const e of endpoints) {
        if (list.length === max) more = true;
        if (!ready(e)) continue;
        if (!more) list.push(joinHostPort(strs(e.addresses)[0] ?? '', d(port.port)));
        count++;
      }
    }
  }
  const ret = list.join(',');
  return more ? `${ret} + ${count - max} more...` : ret;
}

/** describeService */
export function describeService(svc: JsonObject, slices: JsonObject[], events: JsonObject[] | undefined, now: Millis): string {
  const m = meta(svc);
  const spec = obj(svc.spec);
  const status = obj(svc.status);
  return tabbedString((w) => {
    w.write(LEVEL_0, `Name:\t${s(m.name)}\n`);
    w.write(LEVEL_0, `Namespace:\t${s(m.namespace)}\n`);
    printLabelsMultiline(w, 'Labels', m.labels);
    printAnnotationsMultiline(w, 'Annotations', m.annotations);
    w.write(LEVEL_0, `Selector:\t${formatLabels(strMap(spec.selector))}\n`);
    w.write(LEVEL_0, `Type:\t${s(spec.type)}\n`);
    if (typeof spec.ipFamilyPolicy === 'string') w.write(LEVEL_0, `IP Family Policy:\t${spec.ipFamilyPolicy}\n`);
    const families = strs(spec.ipFamilies);
    w.write(LEVEL_0, `IP Families:\t${families.length > 0 ? families.join(',') : '<none>'}\n`);
    w.write(LEVEL_0, `IP:\t${s(spec.clusterIP)}\n`);
    const ips = strs(spec.clusterIPs);
    w.write(LEVEL_0, `IPs:\t${ips.length > 0 ? ips.join(',') : '<none>'}\n`);
    const external = strs(spec.externalIPs);
    if (external.length > 0) w.write(LEVEL_0, `External IPs:\t${external.join(',')}\n`);
    if (s(spec.loadBalancerIP) !== '') w.write(LEVEL_0, `Desired LoadBalancer IP:\t${s(spec.loadBalancerIP)}\n`);
    if (s(spec.externalName) !== '') w.write(LEVEL_0, `External Name:\t${s(spec.externalName)}\n`);
    const ingress = objs(obj(status.loadBalancer).ingress);
    if (ingress.length > 0) w.write(LEVEL_0, `LoadBalancer Ingress:\t${buildIngressString(ingress)}\n`);
    for (const sp of objs(spec.ports)) {
      const name = s(sp.name) === '' ? '<unset>' : s(sp.name);
      const protocol = s(sp.protocol);
      w.write(LEVEL_0, `Port:\t${name}\t${d(sp.port)}/${protocol}\n`);
      w.write(LEVEL_0, `TargetPort:\t${typeof sp.targetPort === 'number' ? String(sp.targetPort) : s(sp.targetPort)}/${protocol}\n`);
      if (typeof sp.appProtocol === 'string') w.write(LEVEL_0, `AppProtocol:\t${sp.appProtocol}\n`);
      if (typeof sp.nodePort === 'number' && sp.nodePort !== 0) w.write(LEVEL_0, `NodePort:\t${name}\t${sp.nodePort}/${protocol}\n`);
      w.write(LEVEL_0, `Endpoints:\t${formatEndpointSlices(slices, s(sp.name))}\n`);
    }
    w.write(LEVEL_0, `Session Affinity:\t${s(spec.sessionAffinity)}\n`);
    if (s(spec.externalTrafficPolicy) !== '') w.write(LEVEL_0, `External Traffic Policy:\t${s(spec.externalTrafficPolicy)}\n`);
    if (typeof spec.internalTrafficPolicy === 'string') w.write(LEVEL_0, `Internal Traffic Policy:\t${spec.internalTrafficPolicy}\n`);
    if (typeof spec.healthCheckNodePort === 'number' && spec.healthCheckNodePort !== 0) w.write(LEVEL_0, `HealthCheck NodePort:\t${spec.healthCheckNodePort}\n`);
    const ranges = strs(spec.loadBalancerSourceRanges);
    if (ranges.length > 0) w.write(LEVEL_0, `LoadBalancer Source Ranges:\t${ranges.join(',')}\n`);
    if (typeof spec.trafficDistribution === 'string') w.write(LEVEL_0, `Traffic Distribution:\t${spec.trafficDistribution}\n`);
    if (events) describeEvents(events, w, now);
  });
}
