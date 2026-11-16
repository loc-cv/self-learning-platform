// Objects of a manifest created through the API server, as `kubectl create -f` would send them:
// how transcripts (`# objects:`) and `npm run sim -- --objects` set up a cluster until phase 07b's
// `kubectl create` and `apply` can be typed instead (STATUS.md, Temporary shortcuts). Not
// user-visible; errors are thrown.

import type { Ctx } from '@simlab/kernel';
import { yamlToJson } from '../apimachinery/yaml/decode.ts';
import { splitYamlDocuments } from '../apimachinery/yaml/stream.ts';
import { isObject, type JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from '../apiserver/config.ts';
import { handle } from '../apiserver/pipeline.ts';
import { registry as discovery } from '../discovery/registry.ts';

export function manifestObjects(text: string, where: string): JsonObject[] {
  const out: JsonObject[] = [];
  const split = splitYamlDocuments(text);
  if (split.error) throw new Error(`${where}: ${split.error}`);
  for (const doc of split.docs) {
    const r = yamlToJson(doc);
    if (!r.ok) throw new Error(`${where}: ${JSON.stringify(r)}`);
    if (isObject(r.value)) out.push(r.value);
  }
  return out;
}

/** Creates each object of the manifest text in order (namespace from metadata, else default). */
export function createObjects(ctx: Ctx, text: string, where: string): void {
  for (const obj of manifestObjects(text, where)) {
    const apiVersion = String(obj.apiVersion);
    const [group, version] = apiVersion.includes('/') ? (apiVersion.split('/') as [string, string]) : ['', apiVersion];
    const res = discovery().forKind(group, version, String(obj.kind));
    if (!res) throw new Error(`${where}: no resource for ${apiVersion} ${String(obj.kind)}`);
    const ns = isObject(obj.metadata) && typeof obj.metadata.namespace === 'string' ? obj.metadata.namespace : 'default';
    const r = handle(ctx, DEFAULT_APISERVER, { verb: 'create', group, version, resource: res.resource, ...(res.namespaced ? { namespace: ns } : {}), body: obj });
    if (!r.ok) throw new Error(`${where}: ${JSON.stringify(r)}`);
  }
}
