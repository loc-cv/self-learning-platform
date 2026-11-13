# Phase 00 — Bootstrap, version pin, architecture and scenario format specs

**Milestone** M0 · **Needs** nothing · Follow the session protocol in `CLAUDE.md`.

## Goal

Turn an empty folder into a working repository whose quality gate runs, and turn the decisions in
`PLAN.md` into two specs precise enough that later sessions implement against them instead of
re-deciding. No engine behavior is implemented in this phase.

## Read first

`PLAN.md` in full. `CLAUDE.md`. `STATUS.md`.

## Build

**Repository**
- `git init` on `main`. `.gitignore` for `node_modules`, build output, `data/`, `.upstream/`.
- npm workspaces matching the layout in `CLAUDE.md`, each package with an entry point and one real
  test. TypeScript strict with project references. Vitest. ESLint with two custom guarantees:
  import boundaries between packages (§6 dependency rule) and determinism bans in engine packages
  (`Date`, `Math.random`, timers, Node and DOM globals). Prove each rule fires with a fixture.
- `npm run check` as the single gate. Reconcile the Commands section of `CLAUDE.md` with what
  exists: keep planned commands listed, marked with the phase that introduces them.

**Version pin and upstream sources**
- Confirm on the web the Kubernetes version the CKA and CKAD exams use and the latest patch of that
  minor. Record version, date checked and source links. Put the version in one constant.
- `npm run upstream:fetch`: a sparse, blob-less clone of `kubernetes/kubernetes` at the pinned tag
  into `.upstream/`, limited to what later phases read (kubectl, printers, API types and validation,
  OpenAPI specs, scheduler plugins, kubelet events, controllers). Run it and confirm it works.
- Save the current official CKA and CKAD curriculum documents' version, URL and checksum under
  `docs/curriculum/`, with the competency lists as text. Keep the PDFs only if their license allows.

**Specs** (English Markdown, Mermaid diagrams where a picture explains better)
- `docs/ARCHITECTURE.md`: concrete TypeScript interface sketches and data flows for the kernel
  (world state, clock, event queue, time drivers, PRNG streams, snapshot, fork, hash, input log and
  replay, trace records, plugin registry), the host substrate (machine, VFS, program interface with
  blocking and interruption, streams and pipelines, TTY, editor protocol) and the Kubernetes plugin
  (store and watch, request pipeline, controller runtime, the coupling of components to node
  state). Resolve the hard questions explicitly and say why: how blocking programs and streaming
  pipelines stay deterministic; how fork stays cheap; what may live outside world state.
- `docs/SCENARIO_FORMAT.md`: the content schema for a lab-like item (world, params, setup steps,
  ticket, hints, checks, solutions, debrief, skills, curriculum tags), the check catalog and how
  plugins register checks and faults, the Vietnamese sidecar format with source hashes, and three
  fully worked examples: a CKAD workload task, a CKA node troubleshooting task, and a chained
  real-world incident. Write the examples as if they had to run; they become real content later.
- `docs/FIDELITY.md`: the pin, the source hierarchy, provenance tags, the `[sim]` notice and gap
  log contract, and an empty divergence register.
- `docs/decisions.md`: start it with the decisions you made in this session.

## Not in this phase

Engine code beyond package skeletons. UI. Content. The remaining docs (`CURRICULUM_MAP`, `AUTHORING`,
`COVERAGE`, `ADDING_A_DOMAIN`) are written by later phases.

## Exit criteria

- `npm run check` passes on a fresh clone after `npm ci`.
- Each lint guarantee is demonstrated to fail on a violating fixture.
- `npm run upstream:fetch` succeeds and `.upstream/` contains the pinned tag.
- The specs agree with `PLAN.md`; any deviation is recorded in `docs/decisions.md` and was confirmed with me.
- The three worked scenarios use only constructs the format spec defines.
