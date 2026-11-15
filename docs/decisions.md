# Decisions

Decisions that fill gaps in `PLAN.md` or the specs, newest phase last. A decision that
*contradicts* `PLAN.md` is not made here: it is asked first, and then recorded both here and in
`PLAN.md` §15. Each entry: what was decided, why, and what it rules out.

## Phase 00 (2026-11-13)

### Deviations from PLAN.md, confirmed with the owner

**D-001 — The pin is v1.37.2, not 1.37.1.**
`PLAN.md` §4.1 named 1.37.1 as the latest patch. On 2026-11-13 `dl.k8s.io/release/stable-1.37.txt`
and the upstream tag list both showed v1.37.2. §4.1 leaves the exact patch to phase 00, and the
rule "latest patch of the exam's minor" gives 1.37.2. The release binaries the oracle needs
(phase 04) are reachable for 1.37.2. Evidence in `docs/FIDELITY.md` §1.

**D-002 — A check is written as `assert: <name>` plus `with: { … }`.**
The example in `PLAN.md` §8 writes `assert: k8s.podsReady { namespace: "{{ns}}", … }`. That line is
not valid YAML (a plain scalar cannot contain `: `), so the format cannot be implemented as
drawn. The name and the arguments are two keys instead. Same information, parseable, and the
arguments can be validated against the check's schema. `until` steps use the same pair.

### Gaps filled

**D-003 — Variants inside one item.** Steps, checks, hints, named solutions and debrief blocks
may carry `when: { param: value }`. `PLAN.md` §5 asks for "which fault from a family" as a
parameter; this is the smallest mechanism that lets one item hold the family. A solution is a
bare list of steps (as in `PLAN.md` §8) or `{ name, steps, when }`; a debrief is a string or a
list of blocks. There are no expressions and no conditionals inside text.

**D-004 — No build step for packages.** Workspace packages export their TypeScript source
(`exports: ./src/index.ts`). Node (24 or later) runs it by stripping types, Vitest and Vite
compile it themselves, and `tsc -b` only type-checks (declarations go to `.tsbuild/`). Consequences:
relative imports carry the `.ts` extension; `erasableSyntaxOnly` is on, so no enums, namespaces
or parameter properties, which fits "plain functions and data"; tools are run as
`node tools/src/….ts`.

**D-005 — What the determinism guarantee covers.** `simlab/engine-determinism` applies to
`packages/{kernel,host,k8s,learn}/src`, except `*.test.ts`, which may read fixtures from disk.
Beyond `PLAN.md` §12's list (`Date`, `Math.random`, timers) it bans Node and DOM globals, Node
built-in imports, `console`, `fetch`, `crypto`, `Intl`, `performance` and `globalThis`. A second
guard is the type checker: engine sources compile with `lib: ES2024` and `types: []`, so a Node
or DOM API does not even type-check. Not detectable by lint and left to review and determinism
tests: locale-dependent methods (`toLocaleString`), reliance on object key order, and `async`.

**D-006 — The dependency graph as data.** `tools/eslint/boundaries.js` is the one table; the
lint rule and tests read it. Beyond `PLAN.md` §6: `content` may import `kernel` and `learn`;
apps and tools may import any package; no package imports an app or `tools`; apps do not import
each other; imports go through a package's entry point (no deep imports, no relative paths that
leave the package). `learn` is treated as an engine package for determinism, since the scenario
runner and scheduler run in the worker.

**D-007 — TypeScript 6.0.3, not 7.** `typescript-eslint` 8.72.2 supports TypeScript below 6.1.
Revisit when it supports 7.

**D-008 — Cheap fork through containers and frozen values.** World state is mutable containers
holding deeply frozen values; fork copies containers and shares values; the frozen flag is the
marker (`docs/ARCHITECTURE.md` §2.1, §2.7, with the rejected alternatives). This refines
`PLAN.md` §6.1 "world state is plain data" without changing it.

**D-009 — Programs are synchronous generators; actors are event handlers.** Everything
long-lived (controllers, kubelet, units, the TTY line editor) keeps its state in the world and
advances by events. Only what a shell starts is a coroutine, with its frame outside world state.
A fork terminates programs that are not at a restart point in the copy. No `async`, promises or
microtasks in the engine (`docs/ARCHITECTURE.md` §3.4, §5).

**D-010 — Extension contracts live in `kernel`.** Checks, faults, steps and topologies are
registered by plugins and consumed by `learn`, which may import only `kernel`; so their
interfaces are defined there, generically (`docs/ARCHITECTURE.md` §2.11). Their argument schemas
are JSON Schema objects, plain data, so content can be validated at build time and editors can
complete item files. `ajv` and `yaml` are development-time dependencies of `tools` for now;
phase 09 decides where content validation lives.

**D-011 — The `[sim]` notice.** One line on stderr, prefix `[sim] `, exit status 250 reserved
for it. A program the real machine would have but that is not simulated exists in the VFS as a
stub that prints the notice; a program the real machine would not have gets the shell's real
`command not found` and is still logged as a gap (`docs/FIDELITY.md` §4).

**D-012 — What leaves the engine.** Trace, terminal output and gap records go out through
write-only ports and are not world state. The engine keeps no screen and no scrollback. The
trace is never read by engine logic or by checks.

**D-013 — Session start time.** The virtual clock starts at a time given in the session header.
Interactive sessions take the real current time once, in the app, and record it; headless runs
use the item's `startTime` or a fixed default. Replay is unaffected because the value is data.

**D-014 — Curriculum records.** The PDFs are kept in `docs/curriculum/` because the cncf/curriculum
repository licenses them CC-BY 4.0. Competency ids (`cka.troubleshooting.clusters-nodes`) are
assigned in `competencies.yaml`, keeping the two ids `PLAN.md` §8 already uses.

**D-015 — The gate today.** `npm run check` is typecheck, lint and tests. Content validation
joins it in phase 09 with the first items; until then a test validates the worked examples in
`docs/SCENARIO_FORMAT.md` against `docs/schema/`.

**D-016 — Small format decisions.** Checks have `title`, `not`, `within` and `after`; steps have
`until` with a required timeout; a string that is exactly one placeholder takes the parameter's
type; sidecar source hashes are the first 16 hex digits of a SHA-256 over the normalized English
unit (`docs/SCENARIO_FORMAT.md` §4, §6, §7, §12).

## Workstation move (2026-11-15)

**D-017 — Continue on the new workstation as it is.** After phase 00 the owner moved the project
to another machine and asked for the plan, docs and prompts to be adapted to it. It runs Pop!_OS
24.04 (an Ubuntu 24.04 derivative) with Node 26.13.1, bash 5.2.21, GNU coreutils 9.4, systemd 255
and OpenSSL 3.0.13; the full list is in `docs/FIDELITY.md` §2.1.
- Node 26 instead of 24: `engines` already said `>=24`, D-004 works the same on 26, and the gate
  passes with the locked dependencies. `@types/node` stays at 24.19.2 because engine sources
  compile without Node types; move it when a tool or test needs a newer Node API.
- Rank 3 references are this machine's tools, captured in a clean `env -i … bash --noprofile
  --norc` because the agent's shell runs ugrep for `grep` and bfs for `find`. Nothing was captured
  on the previous machine, so no existing reference is affected. Provenance comments name the tool
  version, so a later move only needs a recapture where output differs.
- Formats come from this machine; Ubuntu-server contents (os-release, apt sources and priorities,
  default units) do not, because Pop!_OS changes them.
- Rules out: installing a second Node version to match the old machine, and copying Pop!_OS
  specifics into simulated hosts.
