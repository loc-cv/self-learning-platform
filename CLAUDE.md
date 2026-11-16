# Simlab

A local, single-user platform for learning infrastructure by doing, inside a simulated environment.
The first domain is Kubernetes (CKA and CKAD on v1.37). There are no real clusters behind it: a
deterministic state engine models machines, shells and Kubernetes, and a learning layer schedules
practice with spaced repetition.

- `PLAN.md` — goals, principles, architecture decisions, roadmap. The source of truth.
- `STATUS.md` — which phase is done, carry-over work, handoff notes. Read it at the start of every session.
- `prompts/` — one prompt per phase, plus repeatable prompts (`R1`–`R5`).
- `docs/` — detailed specs, written and kept current by the phases that build each subsystem.
- `memory/` — standing preferences and feedback from the owner; `memory/MEMORY.md` is the index.
  Save new feedback here, in the repository, so it moves with the project; machine-local memory
  doesn't.

## Commands

If one changes, change this section in the same commit. Commands marked with a phase do not
exist yet; that phase adds them.

```bash
npm ci                        # fresh clone or new machine: install the locked dependencies
npm run check                 # the gate: typecheck, lint, unit tests (content validation joins in phase 09)
npm run typecheck             # tsc -b over all project references
npm run lint                  # eslint, including simlab/package-boundaries and simlab/engine-determinism
npm test                      # all unit tests
npm test -w packages/k8s      # one package
npx vitest run <file> -t "<name>"   # one test
npm run upstream:fetch        # fetch pinned upstream sources (Kubernetes, containerd, runc, Go) into .upstream/
npm run bench:fork            # time fork, hash, snapshot and restore of a three-machine world
npm run bench:schema          # size and load time of the vendored API schema and resource registry
npm run bench:kubectl         # wall-clock latency of kubectl get (p50/p95) on the default topology
npm run api:vendor [-- --check]   # regenerate the vendored schema (OpenAPI v3 + Go types) and registry (discovery fixture)
npm run transcript:capture -- <file|dir>  # write real bash/coreutils output into golden-verified transcripts
npm run transcript:capture -- --check     # compare every golden-verified transcript with the real tools
npm run dev                   # (phase 10) web app with hot reload
npm start                     # (phase 10) build, then serve the app and the persistence API locally
npm run play -- --topology kubeadm-1cp-2w [--seed N]  # sit in a simulated machine from this terminal (Ctrl-] leaves);
                                                  # records to data/play/, $EDITOR answers vim/nano
npm run play -- --replay <file>                   # replay a recording; checks it reaches the same world hash
npm run sim -- --topology kubeadm-1cp-2w -c 'cmd1\ncmd2'  # run commands without a human and print the screen (how you
                                                  # verify behavior); also a script file or -, --transcript, --raw,
                                                  # --step 1s; directives @advance 30s, @keys \x03, @resize CxR,
                                                  # @editor <<EOF … EOF (see apps/cli/src/script.ts, --help);
                                                  # --file FILE[,FILE] puts local files (manifests) into
                                                  # the session user's home first
npm run lab -- <item-id> [--seed N]               # (phase 09) play a content item in this terminal
npm run content:check         # (phase 09) validate every content item (schema, unsolved fails, solutions pass)
npm run content:i18n          # (phase 11) report missing or outdated Vietnamese text (never a gate)
npm run oracle -- up|status|fetch        # throwaway real control plane (v1.37.2 binaries + KWOK), no Docker;
npm run oracle -- down|env [<dir>]       # several can run: each up prints its directory, which down and env take
npm run golden:capture -- [--check] [<case|dir>]  # run golden cases against fresh oracles, write fixtures
npm run golden:kubectl-manifest [-- --check|--vendor]  # every kubectl command, flag and help text of the pin,
                                  # from the real binary; also writes the engine's copy (kubectl/data/)
npm run golden:diff           # differential runner: golden cases replayed in the simulator, per-step report
npm run kubeadm:capture [-- --check]   # what the real kubeadm init writes and creates (dry run, unprivileged),
                                      # into fixtures/reference/kubeadm/ and packages/k8s/src/topology/kubeadm/reference.ts
npm run images:capture [-- --check]    # what Docker Hub and registry.k8s.io answer for the listed images (digests, configs,
                                      # files, errors), into fixtures/reference/images/ and packages/k8s/src/runtime/images/catalog.data.ts
npm run fidelity:report       # provenance of every output unit (docs/FIDELITY.md §3)
npm run coverage:generate [-- --check]   # write docs/COVERAGE.md's generated kubectl section from the
                                         # manifest and the registrations (the gate fails when stale)
node tools/src/strategicpatch/extract-tests.ts [--check]  # copy upstream's patch_test.go tables into
                                         # apimachinery/strategicpatch/testdata/ (needs .upstream)
```

Packages export TypeScript source and there is no build step: relative imports end in `.ts`, and
tools run as `node tools/src/<tool>.ts`. The Kubernetes pin is `KUBERNETES_VERSION` in
`packages/k8s/src/version.ts`.

## Layout

```
packages/kernel    virtual clock, event queue, world state, snapshot/replay, PRNG, plugin registry, trace
packages/host      simulated Linux machines: VFS, shell, TTY, coreutils, systemd, processes;
                   src/models behavior models (the contract, the container shell, utilities, image programs)
packages/k8s       Kubernetes plugin: API machinery, controllers, scheduler, kubelet, network, kubectl, kubeadm, …
                   (src/apiserver pipeline and store, src/registry strategies, src/apis defaulting and
                   validation, src/apimachinery Go JSON and errors, src/openapi and src/discovery vendored data,
                   src/controllers runtime, event recorders and one directory per controller,
                   src/scheduler kube-scheduler (cycle, plugins, queueing hints), src/topology cluster
                   topologies (ClusterDef data, builder, kubeadm files and objects), src/kubelet the
                   kubelet (pod workers, status, node heartbeat), src/runtime the container runtime
                   (sandboxes, containers, CRI logs) and src/runtime/images the captured image catalog,
                   src/kubectl kubectl (cli/ cobra and pflag ports, client/ kubeconfig, transport and
                   REST mapper, resource/ the builder and the -f reader, cmd/ one module per verb,
                   describe/ the describers, util/ the last-applied annotation, help/, printers/ the
                   table printer and tab writer, data/ the vendored command manifest),
                   src/printers the API server's Table printers, src/apimachinery/yaml go-yaml and
                   sigs.k8s.io/yaml (kubectl's YAML/JSON output and manifest parsing),
                   src/apimachinery/strategicpatch strategic merge patch (server and three-way),
                   src/testing helpers for tests only: the fake kubelet, workload requests)
packages/learn     content model, scenario runner, checks, grader, skills, FSRS, progress log
packages/content   content packs (YAML + Markdown), topology templates
apps/web  apps/server  apps/cli
tools/             upstream fetch, OpenAPI processing (openapi/), oracle and golden capture, transcript capture,
                   coverage generation (coverage/), update check;
                   tools/eslint holds the two lint rules, their fixtures and the dependency table
docs/schema/       JSON Schema of content items and translation sidecars
docs/curriculum/   the official CKA and CKAD curricula the content is built against
packages/*/transcripts/  transcript tests (docs/TRANSCRIPTS.md), run by each package's transcripts.test.ts
fixtures/golden/   golden cases (cases/, the inputs) and captured, normalized real output per Kubernetes
                   version (v1.37.2/, committed); docs/FIDELITY.md §6
fixtures/reference/ workstation captures (rank 3) with their capture scripts, e.g. linux/vfs-syscalls,
                   bash/readline (real readline output key by key, bind -p); also kubeadm/ (the real kubeadm
                   init's files and objects, rank 1, from tools/src/kubeadm/capture.ts)
```

Dependencies point one way: `kernel` ← `host` ← domain plugins. `learn` imports `kernel` only, never
a domain. Plugins register their checks, faults and topologies with `learn` through the registry.
Engine packages use no DOM and no Node APIs; they run in a Web Worker and in Node.

## Hard rules

These protect what makes the platform worth using. Breaking one is a bug even if tests pass.

1. **State engine.** Commands read and mutate the world model; controllers reconcile it. Never
   special-case a scenario in engine code and never return canned output for a command.
2. **Never fake reality.** Input the simulator doesn't support prints a `[sim]` notice and is
   written to the gap log. Don't invent an error message the real tool wouldn't print, and don't
   silently accept and ignore a flag.
3. **Ground every user-visible string in a source.** Table columns, `describe` layouts, event
   reasons and messages, and error text come from a golden capture of the real binaries (the local
   oracle, `docs/FIDELITY.md`), upstream source at the pinned version (`.upstream/`), the real tool
   on this workstation (bash, coreutils, systemd; versions and the clean-shell capture procedure in
   `docs/FIDELITY.md` §2.1), or official docs. Don't write them from memory.
   Cite the source next to the code and register the unit's provenance.
4. **Deterministic engine.** No `Date`, `Math.random`, timers or real I/O in engine packages. Use
   the kernel clock and named PRNG streams. Iterate in a defined order.
5. **World state is plain serializable data.** No class instances, closures, Maps or Sets inside
   it. Pending events are `type` plus payload.
6. **Grade state, not commands.** Checks assert on final state or observable behavior. Every
   content item must fail its checks untouched and pass with each reference solution, for several seeds.
7. **No feature without a test and a consumer.** Commands get transcript tests; controllers get
   simulation tests in virtual time; each new engine feature is used by at least one content item.
8. **The core stays domain-agnostic.** Nothing Kubernetes-specific in `kernel`, `host` or `learn`.

## Session protocol

**Start.** Read `STATUS.md` and `memory/MEMORY.md`. If `STATUS.md` lists carry-over for the phase
you were given, do only that. Read the parts of `PLAN.md` and `docs/` the phase prompt names. If
`node_modules/` or `.upstream/` is missing (fresh clone, new machine), run `npm ci` and
`npm run upstream:fetch` first. From phase 01 on, run
`npm run check` to confirm a green baseline before changing anything; if it is red, fix or report
that first.

**During.**
- Work in small steps and keep tests green. Write the test or transcript first when the expected
  output is known from a source.
- Protect your context. Delegate bulky reading (upstream source files, long logs) to a subagent and
  keep its conclusion. Read upstream files by targeted search, not whole.
- If the phase can't be finished at full quality in this session, stop at a coherent boundary with
  the gate green. Don't cut quality to fit. Record exactly what remains under Carry-over.
- A shortcut that a later phase must replace (seeded objects, an assumed-healthy component) goes in
  `STATUS.md` under "Temporary shortcuts" with the phase that removes it.
- Never run anything that changes this workstation outside the repository (package installs,
  sysctl, services). Reading real tools' output for ground truth is fine.
- A design decision that contradicts `PLAN.md` or a spec: stop and ask. One that only fills a gap:
  decide, and write it down in `docs/decisions.md`.
- Anything in the repository that is wrong or no longer relevant (code, docs, comments, prompts,
  this file): fix it without asking, even outside the current task, and list it in your report and
  the handoff note. The rules here still apply to the fix. It does not cover design: contradicting
  `PLAN.md` or reopening a recorded decision still needs the owner, though a wrong fact in a
  decision's reasoning can simply be corrected. (Granted 2026-11-04, confirmed 2026-11-15.)

**End.**
1. `npm run check` is green. Show the output; don't claim it.
2. Verify the phase's exit criteria one by one and say which pass. Exercise the behavior for real
   (terminal player, browser), not only through unit tests.
3. Update the docs you changed the truth of, and this file if commands or layout changed.
4. Update `STATUS.md`: mark the phase, list carry-over, add handoff notes for the next session
   (surprises, decisions, known gaps).
5. Commit to the current branch as `[<plan>] phase NN: <summary>`, where `<plan>` is the slug of
   the plan the work belongs to. `PLAN.md` is `master-plan`: `[master-plan] phase 07a: …`,
   `[master-plan] R3: …`. A new plan gets its own slug, recorded here. A phase prompt authorizes
   commits; never push.

## Code conventions

- TypeScript strict, ES modules, no `any` without a comment explaining why. Prefer plain functions
  and data over classes.
- Small files with one job. Name things after the real system's terms (`ReplicaSet`, `kubelet`,
  `FailedScheduling`), not invented ones.
- Dependencies: pinned exact versions, as few as possible, nothing fetched at runtime.
- Comments explain why and cite upstream (`// upstream: pkg/printers/internalversion/printers.go printPod`).
- Errors a learner can see are part of the product: test them like any other output.

## Content conventions

- Items live in `packages/content/<pack>/`; the format is specified in `docs/SCENARIO_FORMAT.md`
  and the style in `docs/AUTHORING.md` (from phase 12).
- English is canonical. Vietnamese goes in `<id>.vi.yaml` sidecars and reads naturally for a
  Vietnamese DevOps engineer; resource names, commands, flags, paths and code stay in English.
- Tickets describe a goal or a symptom the way a real ticket would, never the commands to type.
- Every item names its skills and curriculum competencies, has a hint ladder, a debrief with the
  mental model and "in reality" notes, parameters for variation, and at least one reference solution.

## Things that are deliberately absent

No real containers or clusters, no network calls at runtime, no LLM calls in the app, no accounts,
no documentation website, no Vietnamese design docs. See `PLAN.md` §4.3 before adding any of these.
