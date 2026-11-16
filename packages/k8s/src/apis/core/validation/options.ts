// PodValidationOptions: what the Pod validation may allow, from feature gates and the old object.
// upstream: pkg/apis/core/validation/validation.go PodValidationOptions; the values come from
// pkg/api/pod/util.go GetValidationOptionsFromPodSpecAndMeta / GetValidationOptionsFromPodTemplate
// (not in the checkout when this was written; it is now). The gates are the v1.37.2 defaults, read from the oracle's
// kubernetes_feature_enabled metric: RelaxedEnvironmentVariableValidation (GA), EnvFiles (beta, on),
// ContainerRestartRules (beta, on), RestartAllContainersOnContainerExits (beta, on),
// InPlacePodVerticalScaling (GA), PodLevelResources (beta, on), TaintTolerationComparisonOperators
// (alpha, off), UserNamespacesHostNetworkSupport (alpha, off). The backward-compatibility
// allowances (invalid values an old object already had) are all off: the simulator never stored
// such objects.

export interface PodValidationOptions {
  /** The top-level resource is a Pod, not a PodSpec embedded in a template. */
  resourceIsPod: boolean;
  /** Reports a field whose validation is not ported (StrategyCtx.notPorted). */
  notPorted(what: string): void;
}

export const ALLOW_RELAXED_ENV_VAR_NAMES = true;
export const ALLOW_ENV_FILES = true;
export const ALLOW_CONTAINER_RESTART_POLICY_RULES = true;
export const ALLOW_RESTART_ALL_CONTAINERS = true;
export const ALLOW_SIDECAR_RESIZE_POLICY = true;
export const POD_LEVEL_RESOURCES = true;
export const ALLOW_TAINT_TOLERATION_COMPARISON_OPERATORS = false;
export const ALLOW_USER_NAMESPACES_HOST_NETWORK = false;
