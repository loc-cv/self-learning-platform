# Phase 08 — kubectl II: imperative verbs, logs, rollout, explain, edit, completion

**Milestone** M1 · **Needs** 07b · Follow the session protocol in `CLAUDE.md`.

## Goal

The write path people actually use under time pressure: imperative commands, generators with
`--dry-run=client -o yaml`, rollouts, logs, `explain`, `edit` and tab completion. With this phase
the everyday kubectl loop works end to end.

## Read first

`docs/COVERAGE.md` and `docs/FIDELITY.md`. The golden fixtures. Use the real kubectl binary in
client-only mode (phase 04) to capture generator output and help text for each verb you add.

## Build

- **Generators**: `run` (image, port, env, labels, restart policy, command and args after `--`),
  `create deployment`, `create namespace`, `create configmap`, `create secret generic`,
  `create service`, `expose`. All honor `--dry-run=client` and `-o`, and their YAML must equal the
  real binary's output.
- **Changing things**: `scale`, `set image`, `label`, `annotate`, `edit` through the editor
  protocol, including the re-open-on-invalid behavior and its messages.
- **Rollouts**: `rollout status` (blocking, with the real progress lines), `history` (including
  `--revision`), `undo` (including `--to-revision`), `restart`, `pause`, `resume`; the change-cause
  annotation.
- **`logs`**: by Pod and by `deploy/name`, `-c`, `-f`, `--tail`, `--previous`, `--since`,
  `--all-containers`, `-l`, and the real errors for a container that isn't running yet.
- **`explain`**: driven by the vendored OpenAPI data, including nested paths and `--recursive`.
- **Small ones**: `version`, `api-resources`, `api-versions`, `cluster-info`,
  `config view / get-contexts / use-context / set-context --current --namespace`.
- **Completion**: register a kubectl completer with the framework from phase 03: verbs, resource
  types, resource names in the right namespace, namespaces after `-n`, flags, file paths after `-f`.
  It must work through `alias k=kubectl` as it does with the real completion script.

## Not in this phase

`exec`, `cp`, `port-forward`, `run -it` (phase 17; print a `[sim]` notice until then). `patch`,
`replace`, `wait`, jsonpath, custom columns (phase 15). `auth can-i` (phase 20a). `top` (phase 18b).

## Exit criteria

- Generator output for each verb equals the real binary's, verified by fixtures, across a spread of
  flag combinations.
- Transcripts cover a full rollout story: create, set image, `rollout status`, history, a bad image,
  undo, restart.
- `kubectl logs -f` streams in virtual time; `--previous` works after a crash.
- `kubectl explain deployment.spec.strategy` equals real output for the pinned version.
- In the terminal player: the loop `k create deploy … --dry-run=client -o yaml > d.yaml`, edit,
  `k apply -f d.yaml`, `k edit`, `k rollout status` works with tab completion throughout. Show it.
