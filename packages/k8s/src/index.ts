// Kubernetes domain plugin: API machinery, controllers, scheduler, kubelet, network, kubectl, kubeadm.
// Specified in docs/ARCHITECTURE.md §4.

export const packageName = '@simlab/k8s';

export { KUBERNETES_MINOR, KUBERNETES_TAG, KUBERNETES_VERSION } from './version.ts';
export { k8sPlugin, K8S_SLICE_VERSION } from './plugin.ts';
export { K8S_CHECKS } from './checks/index.ts';
export { DEFAULT_APISERVER, type ApiServerConfig } from './apiserver/config.ts';
export { handle, openWatch, watchEvents } from './apiserver/pipeline.ts';
export { bootstrapApiServer, SYSTEM_NAMESPACES } from './apiserver/bootstrap.ts';
export type { ApiRequest, ApiResponse, RequestOptions, Strategy, StrategyCtx } from './apiserver/types.ts';
export { createClient, gvr, type Client, type ResourceClient } from './client/client.ts';
export { registry, type ApiResource } from './discovery/registry.ts';
export { schema } from './openapi/schema.ts';
export { openApiV3Document, openApiV3Paths } from './openapi/v3.ts';
export { CLUSTERS, KUBEADM_1CP_2W, KUBEADM_1N, controlPlaneNode, type ClusterDef, type ClusterNodeDef } from './topology/cluster.ts';
export { NODE_ALLOCATABLE, NODE_CAPACITY, NODE_INFO, nodeLabels, nodeObject } from './topology/nodes.ts';
export { apiServerConfig, buildCluster, TOPOLOGIES } from './topology/build.ts';
export { isSchedulerRunning, startScheduler, stopScheduler } from './scheduler/scheduler.ts';
export { isKubeletRunning, startKubelet, stopKubelet, type KubeletNode } from './kubelet/kubelet.ts';
export { runtimeOf } from './runtime/runtime.ts';
export type { NodeRuntime, RuntimeContainer, Sandbox, RuntimeImage } from './runtime/types.ts';
export { GLOBALS as KUBECTL_GLOBALS, VERBS as KUBECTL_VERBS } from './kubectl/kubectl.ts';
export type { Verb } from './kubectl/cli/command.ts';
export { STRATEGIES } from './registry/index.ts';
export { manifest, manifestCommand, type Manifest, type ManifestCommand, type ManifestFlag, type ManifestHelp } from './kubectl/manifest.ts';
export { HELP_RUN, helpCommand, helpFlag, helpRun, helpText, optionsCommand, renderHelp, renderUsage, type HelpResult, type Terminal } from './kubectl/help/index.ts';
export { convertToTable, applyIncludeObject, type TableSource } from './printers/tablegenerator.ts';
export { humanDuration, shortHumanDuration, translateTimestampSince } from './printers/duration.ts';
export { TABLE_PROVENANCE } from './printers/provenance.ts';
export type { IncludeObjectPolicy, Table, TableColumnDefinition, TableRow, TableRowCondition } from './printers/types.ts';
export {
  DESCRIBE_TABWRITER,
  GET_TABWRITER,
  newTabWriter,
  render,
  setRememberedWidths,
  tabFlush,
  tabWrite,
  type Cells,
  type TabWriterParams,
  type TabWriterState,
} from './kubectl/printers/tabwriter.ts';
export {
  createTablePrinter,
  newHumanReadablePrinter,
  printObj,
  restoreTablePrinter,
  type GroupKind,
  type HumanReadablePrinterState,
  type PrintExtra,
  type PrintOptions,
  type TablePrinter,
  type TablePrinterState,
} from './kubectl/printers/tableprinter.ts';
export {
  decodeManifestStream,
  marshalIndentJson,
  marshalYaml,
  printJson,
  splitYamlDocuments,
  unmarshalYaml,
  yamlToJson,
  YAML_JSON_PROVENANCE,
  YamlMarshalError,
  type StreamResult,
  type YamlResult,
} from './apimachinery/yaml/index.ts';
export { K8S_STEPS, applyStep } from './scenario/apply.ts';
export { k8sView, k8sViewProvider, KINDS as K8S_VIEW_KINDS } from './view/provider.ts';
export { namespaceId, nodeId, objectId } from './view/ids.ts';
export { k8sEvents, NOT_SHOWN as K8S_TRACE_NOT_SHOWN, SHOWN_KINDS as K8S_TRACE_KINDS, type K8sEventDetail, type K8sViewEvent } from './view/trace.ts';
export { k8sWhy } from './view/why.ts';
