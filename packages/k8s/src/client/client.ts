// The client programs and controllers use to talk to an API server (docs/ARCHITECTURE.md §4.2).
// In this phase it calls the pipeline directly; the transport (kubeconfig, network model,
// connection errors) wraps it in later phases without changing this interface.

import type { Ctx } from '@simlab/kernel';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ApiServerConfig } from '../apiserver/config.ts';
import { handle, openWatch, watchEvents } from '../apiserver/pipeline.ts';
import { closeSubscription, watchTopic, type WatchEventType } from '../apiserver/store.ts';
import type { ApiRequest, ApiResponse, RequestOptions, UserInfo } from '../apiserver/types.ts';
import type { Status } from '../apimachinery/errors.ts';

export interface GroupVersionResource {
  group: string;
  version: string;
  resource: string;
}

/** Parses `apps/v1/deployments` or `v1/pods`. */
export function gvr(s: string): GroupVersionResource {
  const parts = s.split('/');
  return parts.length === 2 ? { group: '', version: parts[0] as string, resource: parts[1] as string } : { group: parts[0] as string, version: parts[1] as string, resource: parts[2] as string };
}

export interface ResourceClient {
  get(namespace: string | undefined, name: string, subresource?: string): ApiResponse;
  list(namespace: string | undefined, options?: RequestOptions): ApiResponse;
  create(namespace: string | undefined, body: JsonObject, options?: RequestOptions): ApiResponse;
  update(namespace: string | undefined, body: JsonObject, options?: RequestOptions): ApiResponse;
  updateStatus(namespace: string | undefined, body: JsonObject, options?: RequestOptions): ApiResponse;
  /** JSON merge patch. */
  patch(namespace: string | undefined, name: string, patch: Json, options?: RequestOptions & { subresource?: string }): ApiResponse;
  delete(namespace: string | undefined, name: string, options?: RequestOptions): ApiResponse;
  /** Opens a watch; events are read with `Client.events` after `k8s.watch:<id>` is published. */
  watch(namespace: string | undefined, options: RequestOptions, owner: Json): { id: string; topic: string } | { status: Status } | { notSimulated: string };
}

export interface Client {
  /** The server it talks to and the identity it sends: enough to build it again later. */
  readonly server: ApiServerConfig;
  readonly user?: UserInfo;
  resource(r: GroupVersionResource | string): ResourceClient;
  request(req: ApiRequest): ApiResponse;
  /** Pending events of a watch, oldest first, removed from the subscription. */
  events(watchId: string): { type: WatchEventType; object: JsonObject }[];
  stopWatch(watchId: string): void;
}

/** Sees every request a client sends and its response: controllers trace their writes with it. */
export type RequestObserver = (req: ApiRequest, res: ApiResponse) => void;

export function createClient(ctx: Ctx, server: ApiServerConfig, user?: UserInfo, observe?: RequestObserver): Client {
  const request = (req: ApiRequest): ApiResponse => {
    const r = handle(ctx, server, user ? { ...req, user } : req);
    observe?.(req, r);
    return r;
  };
  const nameOf = (body: JsonObject): string => {
    const m = body.metadata;
    return m !== null && typeof m === 'object' && !Array.isArray(m) && typeof m.name === 'string' ? m.name : '';
  };
  const ns = (namespace: string | undefined) => (namespace === undefined ? {} : { namespace });
  const opts = (options: RequestOptions | undefined) => (options ? { options } : {});
  return {
    server,
    ...(user ? { user } : {}),
    request,
    resource(r) {
      const g = typeof r === 'string' ? gvr(r) : r;
      return {
        get: (namespace, name, subresource) => request({ verb: 'get', ...g, ...ns(namespace), name, ...(subresource ? { subresource } : {}) }),
        list: (namespace, options) => request({ verb: 'list', ...g, ...ns(namespace), ...opts(options) }),
        create: (namespace, body, options) => request({ verb: 'create', ...g, ...ns(namespace), body, ...opts(options) }),
        update: (namespace, body, options) => request({ verb: 'update', ...g, ...ns(namespace), name: nameOf(body), body, ...opts(options) }),
        updateStatus: (namespace, body, options) => request({ verb: 'update', ...g, subresource: 'status', ...ns(namespace), name: nameOf(body), body, ...opts(options) }),
        patch: (namespace, name, body, options) => {
          const { subresource, ...rest } = options ?? {};
          return request({ verb: 'patch', ...g, ...(subresource ? { subresource } : {}), ...ns(namespace), name, body, options: { patchType: 'merge', ...rest } });
        },
        delete: (namespace, name, options) => request({ verb: 'delete', ...g, ...ns(namespace), name, ...opts(options) }),
        watch: (namespace, options, owner) => {
          const r2 = openWatch(ctx, server, { verb: 'watch', ...g, ...ns(namespace), options, ...(user ? { user } : {}) }, owner);
          if ('ok' in r2) return { id: r2.ok.id, topic: watchTopic(r2.ok.id) };
          return r2;
        },
      };
    },
    events: (id) => watchEvents(ctx, server, id),
    stopWatch: (id) => closeSubscription(ctx, id),
  };
}
