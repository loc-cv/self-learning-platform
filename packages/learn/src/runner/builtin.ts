// The step kinds the runner itself implements (docs/SCENARIO_FORMAT.md §6.1): `advance` and
// `until` need nothing but the kernel and the check registry, so no plugin registers them.

export const BUILTIN_STEP_NAMES: readonly string[] = ['advance', 'until'];
