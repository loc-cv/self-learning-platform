# Phase 07a — kubectl I: framework, get, output formats, differential tests

**Milestone** M1 · **Needs** 03, 04, 06b · Follow the session protocol in `CLAUDE.md`.

## Goal

The kubectl foundation and the read path. kubectl is the surface I touch most, so its output must
match the real binary character for character. The golden fixtures and the real kubectl binary from
phase 04 are the judge; your memory of kubectl output is not.

## Read first

`PLAN.md` §3, §7, §9. `docs/FIDELITY.md`. The golden fixtures and the command and flag manifest
from phase 04. Upstream printers in `.upstream/` (search them; don't read them whole).

## Build

- **Command framework**: flag parsing with kubectl's conventions (long and short forms, `=` or
  space, booleans, repeats, flags before or after arguments), global flags, help and usage output,
  and the real errors for unknown commands and flags. Using the manifest, a command or flag that real
  kubectl has but the simulator lacks prints a `[sim]` notice and is logged; nothing is silently
  ignored. Design it so each later verb is one small module.
- **Client plumbing**: kubeconfig read from the machine's VFS, contexts and current namespace;
  requests go through a connection abstraction so that later an unreachable API server yields the
  real connection error.
- **Resource arguments**: short names, singular and plural, `type/name`, comma-separated types,
  several names, the `all` category, and the real errors for unknown types.
- **`get`**: table printers for Pod, Deployment, ReplicaSet, Service, Node, Namespace, ConfigMap,
  Secret, ServiceAccount, Event, Endpoints and EndpointSlice, including `-o wide`; `-o yaml`,
  `-o json`, `-o name`; `-A`, `-n`, `-l`, `--show-labels`, `-L`, `--no-headers`, `-w`; human-readable
  ages; the exact "No resources found" and not-found messages and which stream they go to.
- **YAML and JSON output** equal to kubectl's: key order, quoting, indentation, list wrapping for
  multiple objects, which fields are shown.
- **Differential runner**: run a golden case in the simulator, normalize, and diff against the
  fixture. Wire it into the test suite for the cases the simulator supports, and report which cases
  are not yet supported.
- **Provenance registry**: each printer and error family registers its tag; `npm run
  fidelity:report` prints the table.

## Not in this phase

`describe`, `create`, `apply`, `delete` (phase 07b). Imperative verbs, logs, rollout, explain, edit,
completion (phase 08). jsonpath, custom columns, sorting, patch, wait (phase 15).

## Exit criteria

- Every golden `get` case in scope passes the differential runner, or its difference is entered in
  the divergence register with a reason.
- Transcripts cover each printer in each output format, mixed-type gets, selectors, `-A`, empty
  results, not-found, unknown resource type, unknown flag, and a real-but-unsimulated flag.
- `kubectl get pods -w` streams changes in virtual time and stops on Ctrl-C.
- p95 latency of `get` on the default topology is under 50 ms, measured and recorded.
- In script mode, show `kubectl get` output for a running Deployment in table, wide and YAML forms.
