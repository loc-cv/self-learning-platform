// Requests, responses and the per-kind strategy contract of the API server
// (docs/ARCHITECTURE.md §4.2). A strategy is the port of a kind's registry strategy
// (pkg/registry/<group>/<resource>/strategy.go) plus its defaulting (pkg/apis/<group>/v1/defaults.go)
// and validation (pkg/apis/<group>/validation), working on the versioned JSON.

import type { Ctx } from '@simlab/kernel';
import type { Status } from '../apimachinery/errors.ts';
import type { FieldError } from '../apimachinery/field.ts';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import type { ApiObject, EtcdData } from './store.ts';
import type { ApiServerConfig } from './config.ts';

export type Verb = 'get' | 'list' | 'watch' | 'create' | 'update' | 'patch' | 'delete';

export interface UserInfo {
  username: string;
  groups: string[];
}

export interface RequestOptions {
  dryRun?: boolean;
  fieldManager?: string;
  /** Strict, Warn or Ignore; absent means Warn (upstream: endpoints/handlers/rest.go fieldValidation). */
  fieldValidation?: string;
  labelSelector?: string;
  fieldSelector?: string;
  /** Watch and list: where to start. */
  resourceVersion?: string;
  propagationPolicy?: string;
  orphanDependents?: boolean;
  gracePeriodSeconds?: number;
  preconditions?: { uid?: string; resourceVersion?: string };
  /** Only `merge` (application/merge-patch+json) in this phase. */
  patchType?: 'merge' | 'json' | 'strategic' | 'apply';
}

export interface ApiRequest {
  verb: Verb;
  group: string;
  version: string;
  resource: string;
  subresource?: string;
  namespace?: string;
  name?: string;
  body?: Json;
  options?: RequestOptions;
  /** Who is asking: the authentication stage fills it from credentials (phase 20a). */
  user?: UserInfo;
}

export type ApiResponse =
  | { ok: true; code: number; object: Json; warnings: string[] }
  | { ok: false; code: number; status: Status; warnings: string[] }
  /** The request reached something the simulator does not model; logged as a gap. */
  | { ok: false; code: 0; notSimulated: string; warnings: string[] };

/** What a strategy may read while it decides: the clock, randomness, the store. */
export interface StrategyCtx {
  readonly ctx: Ctx;
  readonly server: ApiServerConfig;
  readonly etcd: EtcdData;
  /** metav1.Now() as stored: RFC 3339, second precision. */
  now(): string;
  /** The request being served. */
  readonly request: ApiRequest;
  /** dryRun=All: nothing may be persisted, allocations included. */
  readonly dryRun: boolean;
  /**
   * Reports that the request uses a field whose validation or behavior is not ported yet: the
   * object is accepted as the real server would accept a valid one, and the gap log says so.
   */
  notPorted(what: string): void;
}

export interface StatusStrategy {
  prepareForUpdate(obj: JsonObject, old: ApiObject, s: StrategyCtx): void;
  validateUpdate(obj: JsonObject, old: ApiObject, s: StrategyCtx): FieldError[];
  warningsOnUpdate?(obj: JsonObject, old: ApiObject, s: StrategyCtx): string[];
}

/** Garbage collection policy when a delete names none (upstream: GarbageCollectionPolicy). */
export type GcPolicy = 'DeleteDependents' | 'OrphanDependents' | 'Unsupported';

export interface Strategy {
  group: string;
  /** Plural resource. */
  resource: string;
  kind: string;
  /** Storage resource in etcd; resources of two groups may share one (events). */
  storage: string;
  /** Version objects are stored in; requests in other versions are converted. */
  storageVersion: string;
  /**
   * Group of the storage version when it is not `group`: events.k8s.io Events are stored as
   * core/v1 Events (pkg/registry/events/rest/storage_events.go reuses the core event storage).
   */
  storageGroup?: string;
  /** Group of the internal kind in Invalid messages (`Deployment.apps`); default: `group`. */
  internalGroup?: string;
  /** Conversion from a served version to the storage version and back (identity when absent). */
  toStorage?(obj: JsonObject, fromVersion: string): JsonObject;
  fromStorage?(obj: ApiObject, toVersion: string): JsonObject;

  /**
   * A failure of the conversion to the internal type that decoding performs after defaulting
   * (apiserver's versioning codec Decode: it wins over strict field errors), as the error text:
   * DaemonSet's template generation annotation (pkg/apis/apps/v1/conversion.go).
   */
  conversionError?(obj: JsonObject): string | undefined;
  /** SetObjectDefaults_<Kind>: runs after decoding, on create and update and on every patch. */
  defaults?(obj: JsonObject, s: StrategyCtx): void;
  prepareForCreate?(obj: JsonObject, s: StrategyCtx): void;
  prepareForUpdate?(obj: JsonObject, old: ApiObject, s: StrategyCtx): void;
  /** Validate, including ObjectMeta validation with the kind's name rule. */
  validate(obj: JsonObject, s: StrategyCtx): FieldError[];
  /** ValidateUpdate of the strategy (the generic ObjectMeta update checks run before it). */
  validateUpdate(obj: JsonObject, old: ApiObject, s: StrategyCtx): FieldError[];
  warningsOnCreate?(obj: JsonObject, s: StrategyCtx): string[];
  warningsOnUpdate?(obj: JsonObject, old: ApiObject, s: StrategyCtx): string[];
  canonicalize?(obj: JsonObject): void;
  allowCreateOnUpdate: boolean;
  allowUnconditionalUpdate: boolean;
  /** The REST storage returns the deleted object, not a Success Status (ReturnDeletedObject). */
  returnDeletedObject?: boolean;
  gcPolicy?: GcPolicy;
  /** CheckGracefulDelete: the grace period, or undefined when the kind is not deleted gracefully. */
  gracePeriod?(obj: ApiObject, requested: number | undefined): number | undefined;
  /** GetAttrs: the field set field selectors match against. */
  fields?(obj: ApiObject): Record<string, string>;
  /** The kind's field label conversion: the label to match, or the error message. */
  convertFieldLabel?(label: string, value: string): { label: string; value: string } | { error: string };
  /** The status subresource, when the kind has one. */
  status?: StatusStrategy;
  /**
   * Other subresources written with update, each with its own update strategy over the whole
   * object (namespaces/finalize: pkg/registry/core/namespace/strategy.go namespaceFinalizeStrategy).
   */
  updateSubresources?: Record<string, StatusStrategy>;
  /**
   * Storage-level work at create time inside the write, after validation and admission:
   * Service IP and port allocation. Errors become Invalid; a Status is returned as it is.
   */
  beforePersist?(obj: JsonObject, s: StrategyCtx): FieldError[] | Status | undefined;
  /** The same at update time (a Service changing type allocates or releases). */
  beforePersistUpdate?(obj: JsonObject, old: ApiObject, s: StrategyCtx): FieldError[] | Status | undefined;
  /** The scale subresource: the autoscaling/v1 Scale of an object, and applying one to it. */
  scale?: {
    get(obj: JsonObject): JsonObject;
    replicasPath: string[];
  };
  /**
   * A REST storage with its own Delete (Namespace): returns the response, or undefined to fall
   * through to the generic delete. `persist` stores an updated object as the generic path does.
   */
  deleteHook?(obj: ApiObject, s: StrategyCtx, persist: (obj: JsonObject) => ApiObject): ApiResponse | undefined;
  /**
   * The deprecation warning every request to the resource gets, failed ones included
   * (upstream: apiserver/pkg/endpoints/installer.go, deprecation.WarningMessage).
   */
  deprecationWarning?: string;
  /** An extra condition for removing an object whose last finalizer went (Namespace: spec.finalizers empty). */
  deleteDuringUpdate?(obj: JsonObject): boolean;
  /** Objects the API server creates for this kind when it starts in an empty store. */
  bootstrap?(ctx: Ctx, server: ApiServerConfig): void;
  /** After the object is gone from the store: release allocations. */
  afterDelete?(obj: ApiObject, s: StrategyCtx): void;
}
