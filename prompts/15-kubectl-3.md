# Phase 15 — kubectl III: output shaping, selectors, patch, replace, wait, diff

**Milestone** M3 · **Needs** 08 · Follow the session protocol in `CLAUDE.md`.

## Goal

The kubectl features that separate fluent users from slow ones: shaping output, selecting
precisely, and changing objects in place. They are exam staples and daily tools.

## Read first

`docs/COVERAGE.md`, `docs/FIDELITY.md`. Capture new golden cases with the oracle (phase 04) for
everything you add; extend the differential tests.

## Build

- **Output**: `-o jsonpath` and `jsonpath-file` with kubectl's dialect (ranges, filters, wildcards,
  recursive descent, quoting rules, its error messages); `-o custom-columns` and
  `custom-columns-file`; `-o go-template` only if cheap, otherwise a `[sim]` notice; `--sort-by`;
  `--field-selector` with the fields each resource really supports; set-based label selectors;
  `--show-kind`; `--chunk-size` accepted.
- **Changing objects**: `patch` with strategic merge (including list merge keys from the schema),
  JSON merge and JSON patch types; `replace` and `replace --force`; `apply` options in common use
  (`--prune` gets a notice); `delete` refinements; `set resources`, `set env`,
  `set serviceaccount`, `set selector`.
- **Waiting and comparing**: `wait --for=condition=…`, `--for=delete`, `--for=jsonpath=…` with
  timeouts in virtual time; `diff`.
- **Inspecting**: `events` (with `--for`, `--types`, `-w`), `get events --sort-by`, `describe` for
  the remaining kinds built so far and the generic describer for the rest, `get -o yaml` on lists,
  `get --raw` for a few common paths, `api-resources` filters, `explain` output variants.
- **Config**: the rest of `kubectl config` in common use, `--context`, `--namespace` precedence,
  the `KUBECONFIG` variable.
- A few drills that exercise jsonpath, custom columns, sorting and patch.

## Not in this phase

`exec`, `cp`, `port-forward` (phase 17). `auth`, `certificate` (phase 20a). `top`, `autoscale`
(phase 18b). `cordon`, `drain`, `taint` (phase 26b). `kustomize` (phase 23).

## Exit criteria

- jsonpath: a test table of at least forty expressions, each verified against the real binary,
  including error cases.
- Strategic merge patch handles container lists by name, verified against fixtures.
- `kubectl wait` blocks and times out correctly in virtual time.
- All new golden cases pass or are in the divergence register.
- `docs/COVERAGE.md` regenerated; the drills pass `content:check`.
