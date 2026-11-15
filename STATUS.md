# Status

How to run a phase: open a new Claude Code session in this folder and send
`Execute the phase in prompts/<file>.md`. One phase per session. Each session updates this file.

Run phases in the order listed. Numbers group topics; a letter suffix means a topic was split to
fit one session. Notes in parentheses say where the order is flexible.

Legend: `[ ]` not started · `[~]` partly done, see carry-over · `[x]` done

## Phases

**M0 — Foundations**
- [x] 00 `prompts/00-bootstrap-and-specs.md`

**M1 — Thin vertical slice**
- [ ] 01 `prompts/01-kernel-and-vfs.md`
- [ ] 02 `prompts/02-shell-and-coreutils.md`
- [ ] 03 `prompts/03-tty-and-terminal-player.md`
- [ ] 04 `prompts/04-oracle-and-golden-fixtures.md` (needs only 00; can run earlier)
- [ ] 05a `prompts/05a-k8s-api-store-and-pipeline.md`
- [ ] 05b `prompts/05b-k8s-controllers.md`
- [ ] 06a `prompts/06a-topology-and-scheduler.md`
- [ ] 06b `prompts/06b-kubelet-runtime-behavior-models.md`
- [ ] 07a `prompts/07a-kubectl-framework-and-get.md`
- [ ] 07b `prompts/07b-kubectl-describe-apply-delete.md`
- [ ] 08 `prompts/08-kubectl-2.md`
- [ ] 09 `prompts/09-scenarios-and-first-labs.md`
- [ ] 10 `prompts/10-web-app.md`
- [ ] **Checkpoint A** — play the three labs, write `FEEDBACK.md`, then run `prompts/R3-feedback-and-gap-triage.md`

**M2 — Learning loop**
- [ ] 11 `prompts/11-learning-core.md`
- [ ] 12 `prompts/12-learning-ui.md`
- [ ] 13 `prompts/13-xray-and-time-controls.md`
- [ ] 14 `prompts/14-curriculum-map-and-authoring.md`
- [ ] R1 run, target `k8s-foundations`
- [ ] **Checkpoint B** — use the daily session for a week, write `FEEDBACK.md`, run R3

**M3 — Application-level Kubernetes**
- [ ] 15 `prompts/15-kubectl-3.md`
- [ ] 16a `prompts/16a-pod-configuration-and-volumes.md`
- [ ] 16b `prompts/16b-probes-resources-security.md`
- [ ] 17 `prompts/17-exec-and-network-model.md`
- [ ] 18a `prompts/18a-job-cronjob-daemonset-statefulset.md`
- [ ] 18b `prompts/18b-strategies-metrics-autoscaling.md`
- [ ] 19a `prompts/19a-service-types-and-networkpolicy.md`
- [ ] 20a `prompts/20a-identity-and-rbac.md`
- [ ] 20b `prompts/20b-admission-quotas-scheduling-policy.md`
- [ ] 20c `prompts/20c-crds-operators-deprecations.md`
- [ ] 19b `prompts/19b-ingress-and-gateway-api.md` (after 20c: Gateway API resources are CRDs)
- [ ] 21 `prompts/21-storage.md`
- [ ] 22a `prompts/22a-shell-control-flow-and-text-tools.md` (any time after 03)
- [ ] 22b `prompts/22b-awk-jq-pager.md` (any time after 22a)
- [ ] 23 `prompts/23-kustomize-and-image-builds.md`
- [ ] 24 `prompts/24-helm.md`

**M4 — Node-level Kubernetes**
- [ ] 25a `prompts/25a-systemd-processes-ssh.md`
- [ ] 25b `prompts/25b-packages-sysconfig-pki.md`
- [ ] 26a `prompts/26a-kubelet-and-runtime-on-nodes.md`
- [ ] 26b `prompts/26b-crictl-and-node-operations.md`
- [ ] 27 `prompts/27-control-plane-static-pods.md`
- [ ] 28 `prompts/28-etcd-and-certificates.md`
- [ ] 29a `prompts/29a-kubeadm-init-and-join.md`
- [ ] 29b `prompts/29b-kubeadm-upgrade.md`
- [ ] 29c `prompts/29c-ha-control-plane.md`
- [ ] 30 `prompts/30-cluster-networking-troubleshooting.md`

**M5 — Exams, fidelity, extensibility**
- [ ] 31 `prompts/31-exam-mode.md` (possible after 14; worth it once several R1 runs exist)
- [ ] 32 `prompts/32-golden-tier-2-and-fidelity-audit.md` (optional; capture needs a machine with Docker)
- [ ] 33 `prompts/33-update-check.md` (any time after 14)
- [ ] 34 `prompts/34-linux-pack-and-domain-guide.md` (any time after 25b)
- [ ] 35 `prompts/35-coach-skill.md` (any time after 14)

## Repeatable prompts

Edit the target line at the top of the prompt file, or name the target in your message
(`Execute prompts/R1-content-pack.md for target ckad-deployment`).

- `prompts/R1-content-pack.md` — content for one area. Interleave runs with engine phases once the
  features a target needs exist. Runs completed: none
- `prompts/R2-translation-pass.md` — Vietnamese translation. Runs completed: none
- `prompts/R3-feedback-and-gap-triage.md` — fix what `FEEDBACK.md` and the gap log report
- `prompts/R4-new-domain.md` — add a domain (three stages)
- `prompts/R5-version-bump.md` — move to a new Kubernetes version

## Temporary shortcuts in the engine

Seeded or simplified behavior that a later phase must replace. Each session adds and removes entries.

None yet.

## Carry-over

Unfinished work from a phase, precise enough for the next session to continue. None yet.

## Handoff notes

Newest first. Each session adds: what was built, decisions made, surprises, known gaps.

- 2026-11-15 — **Moved to a new workstation.** No phase work. The plan, docs and prompts were
  checked for anything tied to the old machine and adapted (`docs/decisions.md` D-017, `PLAN.md`
  §15). Phase 01 is next and needs nothing else first.
  - The workstation is now Pop!_OS 24.04 (an Ubuntu 24.04 derivative) on x86_64 with Node 26.13.1
    through nvm, npm 11.20, bash 5.2.21, GNU coreutils 9.4, systemd 255, OpenSSL 3.0.13, gawk and
    mawk, jq 1.7.1, BIND's `nslookup`/`dig`/`host`, Go 1.27.4 and Python 3.12.3. Not installed:
    `kubectl`, Docker, kind. The full table is `docs/FIDELITY.md` §2.1, which is now the one place
    that records the workstation.
  - Restored the ignored state with `npm ci` and `npm run upstream:fetch` (v1.37.2 at `c50e5395`,
    192 MB). `npm run check` passes on Node 26: 13 test files, 73 tests. `stable-1.37.txt` still
    says v1.37.2, and all five oracle binaries answer on dl.k8s.io. `npm ci` reports 9 moderate
    advisories in development dependencies, as before.
  - Changed: `PLAN.md` §11 runtime says Node 24 or later; D-004 wording; `docs/FIDELITY.md` §1
    (kubectl note, recheck) and §2 (rank 3 row, new §2.1); prompts 01, 02, 17, 22a, 22b, 25a and
    25b name what is really installed here; `CLAUDE.md` gains `npm ci`, reads `memory/MEMORY.md`
    at the start of a session, points rank 3 at §2.1, and has the fix-freely rule.
  - Surprises: in the agent's shell, `grep` runs ugrep and `find` runs bfs (Claude Code shims), and
    oh-my-zsh aliases `ls`, `grep` and `diff`. Capture ground truth in the clean bash from
    `docs/FIDELITY.md` §2.1. Pop!_OS pins its own apt repository at priority 1001, so
    `apt-cache policy` priorities here are not a stock Ubuntu server's. Installing `gawk` made it
    the system `awk`; a stock Ubuntu server's `awk` is mawk (`/usr/bin/mawk`), so phase 22b calls
    each by name. No rank 3 reference was captured on the old machine, so nothing needs recapturing.
  - The old machine (`ssh colcv-thinkpad-t440p`, Ubuntu 26.04.1) was checked read-only. Its
    checkout, `~/projects/learning-platform`, is at the same commit `baaf61e`, clean and in sync
    with `origin/main`; its only ignored contents are `node_modules/`, `.upstream/` and `.tsbuild/`.
    Nothing was left behind.
  - Memory: the old machine's local Claude memory held only a redirect to the repository's
    `memory/` (in place since 2026-11-04); the same redirect now exists in this machine's local
    memory, and `CLAUDE.md` says to read `memory/MEMORY.md`. Two memories from the earlier Go
    version of the project were lost in the 2026-11-13 restart and are restored: the standing
    permission to fix wrong or stale things without asking (owner confirmed; also in `CLAUDE.md`
    under "During") and the zsh glob pitfall (rechecked here). Not restored: the owner profile
    (`PLAN.md` §1 covers it, and its "Vietnamese docs" part was superseded on 2026-11-13) and a
    `/tmp` quota note (the old machine's `/tmp` was a 7.5 GB tmpfs; here it is on the root disk).
- 2026-11-13 — **Phase 00 done.** Repository, gate, pin, upstream fetch and the specs exist.
  - Built: npm workspaces (`packages/*`, `apps/*`, `tools`) with TypeScript 6.0.3 strict and
    project references, Vitest 5, ESLint 10. `npm run check` = typecheck + lint + tests.
    Two lint rules in `tools/eslint/plugin.js` with 15 fixtures. `npm run upstream:fetch`.
    `docs/ARCHITECTURE.md`, `docs/SCENARIO_FORMAT.md`, `docs/FIDELITY.md`, `docs/decisions.md`,
    `docs/curriculum/`, `docs/schema/`.
  - The pin is **v1.37.2** (not 1.37.1 as the plan said; 1.37.2 was released since). Constant:
    `packages/k8s/src/version.ts`. Phase 04 downloads 1.37.2 binaries; they answer on dl.k8s.io.
  - Read `docs/decisions.md` before phase 01. The ones that shape code: no build step, packages
    export `.ts` and relative imports end in `.ts` (D-004); world state is containers plus
    frozen values, fork shares values (D-008); programs are synchronous generators, actors are
    event handlers, no `async` in the engine (D-009); extension contracts live in `kernel` (D-010).
  - Check syntax in items is `assert: <name>` + `with: {…}`; the one-line form in the plan was
    not valid YAML (D-002).
  - Surprises: TypeScript 7 is `latest` on npm but `typescript-eslint` does not support it yet.
    Engine sources compile with `types: []` and `lib: ES2024`, so `console`, `setTimeout` and Node
    APIs fail the type check as well as lint; tests have their own `tsconfig.test.json` with Node
    types. `.upstream/` is about 190 MB.
  - Known gaps: `docs/schema/item.schema.json` is maintained by hand until phase 09 generates the
    check, fault and step catalogs from the registry. `docs/ARCHITECTURE.md` §6 lists what each
    phase still decides. The pipeline stage order in §4.2 restates the plan and must be verified
    against upstream in phase 05a. The worked examples are validated for structure only; nothing
    runs them until the engine exists.
  - `npm install` reports moderate advisories in development dependencies (lint and test
    tooling); nothing ships to a runtime. Not acted on.
- 2026-11-13 — Plan, phase prompts and CLAUDE.md written. No code exists. The folder is not a git
  repository yet; phase 00 initializes it. (This describes the previous workstation; see
  2026-11-15.) The workstation is Ubuntu 26.04 on x86_64 with Node 24,
  npm, Python 3.14, git, make, bash 5.3, OpenSSL 3.5, vim and kubectl 1.36.3. It has no Docker,
  kind, Go or pnpm. The v1.37.1 release binaries on dl.k8s.io are reachable (checked for
  kube-apiserver and kube-scheduler), which phase 04 relies on.
