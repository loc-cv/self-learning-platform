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
- [x] 01 `prompts/01-kernel-and-vfs.md`
- [x] 02 `prompts/02-shell-and-coreutils.md`
- [x] 03 `prompts/03-tty-and-terminal-player.md`
- [x] 04 `prompts/04-oracle-and-golden-fixtures.md` (needs only 00; can run earlier)
- [x] 05a `prompts/05a-k8s-api-store-and-pipeline.md`
- [x] 05b `prompts/05b-k8s-controllers.md`
- [x] 06a `prompts/06a-topology-and-scheduler.md`
- [x] 06b `prompts/06b-kubelet-runtime-behavior-models.md`
- [x] 07a `prompts/07a-kubectl-framework-and-get.md`
- [x] 07b `prompts/07b-kubectl-describe-apply-delete.md`
- [x] 08 `prompts/08-kubectl-2.md`
- [x] 09 `prompts/09-scenarios-and-first-labs.md`
- [x] 10 `prompts/10-web-app.md`
- [x] **Checkpoint A** — played 2026-11-16; R3 run 2026-11-17 (`docs/feedback-log.md`). Verdict: the
  terminal feels real; the product is all text and looks bland. The visual layer therefore comes
  next (`PLAN.md` §15)
- [x] 10b `prompts/10b-visual-foundation.md`
- [x] 10c `prompts/10c-figures-and-scenes.md`
- [x] **Checkpoint A2** — played 2026-11-17; R3 run the same day (`docs/feedback-log.md`). Verdict:
  nothing against the figures or what the X-ray shows; the interface looks dated, the lab panel is
  one long scroll, the docked X-ray takes the terminal's width. Three bugs fixed by R3; the rest is
  phase 10d (`PLAN.md` §15)
- [x] 10d `prompts/10d-interface-refresh.md`

**M2 — Learning loop**
- [x] 11 `prompts/11-learning-core.md`
- [x] 12 `prompts/12-learning-ui.md`
- [ ] 13 `prompts/13-trace-replay-and-time-controls.md`
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
- `prompts/R3-feedback-and-gap-triage.md` — fix what `FEEDBACK.md` and the gap log report. Runs
  completed: 2026-11-17 after Checkpoint A; 2026-11-17 after Checkpoint A2 (`docs/feedback-log.md`)
- `prompts/R4-new-domain.md` — add a domain (three stages)
- `prompts/R5-version-bump.md` — move to a new Kubernetes version

## Temporary shortcuts in the engine

Seeded or simplified behavior that a later phase must replace. Each session adds and removes entries.

- **Link protections are constants** (`PROTECTED` in `packages/host/src/vfs/fs.ts`: Ubuntu's
  `protected_hardlinks = 1`, `protected_symlinks = 1`, `protected_regular = 2`). Phase 25b reads
  them from the machine's sysctl table.
- **`/proc` and `/sys` are empty directories, and `/dev` holds only `null`.** `ls /proc` prints
  nothing, which no real machine does. Phase 25a makes `/proc` a provider mount with processes;
  `/dev` entries come with the phases that need them (`/dev/tty` and `/dev/pts/N` with the first
  consumer, at the latest phase 25a's `tty` and `ps` TTY column; phase 03 did not need them;
  `/dev/zero` and `/dev/urandom` produce binary data, DIV-002, and wait for a consumer).
- **No `/etc/shadow`, `/etc/gshadow` or `/etc/hosts`** (D-020). Shadow files come in phase 25a
  with passwords, `su` and `sudo`; `/etc/hosts` in phase 17.
- **Startup files are not read** (D-025, DIV-003): a login shell starts as `bash --noprofile
  --norc`, so Ubuntu's `ll`/`la` and `--color=auto` aliases do not exist. Phase 22a (control flow)
  sources `/etc/profile`, `~/.profile` and `~/.bashrc`, and then removes two stand-ins:
  - the login prompt is set by `packages/host/src/shell/startup.ts` to what Ubuntu's `~/.bashrc`
    would leave (D-031);
  - bash-completion (which Ubuntu's `.bashrc` loads) is reproduced by completers: builtin ones in
    `shell/complete.ts` (`cd`, `pushd`) and `ProgramSpec.complete`. These stay after 22a, since our
    bash will not run bash-completion's scripts; 22a only stops pretending the files ran.
  - kubectl completes as if `source <(kubectl completion bash)` and
    `complete -o default -F __start_kubectl k` were in `.bashrc` (D-090): on every machine, and
    through any alias whose value starts with a program that has a completer. 22a replaces this
    with the `complete` lines the startup files actually hold.
- **Default admission plugins other than NamespaceLifecycle are missing** (D-039): new Pods get
  no `serviceAccountName: default`, `kube-api-access-*` volume and mount (ServiceAccount), no
  not-ready/unreachable tolerations (DefaultTolerationSeconds), no `priority`/`preemptionPolicy`
  (Priority); new Nodes no `node.kubernetes.io/not-ready:NoSchedule` taint (TaintNodesByCondition).
  The differential tests strip exactly these fields (D-046, `POD_ADMISSION` in
  `tools/src/golden/api.test.ts`, `NOT_THE_API_SERVERS` in `defaulted.test.ts`, one KNOWN entry
  for the Node). Phase 20b adds the plugins and removes the stripping.
- **The API server is bootstrapped by the topology** (`bootstrapApiServer` in `topology/build.ts`,
  with `apiServerConfig(def)`, which equals `DEFAULT_APISERVER` for both topologies, and recorded in
  `k8sSlice.apiServers`). Phase 27 reads etcd id, service range, NodePort range, advertise address
  and secure port from the static Pod manifest's flags and starts the server as a process.
- **The API server's own reconcilers do not run**: deleting the `kubernetes` Service, its
  Endpoints or EndpointSlice does not bring them back (upstream re-creates them every 10 s), and
  the `kubernetes` ServiceCIDR has no servicecidrs-controller finalizer. Phase 27 (the API server
  as a process with its loops), or 05b if a controller needs them first.
- **kube-controller-manager and kube-scheduler are started by the topology** (`startControllerManager`,
  every registered controller, no flags; `startScheduler`, the default profile). Phase 27 starts and
  stops them with their static Pods' processes and reads `--controllers` and the scheduler's flags.
- **Node health monitoring stops at NotReady** (D-063, DIV-026): no NoExecute taints and no
  taint-based eviction, because DefaultTolerationSeconds is missing. Phase 20b adds the admission
  plugin, the NoExecute pass and the taint-eviction controller together.
- **The control plane's mirror Pods are created by the topology with running containers in the
  runtime** (`topology/kubeadm.ts` seedStaticPods, `kubelet/seed.ts`, a stand-in config hash,
  DIV-019). Phase 27 creates them through the kubelet from `/etc/kubernetes/manifests`.
- **kube-proxy's DaemonSet Pods and the DaemonSet's status are seeded** (seedDaemonSetPods, as the
  DaemonSet controller would create them, with running containers). Phase 18a's DaemonSet
  controller creates and updates them.
- **The kubelets are started directly by the topology** (`startKubelet` in `topology/build.ts`),
  not by `kubelet.service`; their configuration is not read from `/var/lib/kubelet/config.yaml`.
  Phase 26a ties them to the unit and its flags and config.
- **Control-plane, kube-proxy and CoreDNS containers run the stand-in model `component`**: no
  output, exit 0 on SIGTERM (DIV-028). Phase 27 (static Pods as processes) and phases 17/30
  (kube-proxy, CoreDNS) give them real models.
- **Pods with init containers stay Pending** (DIV-021) and **`valueFrom`/`envFrom` variables are
  left out** (DIV-022): phase 16a. **Probes are not run** (ready when running, DIV-023): phase 16b.
- **Containers have no filesystem** beyond the captured executable tables (DIV-029): writes are
  discarded with a gap, `cat` of a file is a gap. Phase 16a (volumes) or 17 (exec).
- **Pod IPs come from host-local IPAM in the node's Pod CIDR** with no CNI agent (D-059). Phase
  29a installs the modeled CNI plugins.
- **The sandbox (pause) image is never pulled**: it is preloaded on every node. Phase 26a/29a, if
  a scenario removes it.
- **No certificates** (D-057): `/etc/kubernetes/pki` is not written, kubeconfigs and the
  `cluster-info` ConfigMap have no `*-data` lines (`users[].user` is empty), and the bootstrap
  token is never used. Phase 25b fixes the certificate format and fills them in; phase 28 checks them.
- **No RBAC objects**: kubeadm's Roles, ClusterRoles and bindings are not stored, since the API
  server serves no rbac.authorization.k8s.io kinds. Phase 20a creates them from
  `KUBEADM_OBJECTS` (the reference has them) when it adds the kinds.
- **No CNI agent**: Pod networking is assumed, Nodes have no NetworkUnavailable condition and
  `/etc/cni/net.d` is absent. Phase 29a installs the modeled plugins (and 30 breaks them).
- **No student workstation** in `kubeadm-1cp-2w` (D-055): added by phase 19a or 25a, whichever
  comes first.
- **Scheduler**: no preemption (phase 20b; with all priorities 0 there is never a victim, and a
  lower-priority Pod, which cannot exist yet, would record a gap); PodTopologySpread and
  InterPodAffinity are neither filtered nor scored (phase 20b, DIV-020).
- **No root-ca-certificate-publisher**: namespaces get no `kube-root-ca.crt` ConfigMap (the golden
  `controllers/namespace-deletion` shows it, and `kubectl get configmaps` lists it in every real
  namespace; `tools/src/golden/tables.test.ts` creates a stand-in). Phase 20a (service account
  credentials), or 16a if projected volumes need it first.
- **No `deletecollection` verb; controllers send JSON merge patches.** The namespace deleter uses
  upstream's list-and-delete fallback (D-050); deletecollection comes with the first client that
  sends it. Controllers send JSON merge patches where upstream sends strategic merge patches,
  with the same stored result (D-052); the pipeline applies strategic patches since phase 07b, so
  switching them is optional (R3, or the next phase that touches the controllers).
- **Controllers, the scheduler and kubelets call the pipeline directly**
  (`packages/k8s/src/client/client.ts`): no kubeconfig, credentials or network. kubectl goes
  through `kubectl/client/transport.ts` since 07a. Phase 27 (the API server as a process that can
  be down) routes the components' clients through the transport too.
- **Addresses are a list on the machine** (`Machine.addresses`, written by the topology from the
  `ClusterDef` IPs; D-068): clients resolve a server's host by it, an API server listens on all of
  its machine's addresses. Phase 17's network model (interfaces, listeners, DNS, `/etc/hosts`)
  replaces it; host names other than localhost print a notice until then.
- **kubeconfig credentials are ignored** (D-069): a user entry stands for the certificate it would
  hold, so kubectl never prompts for basic auth as the real one does for an https server with an
  empty user. Phases 20a (authentication) and 25b (certificate data) remove it.
- **The differential runner shims the kubectl verbs that are not simulated yet**
  (`tools/src/golden/kubectl/shim.ts`): setup and state-changing steps of golden cases are sent as
  the requests real kubectl sends. Each phase that builds a verb deletes its shim entries so the
  runner uses the simulated kubectl (07b removed create -f, apply and delete; 08 every verb it
  built). Left: `wait`, `patch` and the config mutators (15), `cordon`, `uncordon`, `taint` (26b).
- **The API server's `/version` is a constant** (`SERVER_VERSION_INFO` in
  `apiserver/nonresource.ts`, the pinned kube-apiserver's build info, D-087). The phase that
  upgrades the control plane (29b) moves it into the server's configuration.
- **The checks' JSONPath is a subset** (`packages/k8s/src/checks/jsonpath.ts`: fields with `\.`
  escapes, `[n]`, `[*]`, `.*`, `['key']`; other syntax makes a check an error). Phase 15 ports
  client-go's jsonpath for `-o jsonpath`; `where` and `paths` then use it.
- **Setups apply taints with `kubectl edit node`** (D-102), because `kubectl taint` waits for
  26b; `k8s.scheduling.pending-pods-01` does this. 26b may switch the setup to `kubectl taint`.
- **The runner refuses declared images** (`world.images`, `docs/SCENARIO_FORMAT.md` §5.4): the
  first item that needs an invented application image (16b or 17) adds declarative models.
- **Closed terminals stay in the world** as tty records with `closed: true` (setup logins leave
  them; `openTerminal` and the player skip ids in use). Invisible until `/dev/pts` exists; phase
  25a decides whether the kernel frees them.
- **The web app's gap records skip the server when it is not running** (a static host): the
  popover says so, nothing retries. The progress log and the attempt logs have outboxes since
  phase 12 (`apps/web/src/app/progress.ts`, `attempts.ts`); the gap sink was not given one. R3,
  or phase 13 when it touches the top bar.
- **No event records command errors** (`PLAN.md` §5, "repeated command errors … raise the
  priority of related items"): mistakes are failed attempts, failed checks, hints and solutions
  viewed. The debrief lists the shells' history since phase 12 (D-160); the event needs each
  command's exit status, which phase 13's trace has.
- **The command history in the debrief is the open shells' memory** (D-160): a closed terminal
  and the world before a reset take theirs with them. Phase 13's replay of the attempt from its
  input log replaces it.
- **The app's own words are English only.** The language setting covers content prose (PLAN §5);
  buttons, the home screen and skill, track and domain titles have no translations. No phase owns
  this; R2 translates content only.
- **`/bin/sh` is dash, which is not simulated**: `sh -c`, `egrep`, `fgrep`, `zgrep` and scripts
  without `#!` run through `env` reach the "not simulated" stub. No phase owns dash yet; R3 decides
  when learners hit it.

## Deferred by R3

Entries of `FEEDBACK.md` and the gap log that a triage run assigned to a planned phase. The phase
that takes one removes it here. Details and evidence: `docs/feedback-log.md`.

- **13** — the debrief replays the attempt with its causes.
- **16a** — nginx "built by" lines for every nginx tag in the catalog (16 gap records; the
  carry-over item "image facts read by hand" below is the same work).
- **18b** — `kubectl top` (1 gap record).
- **22a** — `alias k=kubectl` and kubectl completion preset in the session user's `.bashrc`, as on
  the exam's hosts (3 gap records); `vim` without a file name (2); the `for` loop (1). All three
  are in the phase's prompt. Also readline's `digit-argument` (Alt+digit; 1 gap record, Checkpoint
  A2), in the prompt too.
- **22b** — `less` (1 gap record).

## Candidates

Ideas worth keeping. Not commitments; none has a phase.

- An "about this figure" link from a view to the divergence register entry it depends on.
- The owner's Ctrl+Shift+1 does nothing on Windows and the cause is unknown; if another chord
  disappears the same way, make the workspace chords configurable.
- A notice in the editor when it loses focus with no pointer action, naming extensions that take
  Escape. Today the shortcut list explains it.

## Carry-over

Unfinished work from a phase, precise enough for the next session to continue.

- **Phase 06b, image facts read by hand.** The image models cite facts read from the image layers
  during the phase (nginx.conf's `error_log` level and `worker_processes`, the `built by gcc`
  strings of nginx 1.31.8 Debian/Alpine and 1.14.2, httpd.conf, the redis modules directory and the
  binaries' dirty flag) and the redis 6.2/7.x entrypoint script, which differs from the captured
  8.x one. Make `npm run images:capture` record them under `fixtures/reference/images/` (configs,
  `strings` of the binaries, the older entrypoint) and point the citations at the fixtures. Owner:
  the next phase that touches images (09, 16a), or R3.
- **Phase 06b, model inputs the runtime does not give yet.** `ProcessInput` has no kernel release
  or file-descriptor limit, so `packages/host/src/models/images/common.ts` holds them as constants
  (`NODE_KERNEL_RELEASE` = the topology's 6.8.0-88-generic, `CONTAINER_NOFILE`); and `file()`
  returns nothing, so httpd's AH00558 (needs `/etc/hosts`) is a gap. Add the fields when containers
  get files (16a/17).

- **Phase 07b, tie order in describe (DIV-036).** Port Go's pdqsort (`sort.Sort`, `sort.Slice`;
  `src/sort` is now in the Go checkout, `tools/src/upstream/paths.ts`) and use it where describe
  sorts events and tolerations, so more than 12 equal keys order as upstream. Owner: R3 or 15.
- **Phase 05a, the Pod update diff (DIV-016).** Optional: generate the internal PodSpec layout
  from `pkg/apis/core/types.go` with `tools/src/openapi/gotypes.ts` and port go-difflib's unified
  diff into `apis/core/validation/podspecdiff.ts`. Owner: R3 if learners report it.

- **Phase 07a, provenance of the host's programs.** The registry exists (`provenance`
  contributions, `npm run fidelity:report`), and every kubectl, printer, YAML/JSON and help unit is
  registered (45 units). The host's programs and shell (coreutils, grep, bash, the line editor,
  the `[sim]` notice itself) register nothing yet. Add `HOST_PROVENANCE` next to them, tagged
  `golden-verified` where a golden-verified transcript covers the program, and a test like
  `packages/k8s/src/provenance.test.ts` that every registered program has a unit. Owner: the next
  phase that touches host programs (22a), or R3.
- **Phase 07a, a YAML print failure during `get -w`.** `printGeneric` turns a YamlMarshalError
  into kubectl's `error: …`; the watch path does not catch it yet (real kubectl prints
  `unable to output the provided object: …` for the first object and returns the error for
  events). Only reachable with control characters in a watched object. Owner: 15 (output formats) or R3.

- **Phase 02, program names in messages (DIV-011).** GNU tools print their `argv[0]` as typed.
  `programs/lib/io.ts` (`parseArgs`, `warn`, `usageError`), `lib/argmatch.ts` and about 25 programs
  that write `${p.name}:` use the base name instead, and the captured `--help` texts hard-code
  `Usage: <name>`. Fix by giving `ProcApi` the invocation name (argv[0], without a login dash)
  and using it in those helpers, programs and help texts (misc's echo/printf/test already
  substitute argv[0] with a `\u0000` placeholder; copy that). Add a transcript that runs
  `/usr/bin/sleep x` and `/bin/cat --help | head -1`. Owner: the next session that touches
  coreutils, or R3.

- **Phase 08, small gaps left as notices.** `kubectl apply edit-last-applied`; `kubectl edit` of
  kinds without a built-in type (a JSON merge patch) and `--subresource` other than `status`;
  container completion after a non-Pod `type/name` (DIV-042); zsh, fish and PowerShell
  completion scripts; `run --overrides` text that is not valid JSON (encoding/json's syntax error
  texts are not ported); `explain -o plaintext-openapiv2` and jsonpath syntax beyond fields, `..`
  and `*`; the other `create` subcommands (their types are not stored). Source-derived without a
  golden step: edit's retry and deleted-object endings, `scale --timeout`'s error, every kubelet
  log error (the oracle has no kubelet). Owner: 15 for edit, overrides and the formats; the phase
  that stores each type for its `create`; 17 for container completion; R3 otherwise.
- **Phase 08, the vendored schema has no enums.** `FieldSpec.enum` (`en` in
  `openapi/data/v1.37.2.ts`) is never set, because the checked-in spec lacks them (D-082). Fill it
  from the captured explain documents when a consumer needs enums (validation messages). Owner:
  that consumer, or R3.

## Handoff notes

Newest first. Each session adds: what was built, decisions made, surprises, known gaps.

- 2026-11-17 — **Phase 12 done.** The learning loop is on screen: home, the session runner, the
  flows of every item kind, the debrief, languages, the content browser, resume from the server.
  - **Still open from phase 11, for the owner:** lessons are done once and not scheduled (D-141),
    and two items on one primary skill may follow each other when nothing else is left (D-146).
    Both differ from a sentence of `PLAN.md` §5. The screens follow the code as it is: a finished
    lesson says it will not come back, and the queue shows what `buildQueue` gives.
  - What opens. The app starts on **Home** (`Home.tsx`, built by a parallel agent from a fixed
    props contract, reviewed in the browser here): today's session with a selectable time box,
    mastery by curriculum domain and by skill, streak and activity, the due forecast, recent
    mistakes, unfinished attempts. **Browse** (`Ctrl+Shift+O`) is the content browser with
    filters. `ItemPicker.tsx` is gone.
  - Events (`flow.ts`, `App.tsx`; `docs/LEARNING_MODEL.md` §12). An attempt is finished in the
    log when it passes (D-153). Solutions or the debrief before a solve is giving up: one
    `attempt.solution`, rated Again, `failed` when left (D-154). Skip abandons; anything else
    left unfinished stays open and resumes (D-155). Check asks for a confidence first (D-156).
    The override is one click and one `rating` event.
  - Engine side (`apps/web/src/engine/session.ts`, `bilingual.ts`). One session code path runs
    labs, lessons and cards: a lesson or a card with a world goes through `scenarioShape`; a
    card without a world never builds one. `LabInfo` and `LabState` carry `Text` (English,
    Vietnamese, why not) instead of strings. New protocol messages: `note` (confidence,
    explanation, prediction; kept in the attempt's log as `learn.action` inputs, so they survive
    a reload) and `step` on `lab` for a lesson's task. `lab.result` carries the clock.
  - Languages (D-158). `tagUnits` in `packages/learn` is new. Side by side is one row per unit.
    Only the fixture pack has sidecars, so the owner sees "English only" on every real item
    until an R2 run.
  - Persistence (D-157). Progress events go through an outbox; attempt logs go to
    `data/attempts/<id>.jsonl` as records. A browser with no settings takes the server's
    (`data/settings.json`); the tests had to learn that one test's setting reaches the next.
  - Tests. `e2e/session.spec.ts` (a daily session from an empty log on a second server with its
    own data directory, the next day by Playwright's clock; a mixed session on the fixture
    track; keyboard only), `e2e/language.spec.ts`, `engine/kinds.test.ts`, `flow.test.ts`,
    `progress.test.ts`, `attempts.test.ts`, `homeModel.test.ts`. The e2e build sets
    `SIMLAB_FIXTURES=1` (D-161).
  - Fixed on the way: every figure slid in from a zero-width layout when it first appeared
    (D-162); the attempt record repeated the check report after every action.
  - Surprises. The fixture track's queue puts the drill before the card after the lesson
    (interleaving by primary skill); a test that assumed track order failed. Dumping an
    attempt log to the terminal costs a great deal of context: one record per keystroke.
  - Known gaps: no real lesson or card exists, so the owner can see those screens only in the
    test build (`SIMLAB_FIXTURES=1 npm run build -w apps/web`, then `npm start`) until R1; the
    debrief's figure of a wide world is cramped in a 440px panel (the enlarge button helps; the
    panel can be widened); nothing was checked in Chrome on Windows with Vimium: the new chords
    `Ctrl+Shift+D` and `Ctrl+Shift+K`, digits in the confidence prompt and on cards, and
    Escape in the browser sheet want the owner's confirmation.
- 2026-11-17 — **Phase 11 done.** The learning core: item kinds, packs, sidecars, the progress
  log, FSRS, the daily queue, persistence. No screen changed. `docs/LEARNING_MODEL.md` is the spec.
  - **Two decisions touch sentences of `PLAN.md` §5 and want the owner's word.** (1) Lessons are
    done once and not scheduled (D-141); the plan says "every item is scheduled with FSRS". To
    flip: `isScheduled` in `packages/learn/src/pack.ts` and `finishAttempt` rate lessons too.
    (2) Two items with the same primary skill may follow each other when nothing else is left to
    choose, marked `repeatsSkill` (D-146); the plan says "never". The strict rule gives a first
    day of one item. To flip: drop marked entries in `buildQueue`.
  - Item kinds. `Item` is still the lab-like item; `LessonItem`, `CardItem`, `ExamItem` and
    `AnyItem` are new (D-140). `item.schema.json` selects a layout by `kind`. Lessons (prose,
    figure, `predict`, `task` steps) and cards (self-graded, by choice, by command) validate with
    the same rules as labs through `scenarioShape`; a lesson's tasks run in order in one world.
    An exam is a list of lab-like items with weights (D-148). `content:check` now also checks the
    packs (ids, prerequisite cycles, tracks whose items could never be offered).
  - Packs. `pack.yaml` has skill descriptions, `requires` and `tracks`. The Kubernetes pack got
    one track, `k8s.track.first-labs`, and no prerequisites yet: R1 runs own the skill graph.
  - Sidecars. `textUnits`, `resolveSidecar` (current, outdated, missing, orphaned, violations),
    `localize`. `npm run content:i18n -v` prints the hash each untranslated unit needs, which is
    what R2 copies into a sidecar. No real item has a sidecar yet.
  - Progress. Twelve event types, version 1; `applyEvent` and `replay` derive everything; the
    automatic rating is itself an event (D-143), a manual one replaces it. Scheduling settings
    are events too (D-144), `data/settings.json` is for the interface.
  - FSRS. `ts-fsrs` 6.0.0 (new dependency, pinned). Its API changed in version 6: the old `FSRS`
    class is deprecated and the default model is FSRS-7. The wrapper uses `defineScheduler` with
    numeric time, no learning steps and no fuzz, and a floor of one day (D-142). Surprise: with
    the default weights a clean first pass comes back after about 5 days, then 26, then 92; after
    a failure an item sits on the one-day floor until what FSRS asks for exceeds a day, so several
    Good reviews in a row can keep a 1-day interval. The 90-day test asserts exactly that.
  - Queue. `buildQueue(state, catalog, now)`; rules in `docs/LEARNING_MODEL.md` §8 and D-146.
    The time box counts time spent, so the queue is rebuilt after each item.
  - Server. `apps/server/src/store.ts` and `api.ts` (built by a parallel fork of this session,
    reviewed here): progress, attempts, settings, gaps. SIGKILL never tore a line on this machine
    in forty tries; the repair of a torn tail is proven by tests that cut lines by hand (D-149).
    `npm run dev` runs the same server, so no proxy was needed.
  - Fixtures. `simulateLearner` and `demoCatalog` are exported from `packages/learn` (phase 12
    can draw a believable history with them). `packages/content/fixtures/learning/` holds one
    valid item of each new kind on the real simulator and is not loaded by the apps (D-152).
  - Fixed on the way: the competency pattern in the item schema named `cka|ckad` inside
    `packages/learn` (hard rule 8; D-151); `formatSchemaErrors` called every value "(item)".
  - Known gaps: the web app does not call the new API or show any of this (phase 12); no real
    lesson, card or exam exists (R1); `npm audit` reports 9 moderate advisories, all in the lint
    tooling's `minimatch` chain (eslint, typescript-eslint), none in what ships.
  - For phase 12: `docs/LEARNING_MODEL.md` §12 lists the calls in order. A `LabEvent` maps one to
    one to an `attempt.*` event; `finishAttempt` needs the variant's hint count.
- 2026-11-17 — **Phase 10d done.** The look chosen again, the lab panel in tabs, a floating X-ray.
  - The look. Three directions shown as screenshots of the real workspace (scheduling lab, check
    failed, one hint, X-ray docked and floating, both themes), each already with the tabs and the
    floating X-ray: Glass, Quiet, Stage (`docs/DESIGN.md` §1 has what each was). The owner chose
    **Quiet "with less rounded boxes"** (D-132): IBM Plex Sans stays, panes are opaque rounded
    surfaces (8px) with an 8px gap on a flat floor, no rules except the line under the selected
    tab, flat controls, one indigo accent, translucency only on what floats. Glass, Stage and the
    two fonts installed to show them are gone; `package.json` and the lock file are unchanged.
    Applied to every screen: workspace, lab list, editor overlay, popovers, the figure dialog,
    figures, the X-ray. `docs/DESIGN.md` §1 to §4 and §7 rewritten.
  - Tokens. `apps/web/src/app/tokens.css` defines every value; `styles.css` was rewritten as rules
    only. `tokens.test.ts` (in the gate) fails on a literal color, size or duration in a rule, on a
    `var(--x)` nothing defines (CSS and TypeScript), on a theme that misses a color, and on text
    below WCAG AA for the pairs in use (D-133). The terminal's background and foreground are tokens
    read by `theme.ts`; its ANSI palette is not (D-134). The native `select` is `Select` in `ui.tsx`.
  - Tabs. `TabStrip` in `ui.tsx` (ARIA tabs, badges, a "new" dot, scrolls when full; phase 12's
    lesson steps are more tabs of it). `LabPanel`: Ticket, Check, Hints, Debrief, Solutions; an
    action opens its tab and a hidden panel; Debrief before solving and Solutions ask in their tab
    and are recorded as before; panels are stacked so each keeps its scroll and its figures
    (D-139). New chords `Ctrl+Shift+,` and `Ctrl+Shift+.` go to the previous and next tab and focus
    it; Escape returns to the terminal (D-135).
  - X-ray. Settings `xrayMode` and `xrayFloat`; `floating.ts` (pure geometry, unit-tested) and
    `useFloat` in `XRay.tsx`: header drag, eight pointer handles, keyboard on the move handle
    (`Ctrl+Shift+G` takes it),
    always inside the workspace, remembered, a dock/float control (D-137). Facts of a selection
    are a card over the drawing instead of a footer that took its height (D-138). The terminal
    keeps 80 columns at 1440px with the lab panel open and the X-ray docked: the panes beside it
    give way to their minimums (D-136).
  - Exit criteria. (1) Look chosen from screenshots and applied everywhere; no literal left in
    `styles.css` (test). (2) Five tabs, keyboard reach, the two that give the answer away ask
    first: `e2e/labpanel.spec.ts` (6 tests). (3) Floats, moves, resizes, stays inside, docks,
    remembers: `e2e/floating.spec.ts` (3 tests). (4) `npm run e2e`: 44 browser tests pass; read
    latency p95 8.4 ms closed, 8.7 ms docked, 9.4 ms floating, keystroke echo p95 0.2 to 0.3 ms
    (phase 10b: 8.6 to 9.1 ms and 0.2 ms); the 30-Pod rollout has no long task;
    `unshare -rn npm run build` in `apps/web` builds without a network and the offline test
    passes; the reduced-motion test passes. (5) Screenshots of every screen in both themes:
    `e2e/screens.spec.ts` writes them to `.tsbuild/playwright/screens/`.
  - Fixed on the way. The "page never scrolls" test put its 3000px element inside the flex column,
    which squeezed the workspace to nothing (it only passed because the old panel overflowed
    visibly); it now appends to `body`. `--text-faint` was 3.7:1 and 3.1:1, below AA. After Escape
    in the panel or a drag, focus went back to the terminal a frame late and a key typed at once
    was lost; both are synchronous now. The app icon and manifest colors follow the look.
  - Surprises. `svg:only-child` matches an icon that has text beside it (text nodes are not
    children), so icon-only buttons get a class from `Button`. The outer 3px of a rounded pane's
    corner are outside its hit area: corner handles are grabbed a few pixels in. A flex item with
    `flex: 1` and `min-height: 0` gives up all its height to an oversized sibling. Fonts for the
    candidates had to be installed to show them; uninstalling restored the lock file exactly.
  - Not verified on Chrome for Windows (listed in `FEEDBACK.md`): how the look renders with
    Windows' font smoothing and what the blur behind floating surfaces costs on a real GPU (the
    headless shell renders in software); whether anything outside the page takes `Ctrl+Shift+,`,
    `Ctrl+Shift+.` or `Ctrl+Shift+G`; dragging and resizing the floating X-ray with a real mouse; 80 columns at
    the owner's window size and scaling.
  - Known gaps. The lab panel at its 300px minimum scrolls the tab strip sideways. Text widths in the renderer are still estimated (10b). Phase 13's "Why?"
    inspector should extend the facts card of D-138.
  - For 11 and 12. Build screens from `tokens.css` only; a new value is a new token plus a line in
    `docs/DESIGN.md`. A new pair of text and surface goes into `PAIRS` in `tokens.test.ts`. Lesson
    steps: pass more `TabItem`s to `TabStrip`. The e2e helpers `settings`, `openXray`, `labTab`
    and `openDebrief` are in `e2e/workspace.ts`; `settings` writes only when nothing is stored, so
    a reload keeps what the page saved.

- 2026-11-17 — **R3 after Checkpoint A2.** Three bugs fixed, one phase added.
  - The owner's verdict: nothing against the figures or what the X-ray shows. The interface
    "feels like old Bootstrap websites", the lab panel is one long scroll, the docked X-ray takes
    the terminal's width. Entries, evidence and outcomes: `docs/feedback-log.md`.
  - Fixed, each with a browser test. The X-ray's drawing rescaled on every selection after "Fit
    everything" or a zoom (D-129: the visible part's height follows the pane). The editor overlay
    was in the interface's proportional font: its theme used `var(--mono)`, a token 10b renamed.
    The page shifting up on Solutions was not reproduced; the lab panel now scrolls only its own
    scroller and the page cannot scroll, also by script (D-130). The X-ray's header overflowed at
    320 px.
  - Plan: **phase 10d** (`prompts/10d-interface-refresh.md`) runs next: the look reopened and
    chosen again from screenshots, the lab panel in tabs, the X-ray as a floating panel in the
    page. Phases 11 and 12 now need 10d. `PLAN.md` §10, §13, §15; D-131.
  - Gap log: readline's `digit-argument` (Alt+1, one record) deferred to 22a, in its prompt.
  - Surprises. A CSS variable that does not exist fails silently: the declaration is dropped and
    the property inherits. After renaming tokens, search TypeScript too (`EditorView.theme`
    takes CSS as strings). `overflow: clip` on the root element is applied to the viewport as
    `hidden`, so it is the body that must clip. `npm run e2e -- <file> -g "a|b"` breaks on the
    `|`; run `npx playwright test -c playwright.config.ts … -g "a|b"` in `apps/web` instead.
  - Verified: `npm run check` green (3947 tests); `npm run e2e` 34 browser tests. Not verified on
    Chrome for Windows: the three fixes, listed in `FEEDBACK.md` for the owner to confirm, with
    three confirmations still open from Checkpoint A (Ctrl+W/T/N in full screen and the app
    window is confirmed).
  - For 10d. After "Fit everything", a selection's facts cover the bottom of the drawing (the
    footer grows); a floating or redesigned X-ray should show facts without taking the canvas's
    height. With the X-ray docked at 1440 px the terminal has about 50 columns; the prompt asks
    for 80 with the lab panel open.

- 2026-11-17 — **Phase 10c done.** Figures in content: views, comparisons, scenes, diagrams; the
  three labs rewritten around them.
  - Format (`docs/SCENARIO_FORMAT.md` §11, new; Validation, sidecar, examples and "not covered" are
    now §12 to §15): `ticket` and `debrief` take blocks of prose and figures, each with `when`.
    Kinds `view` (`of: start | solved | now`), `compare` (left, right, differences marked),
    `scene` (frames of steps on a fork, the item's baseline or a small world of its own), `diagram`
    (hand-drawn in the shape vocabulary). `focus` (`scope`, `kinds`, `entities`, `system`), `show`
    (fact labels, list facts cut by `keys`), `highlight`, `notes` (with `divergence`), `caption`,
    `alt`. Schema `$defs.prose`, `block`, `figure`, `focus`, `showItem`, `note`, `diagramNote`, so
    phase 11's lesson steps can use the blocks. Sidecar units for captions, alt texts, notes, frame
    captions, panel titles and diagram labels. Decisions D-121 to D-128.
  - Engine: `packages/learn/src/figure/` (blocks, focus and marks, `figureWorlds` and
    `renderFigure`), `Lab.render`, validation rule 9 (`figureProblems`; the debrief must open with a
    figure; ticket figures are a view of start/now or a diagram with explicit `show`; cited
    divergences must exist, checked by `content:check` against `docs/FIDELITY.md`). The view
    contract's facts gained `items` (list entries); the k8s provider gives Labels, Taints,
    Allocatable, Requests, Node-Selectors, Selector their entries and Pods a Tolerations fact
    (`tolerationString`, `sortedTaints` from describe). The counter test plugin has a view provider.
    The JSON Schema validator reports the closest `oneOf` alternative better (`const`
    discriminator, then matching type).
  - Web: `Figure.tsx` (panels, notes, change legend, scene stepping and Replay, an enlarge dialog),
    `ViewCanvas` `still` mode with `marks` (outline, note badges, change badges), facts drawn on
    cards and under headers (`factLayout`: labels beside values or above them, values wrapped at
    `=`, `:`, `/`), the worker renders ticket figures at start and debrief figures on request and
    does not count that time. `npm run lab` prints `[Figure]`, caption and alt text.
  - The three labs. Prose per variant (old → new words): scheduling taint 303 → 131, selector
    291 → 140, memory 293 → 133; rollout tag 344 → 147, name 363 → 158, registry 347 → 149; build
    321 → 128. Scheduling: a ticket view (Pending Pods with no node, which the ticket now states),
    a comparison per cause (taints, `disktype` labels, tolerations / node selectors / requests and
    allocatable memory) with notes, a diagram of filter-then-score. Rollout: a comparison of start
    and solved (selector, labels, images, the progress-deadline note) and a five-frame scene of a
    four-replica rollout stalling on the variant's bad image, then fixed. Its ticket figure was
    dropped: the Deployment's `3/3` would have said more than the ticket. Build: a ticket diagram
    of what is asked, a view of the solved world (ownership chain, Service routes, notes on
    selectors and ports) and a view of the learner's world.
  - Fixed on the way: DIV-043 registered (the default admission plugins' fields are missing, a
    known shortcut that had no register entry); the worked examples in the spec gained figures;
    `PLAN.md` §8's figure example used `namespace` where the format says `scope`.
  - Surprises. Any `learn.action` changes the world hash, so "rendering changed nothing" is tested
    by replaying the stored attempt to the same hash. A still drawing measured before its pane had a
    width kept a one-column height. A start-vs-solved comparison marks almost every left entity as
    removed; fading them hid the broken state, so they keep full strength. Generated Pod names
    differ between worlds, so `now` vs `solved` comparisons mark everything; the build lab shows two
    views instead.
  - Verified: `npm run e2e` 30 browser tests (`e2e/figures.spec.ts` new: each lab's ticket and
    debrief figures, the comparison's marks, the enlarge dialog, stepping and replaying the scene,
    reduced motion). Screenshots of every debrief are written by `figures.spec.ts`. Read latency
    p95 measured 24–29 ms with a machine load average of 15 from other jobs; the previous commit
    measured 27–31 ms under the same load, so the figures add nothing. `xray.spec.ts`'s locators
    are now scoped to `.xray`: the ticket's figure draws the same ids.
  - Known gaps. Text widths are still estimated, not measured. The diagram's links can pass behind
    note badges. A `compare` places both sides side by side only from 760px; in the default lab
    panel they stack (the enlarge dialog shows them side by side). Not verified on Windows at 125%
    and 150% scaling; the figures use the same SVG and fonts as the X-ray.

- 2026-11-17 — **Phase 10b done.** Design language, view contract, providers, renderer, live X-ray.
  - The look. Two directions shown as screenshots of the real workspace running the scheduling lab
    with the X-ray open, both themes: Instrument (IBM Plex Sans, compact, panes edge to edge as
    tonal layers) and Studio (Inter, roomier, rounded island panes). The owner chose
    **Instrument**; Studio was removed. `docs/DESIGN.md` records the tokens (type scale, weights,
    spacing, radii, surface levels and elevation, motion with what may and may not move, the state
    colors and glyphs in both themes) and the views' shape vocabulary. `styles.css` now takes every
    size, weight, radius and duration from a token; the font is bundled (`@fontsource/ibm-plex-sans`
    5.3.0, `apps/web/src/app/fonts.ts`, D-117). Every existing screen (workspace, lab list, editor
    overlay, popovers) uses it.
  - View contract (`packages/kernel/src/view.ts`, registry kind `view`, ARCHITECTURE §2.13):
    entities, relations, kinds described by seven shapes (D-118), `buildView`, `validateView`.
    Providers: host (machines, `packages/host/src/view/`) and k8s (namespaces, Nodes on their
    machines, Pods with or without a node, Deployments, ReplicaSets, Services with selects and
    routesTo; `packages/k8s/src/view/provider.ts`). Status words and fact labels come from the
    printers; who judges each state is D-120. Provenance unit `view.k8s.words`.
  - Renderer (`apps/web/src/view/`): our own layout (bands: scopes, the unplaced lane, hosts; slots
    remembered so an entity keeps its place) and SVG drawing with CSS transitions, fade in and out,
    zoom, fit, focus, keyboard selection, reduced motion. No domain word: `nodomain.test.ts`.
  - X-ray (`apps/web/src/app/XRay.tsx`): third pane, top bar toggle and Ctrl+Shift+Y, filter by
    scope (system namespaces hidden by default), facts and relations of the selection, legend.
    The worker sends view models at most every 200 ms and only when changed (D-119). Opening and
    closing are logged as `learn.action` `view` and recorded as `LabEvent` `view`.
  - Exit criteria. (1) Look chosen from two directions; DESIGN.md has tokens and motion rules.
    (2) `e2e/xray.spec.ts`: the scheduling lab (seed 1) shows three Pending Pods in the "Pods with
    no node" lane, outside every node; after `kubectl edit` in the terminal the three new Pods are
    Running inside node01 without a reload, and the names match `kubectl get pods -o wide`.
    (3) `packages/k8s/src/view/provider.test.ts` compares the view with `kubectl get pods -A -o
    wide` and `kubectl get nodes` on the same world (bad-image Pods and a cordoned node included);
    a rollout of 6 Pods is followed as a sequence of 121 views. (4) `nodomain.test.ts`. (5) A 30-Pod
    rollout at 10× speed with the X-ray open: keystroke echo p95 0.2–0.3 ms, no long task; reduced
    motion from the system and from the setting both make change instant. (6) `npm run e2e`: 22
    browser tests; latency with the X-ray closed p95 8.6–9.1 ms, open p95 8.3–8.6 ms (painted p95 under 23 ms),
    keystroke p95 0.2 ms; `unshare -rn npm run build -w apps/web` builds with no network and the
    offline test passes. Screenshots of the workspace with the X-ray open and closed, both themes,
    are written by `e2e/xray.spec.ts` to `.tsbuild/playwright/`.
  - Surprises. Playwright empties `.tsbuild/playwright/` at the start of every run, screenshots
    included: copy them out before running another spec. With three panes at 1440 px the terminal
    is about 50 columns wide, and the probe (which reads the cursor's row) loses a command that
    wraps; the latency run with the X-ray hides the lab panel. A test listener for a workspace
    chord must use the capture phase: the workspace's own capture listener stops propagation.
    `pkill -f` with a pattern that appears in the same shell command kills that shell.
  - Known gaps. Text widths in the renderer are estimated from the font size (no measuring), so a
    narrow host's header may shorten a name more than needed. The X-ray shows no "why" (phase 13)
    and no conditions; the scope filter is the only filter. Not verified on Windows: whether Chrome
    or Edge acts on Ctrl+Shift+Y before the page (Edge has used it for Collections); the top bar
    button works regardless.
  - For 10c. Figures render through `ViewCanvas` with a `ViewModel` from `buildView` on any world
    (a baseline, a fork, a scene step). A figure will want a fixed viewBox and no interaction:
    add a `static` prop rather than a second renderer. The `scope` filter and `system` flag decide
    what a figure shows by default.

- 2026-11-17 — **R3 after Checkpoint A.** Feedback and gap triage; the plan changed.
  - The owner's verdict: typing and the supported commands feel real. The content is too much
    text with no visual aid, the debrief needs a visual presentation, a dynamic picture of the
    system would teach better (for later domains too), and the UI is bland. Four shortcut
    problems in Chrome on Windows and one off-center button. No entry was *wrong*.
  - Plan change, decided by the owner when asked (`PLAN.md` §15, D-115): the visual layer comes
    next. New phases 10b (design language, view contract, renderer, live X-ray) and 10c (figures
    in content, scenes, the three labs rewritten), then Checkpoint A2, then 11. `PLAN.md` gained
    §5 "Show, then tell", §6.5 Views, figures in §8, two risks in §14. Prompts written: 10b, 10c.
    Prompts revised: 11 (figures in the content model, X-ray use in the rating), 12 (built in
    the design language, figures in lessons and debriefs), 13 (renamed
    `13-trace-replay-and-time-controls.md`: trace audit, "Why?", timeline, replay, time controls,
    assist levels; its view contract and panel moved to 10b), 14 (figures in the authoring guide,
    the curriculum map and the lint), R1, R4, 34 (a view provider and figures are required), 31
    (no figures in exams), 22a (the exam's `k` alias preset, `vim` without a file name), R3 (the
    summary tool; too-large work is re-planned, not squeezed in).
  - Fixed, each with a test (D-112, D-113): Ctrl+Shift+C is claimed every time and copies any
    selection; Ctrl+Shift+PageUp/PageDown switch terminals; full screen with keyboard lock
    (Ctrl+Shift+F, top bar) and a web app manifest so Ctrl+W, Ctrl+T and Ctrl+N reach the shell;
    the close button's icon is centered and the + sits on the tabs' line; the shortcut list
    explains the browser's keys and Vimium. New: `apps/web/src/app/fullscreen.ts`,
    `apps/web/public/` (manifest, icons), `npm run gaps:summary` (`tools/src/gaps/`, D-114),
    `docs/feedback-log.md`.
  - Fixed on the way: Vitest's 5 s default timeout failed the gate once while another project's
    jobs held every core (a lab test that takes 1.5 s); tests may now take 30 s (D-116).
    `docs/decisions.md`: phase 10's decisions got their own heading, and D-108's claim that the
    chosen chords "are not reserved by browsers" was corrected.
  - Not verified from here: Chrome for Windows itself. The headless shell has no browser window,
    so "Ctrl+W no longer closes the tab in full screen or the installed window" rests on
    Chromium's source (D-113) and the page-side tests. `FEEDBACK.md` lists four things for the
    owner to confirm.
  - Surprises. CodeMirror ignores a key event whose default was prevented in the capture phase,
    so the guard for Ctrl+W, Ctrl+T and Ctrl+N runs in the bubble phase. Playwright's
    `Control+W` sends the character `W`, which vim reads as `<C-W>`, not `<C-w>`: use lower-case
    key names when testing vim. The owner runs the Vimium extension, which takes Escape before
    any page; nothing in the page can prevent that. The gap log's nginx records (16 of 26) have
    no item: they are from development runs of the terminal player, not from the owner.
  - For 10b. Read `docs/feedback-log.md` and D-115 first: the decisions about the renderer (our
    own SVG, no diagram library), figures as views of simulated worlds, and what a ticket's
    figure may show are made. The icon in `apps/web/public/` is the current brand mark; replace
    the three files if the look changes it (the PNGs are renders of `icon.svg`). Test at 125% and
    150% scaling, as `e2e/workspace.spec.ts` does: the owner's screen is scaled.

- 2026-11-16 — **Phase 10 done.** Web app: terminal, lab panel, editor overlay.
  - Built. `apps/web` (Vite 8, React 19, xterm.js 6, CodeMirror 6 with `@replit/codemirror-vim`,
    marked): `src/engine/session.ts` (one attempt per worker: lab, recorder, interactive driver,
    batched output, resume by replay, lab actions as `learn.action` inputs) and `worker.ts` (the
    wall clock; wakes when the next event is due, D-106); `src/protocol.ts`; `src/app/`: App
    (state, shortcuts, tabs, resume on load, `?lab=&seed=`), Terminal (xterm.js, fit on resize,
    OSC title on the tab, Enter relaunches an exited shell), EditorOverlay (vim keys or plain,
    vim's messages from `vimref.ts`, `[sim]` and gaps for unsupported Ex commands), LabPanel
    (ticket, per-check results, hint ladder, debrief, solutions, confirmations in `npm run lab`'s
    words), TopBar (clock with pause, `[sim]` notices, settings, shortcuts), ItemPicker, storage,
    gaps (batched posts and `sendBeacon`), probe (`window.__simlab` for tests). `vite.config.ts`
    bundles the packs (D-103). `apps/server`: static files or Vite middleware with hot reload,
    `POST /api/gaps`, `--port`, `--data`. Kernel: `createRecorder(kernel, header, from)`. Host:
    `EditorRequest.isNew`. Fixture: `fixtures/reference/vim/messages.{py,json}` (vim 9.1's
    message line and Ex command names). Commands: `npm run dev`, `npm start`, `npm run e2e`,
    `npm run bench:web`. Playwright 1.64.1 (its headless shell is already installed, D-110).
  - Exit criteria. (1) All three labs solved in the browser (`e2e/labs.spec.ts`): pending Pods
    seed 1 through `kubectl edit` (`:%s/disktype: SSD/disktype: ssd/`, `:wq`), broken rollout
    seed 3 through `set image` and `kubectl edit service`, the build lab seed 3 by editing the
    generated manifest with vim in normal mode (`/replicas`, `$ciw4`, `:w`, `:q`) and applying it;
    each check says Solved. (2) Reload mid-lab (`e2e/resume.spec.ts`): two terminals, hints and an
    open vim session come back; the first terminal shows every line it showed; the world is the
    same (the Deployment, the saved file); `session.test.ts` also compares world hashes and the
    terminal bytes exactly. (3) Latency in Chromium (`npm run bench:web`, 80 samples over ten read
    commands: kubectl get/describe/-o yaml/-o wide, ls, cat): p50 5.2 ms, p95 8.1 ms, p95 with the
    paint frame 22.2 ms; keystroke echo p95 0.2 ms (2052 keys). (4) `npm run build -w apps/web`
    inside `unshare -rn` (no network): built; the page makes no request off the local server and
    runs a lab with the browser offline (`e2e/offline.spec.ts`); the bundle's URLs are only text
    in help and schema descriptions. (5) Smoke test passes (`e2e/smoke.spec.ts`); 12 browser tests
    in all, three clean runs in a row. Screenshots: in the session report (`.tsbuild/playwright/*.png` after `npm run e2e`).
  - Decisions D-103…D-111. Docs: ARCHITECTURE §2.5 (the worker's driver), §2.8 (`from`), §2.10,
    §3.8 (as built in 10); FIDELITY DIV-014, §2 (vim capture), §4.4 (the server sink); CLAUDE.md
    commands and layout.
  - Fixed on the way: `npm run lab` wrote the item at the top level of gap records; the spec puts
    it in `context`. Test gap records no longer reach the real `data/gaps.jsonl` (`--data`); three
    records this session's first runs had written there were removed.
  - Surprises. A reload right after typing lost the last inputs: the worker handed the attempt to
    the page every 250 ms, and nothing from the worker arrives once unload begins. Now every input
    reaches the page at once and the page writes storage synchronously on hide (D-105). Commands that consume virtual time waited for the next 50 ms tick, which was most
    of the measured latency; waking at the next due event fixed it. An Escape that closed a
    popover reached the shell as a meta prefix and ate the next letter. The vim emulation prints
    its own "Not an editor command" text; the overlay replaces it with vim's E492 or a `[sim]`
    notice. `-o jsonpath` and `$(( ))` are not simulated yet (phases 15 and 22a); the tests avoid them.
  - For later phases. 11: replace browser storage with the server (StoredAttempt is the shape to
    persist; the `attempt` message is the hook), rating from `labState`, `Lab.events`. 12: home
    screen; the picker is the current entry. 13: speed and skip are in the protocol (`speed`,
    `advance`) and the clock already reports `speed`; only the controls are missing. Checkpoint A
    next: `npm start`, open http://127.0.0.1:4317/, write impressions in `FEEDBACK.md`.

- 2026-11-16 — **Phase 09 done.** Scenario runner, checks, grader, three labs, `npm run lab`.
  - Built. `packages/learn`: item types, variants (seeded parameters, `when`, typed placeholders),
    the item schema generated from the registry (`item/schema.ts` over `schema.base.ts`) and a
    dependency-free JSON Schema validator (`item/jsonschema.ts`, D-093); the runner
    (`runner/`: port hub and step sessions, step lists with built-in `advance`/`until`, check
    evaluation on forks with `within`, `after`, `not`, the grader with weights and scores,
    baselines); `lab.ts` (hints with use recorded, check, reset, solutions, events);
    `validate.ts` (static rules, per-variant argument validation, seeds that cover every `when`
    value, `runSeed`); `show.ts`; `testing.ts` (a counter plugin). Kernel contracts: StepSession,
    `CheckCtx.baseline`, `CheckResult.expected`, `StepSpec.show` (D-094). Host
    (`src/scenario/`): steps `run`, `write`; checks `shell.exec`, `host.file`. k8s: checks
    `k8s.object`, `k8s.podsReady`, `k8s.rollout`, `k8s.endpoints`, `k8s.nodeHasTaint`,
    `k8s.unchanged`, `k8s.notRecreated` (`src/checks/`), step `apply` (`src/scenario/apply.ts`,
    D-097). `packages/content`: loader and `k8s/pack.yaml`; labs
    `k8s.workloads.deployment-service-01` (build task), `k8s.scheduling.pending-pods-01` (taint,
    node selector or memory request; constraints on nodes, placement, request, recreation),
    `k8s.troubleshooting.broken-rollout-01` (bad image of three kinds chained with a Service
    selector that matches nothing). Tools: `npm run content:check` (now part of `npm run check`),
    `npm run content:schema`. CLI: `npm run lab` (Ctrl-] lab prompt, D-099; `--list`,
    `--replay`); the player takes any world (`PlayerOptions.world`) and logs `learn.action`.
  - Exit criteria. (1) `content:check`: all three labs pass, 5, 5 and 6 seeds, every `when` value
    covered, both solutions per variant where there are two. (2) A different valid path passes:
    `tools/src/content/labs.test.ts` (lab 1 by create, scale, expose and a hand-written file with
    a named target port; lab 3 by `kubectl edit` of the image and an applied Service), and the
    lazy fixes fail (removing the taint, dropping the selector, relabelling the node, removing
    the request, recreating the Deployment or the Service, rolling back the release). (3) Checks
    do not mutate the session world: `packages/learn/src/runner.test.ts` (a check that scribbles
    on its fork, `after` and `within`), `labs.test.ts` (world hash and clock before and after a
    full check, and the same report twice), `steps.test.ts` (`shell.exec`). (4) Played in a real
    terminal (a pty, the real `$EDITOR` editing the Deployment): `npm run lab --
    k8s.scheduling.pending-pods-01 --seed 3`, `kubectl get pods` (Pending), check (38%), three
    hints, `describe pod` showing FailedScheduling, `kubectl edit` adding the toleration, rollout,
    Pods on node01, check (solved), debrief, quit; the recording replayed to the same world hash.
    Labs 1 and 3 also started, graded and quit in the terminal. `labsession.test.ts` covers a full
    attempt at lab 3 and solution/reset confirmation with replay of both attempts.
  - Decisions D-093…D-102. `docs/SCENARIO_FORMAT.md` refined: weights (§7), expected/observed,
    the catalog with the phase of each check and the new `k8s.unchanged`/`k8s.notRecreated`,
    matchers that combine, counting and selection rules, the JSONPath subset, built-in steps,
    `apply`'s implementation, the poll interval, gaps fail steps, schema generation (§9),
    validation details (§11), `pack.yaml` (§1), declared images refused (§14).
    `docs/ARCHITECTURE.md` §2.11 shows the new contracts. CLAUDE.md: commands and layout.
  - Fixed on the way: the API server accepted creates that carry `metadata.resourceVersion`
    (`wipeSystemFields` dropped it); the real server answers 500 "resourceVersion should not be
    set on objects to be created", and kubectl clears the field itself before create (Helper
    CreateWithOptions), so `kubectl create -f` of a dump still works. Golden cases
    `api/create-resource-version` and `create/resource-version`, unit
    `apiserver.create.resource-version-set`; `golden:diff` 2151 compared, 2142 pass, 9 known, none
    failing. `openTerminal` chose an id by counter only and collided with a terminal a front end
    had opened by its own id (found by the real terminal run: a check's `after` shell failed with
    "tty tty3 already exists").
  - Surprises. Only nginx 1.31.8 and 1.14.2 start without a model gap (the others lack the
    captured "built by" line), so content uses those (D-098). `kubectl describe pods` for several
    Pods prints no events, as upstream does (describe.go: events only for a single object); the
    hints say "one of the Pods". `kubectl edit` reopens the editor only for a server-side invalid
    value; a changed name ends with an error. `k8s.object` requires every selected object to
    match, so "at least one Pod is in ImagePullBackOff" cannot be written yet; the broken-rollout
    setup waits 20 minutes instead.
  - For later phases. 10: the web app needs the items (D-100) and `createLab`/`openLab`; the
    terminal prompt's commands map to buttons. 11: rating from `GradeReport.score`, hints shown,
    `solutionViewed` and `Lab.events`; `pack.yaml` tracks and skills. 15: jsonpath for `where`.
    16b/17: declared images, `net.reach` (remove its stand-in from `tools/src/docs/planned.ts`).
    25a/26a/20a/28: the other planned checks and faults. 26b: `kubectl taint`.
  - Workflow: contracts first, then one Opus agent on the k8s checks while the runner was built;
    a second Opus agent on the resourceVersion bug once the labs found it. Outside the
    repository and the scratchpad: nothing, as far as the agents reported (the oracle is down).
- 2026-11-16 — **Phase 08 done.** kubectl II: imperative verbs, logs, rollout, explain, edit,
  completion.
  - Built (`packages/k8s/src/kubectl/`, one directory per group under `cmd/`): `generate/` (run,
    expose, `create deployment|namespace|serviceaccount|configmap|secret generic|service *`,
    `--overrides` merge/strategic/JSON), `change/` (scale, set image, label, annotate, edit),
    `rollout/` (status, history, undo, restart, pause, resume), `logs/`, `explain/`, `info/`
    (version, api-resources, api-versions, cluster-info), `config/` (view, get-contexts,
    get-clusters, get-users, current-context, use-context, set-context, delete-context),
    `cmd/typed.ts` (the typed printer), `completion/` (`__complete`, `kubectl completion bash`,
    the Tab completer). API server: the scale subresource is writable (`apiserver/scale.ts`), JSON
    patch (`apimachinery/jsonpatch.ts`, json-patch v4 port; `apiserver/jsonpatch.ts`), `pods/log`
    (`apiserver/log.ts`, `kubelet/logs.ts`, topic `k8s.logs`), `/version` and legacy discovery
    (`apiserver/nonresource.ts`), `/openapi/v3` (`apiserver/openapi.ts`). Host: editor answers in
    transcripts (`@editor`), alias-aware completion, `ProgramCompletion` gained line, point, env,
    aliases and columns, the `<<tmp>>` token. Tools: `npm run openapi:capture`;
    `api:vendor --descriptions` removed. Golden cases added: `generate/` (4), `change/` (6),
    `rollout/` (3), `api/json-patch`, `logs/before-the-kubelet`, `explain/` (5), `info/` (4),
    `config/` (3), `completion/` (4); `generate/run` gained JSON overrides.
  - Exit criteria. (1) Generators equal the binary: 252 steps over `generate/*`, plus
    `client/generators` and `client/yaml-output`, all pass in the differential runner. (2) The
    rollout story: `rollout/imperative.t` (create deployment, set image with change-cause, status
    with progress lines, history, a bad tag stalling to the 600 s deadline with ImagePullBackOff,
    undo, restart) and `rollout/story.t` (the same with apply). (3) `logs -f` streams in virtual
    time and ends when the container exits; `--previous` after a crash (`cmd/logs/follow.test.ts`,
    `transcripts/kubectl/logs/pods.t`). (4) `kubectl explain deployment.spec.strategy` equals the
    binary (`explain/resources`). (5) Terminal player on a pty, seed 7, real speed: `alias
    k=kubectl`, `k cre<Tab>` → `create`, `dep<Tab>` → `deployment`, `… --dry-run=client -o yaml >
    d.yaml`, `vim d.<Tab>` (the workstation's `$EDITOR` set replicas 3), `k apply -f <Tab><Tab>`
    listed `.kube/  d.yaml`, `d<Tab>`, created; `k get dep<Tab>` → `deployments.apps` showed 1/3;
    `k edit deploy <Tab>` → `web` (the editor changed the image to 1.28), edited; `k rollout
    st<Tab> deploy <Tab>` printed three "old replicas are pending termination" lines and
    "successfully rolled out"; Pods on both workers, two ReplicaSets. The recording replayed to
    the same world hash. Differential runner: 2143 compared, 2134 pass, 9 KNOWN (unchanged),
    none failing; provenance 163 units, 139 golden-verified, 24 source-derived.
  - Decisions D-082…D-092; D-038 and D-045 point to their successors; D-086 rewritten when the
    loaders were unified. Divergences DIV-037…042. `docs/ARCHITECTURE.md` §4.6 and §4.9,
    `docs/FIDELITY.md` §5, §6.3 (editors), §6.4 (`<<tmp>>`), §6.8, `docs/TRANSCRIPTS.md`
    (`@editor`), COVERAGE regenerated, CLAUDE.md (openapi:capture, layout). Temporary shortcuts:
    the read-only scale subresource is gone; added kubectl completion as the documented setup
    (22a) and the constant `/version` (29b); the shim bullet lists what is left.
  - Fixed on the way: the shared kubeconfig loader now reports the real load errors (a repeated
    name is a conversion error, not "last wins"; type mismatches; ENOTDIR) through one decoder
    (`client/kubeconfigmodel.ts`, golden case `config/broken-kubeconfig`); bash's `$'…'` decodes
    `\uHHHH`/`\UHHHHHHHH`; tildes after `=` and `:` in assignment-like arguments
    (`export X=~/a:~/b`, also `echo X=~/a` in default mode), both golden-verified in
    `packages/host/transcripts/shell/quoting.t`; `tools/src/golden/yaml.test.ts` skips
    `kubectl version` (it marshals its struct itself); decisions.md had no headings for 07a and
    07b. CLAUDE.md now says to set `model` on every Agent call (`memory/subagent-model-choice.md`).
  - Surprises. The checked-in OpenAPI v3 spec at v1.37.2 has no enums, the served one does.
    `run --dry-run=client` needs a server (createGeneratedObject maps first). No command has
    `--record` any more; change-cause comes from manifests or `kubectl annotate`, and an undo
    copies it back from the ReplicaSet. JSON patch Apply errors reach the user as a generic 422.
    `kubectl logs` for a Pod with no node prints nothing and exits 0; `-l` defaults to
    `--tail=10`. Completing a command with required flags inserts them (`create deployment <Tab>`
    → `--image`); `%q` escapes commas (`pods\,secrets`). `kubectl version` prints its struct with
    two-space JSON. cluster-info has no colors at this pin. The control plane's static Pods write
    no logs (the `component` stand-in, DIV-028). The editor scripts of golden cases avoid `sed`,
    `if` and `${x//a/b}`, which the simulated bash lacks (22a). `nginx:1.26` is not in the image
    catalog. Outside the repository: a subagent ran `npx prettier` once (npm's cache in
    `~/.npm/_npx`, possibly a registry request); nothing else.
  - For later phases. 15: `patch` (JSON patch exists), `wait`, the remaining config mutators,
    jsonpath; delete their shim entries. 16a/16b: init containers run (set image already handles
    them), probes unblock `controllers/endpoints` and `rollout-stuck`. 17: attach/exec for
    `run -it`, container completion through workloads. 18a: DaemonSet/StatefulSet rollouts
    (D-083). 22a: replace D-090's always-on completion with real `complete` lines. 29b: the
    server version.
  - Workflow: skeleton group directories first, then seven agents in parallel (generators,
    change, rollout, logs, explain, info/config, completion), then four cleanup agents (shim,
    typed printer and JSON overrides, kubeconfig loader, tilde expansion). All seven inherited
    Opus because no model was set; the owner pointed it out, and the rule is now explicit.

- 2026-11-16 — **Phase 07b done.** kubectl II: describe, create, apply, delete.
  - Built: `packages/k8s/src/kubectl/` — `resource/files.ts` (the `-f` reader: files, directories,
    `-R`, globs via `resource/glob.ts`, stdin, JSON streams and Lists, every reader error; URLs and
    `-k` print notices), `cmd/create.ts`, `cmd/apply.ts` (client-side apply: last-applied
    annotation in `util/apply.ts`, three-way strategic merge, created/configured/unchanged, the
    missing-annotation warning, conflict retries, dry runs, `-o`), `cmd/delete.ts` (names,
    selectors, `--all`, `-f`, cascade, grace period, `--now`, `--force` and its warning, waiting in
    virtual time, `--timeout`, `-o name`, dry runs), `cmd/describe.ts` and `describe/` (Pod,
    Deployment, Service, Node with events; selector, prefix match, `-f`; other kinds print
    notices), `cmd/helpers.ts`. `packages/k8s/src/apimachinery/strategicpatch/` (patch.go ported:
    apply, directives, two- and three-way) and `apimachinery/converter.ts`; the API server applies
    strategic merge patches. API warnings: `apis/core/validation/podwarnings.ts` (warnings.go),
    `apiserver/warning.ts` (the recorder). Host: `placeFile`. Tools: `npm run coverage:generate`
    (COVERAGE's kubectl section, gate test `tools/src/coverage/coverage.test.ts`),
    `tools/src/strategicpatch/extract-tests.ts` (upstream's patch_test.go tables, all run). The
    `# objects:` header, `testing/objects.ts` and `npm run sim -- --objects` are gone: `# file:`
    and `--file` place files, setup lines run `kubectl create -f` (D-079). Golden cases added:
    `api/strategic-patch`, `api/warnings`, `apply/three-way`, `apply/overwrite`,
    `create/from-files`, `create/no-server`, `delete/options`, `delete/errors`, `delete/by-file`,
    `describe/{selection,service,deployment,node,pod-spec}`; `apply/created-configured-unchanged`
    gained two `rollout status` waits (its `-o yaml` depended on KWOK's instant readiness).
  - Exit criteria. Differential runner: 474 steps compared, 465 pass, 9 KNOWN with causes, none
    failing, PENDING empty; every describe, create, apply and delete step passes or is KNOWN,
    except steps blocked by KWOK's not-ready device and PriorityClasses (listed by the report).
    Transcripts: `apply/outcomes.t` (created, configured, unchanged; a three-way merge removing a
    label, an env var and a port; the missing-annotation warning), `apply/errors.t` (unknown field,
    YAML syntax error with its line), `create/`, `delete/dependents.t` (a Deployment with its
    ReplicaSet and Pods, orphan, foreground waits), `delete/pods.t`, `delete/files.t`,
    `describe/pods.t` (Running and CrashLoopBackOff with Last State, Restart Count and
    `BackOff … (x6 over 5m28s)`), `describe/objects.t`. Pending `describe pod` is golden
    (scheduling cases, `describe/pod-spec`). Terminal player (`npm run play`, driven on a pty,
    seed 7): a Deployment written with a here-document, `kubectl apply -f`, `get pods -w` from
    ContainerCreating to Running in 4–5 s, `describe pod` with containerd ids, image digest and the
    kubelet's events, `apply` again `unchanged`, `delete -f`, nothing left. What still looks
    different from a real cluster is the D-046 shortcut: no `Priority:` and `Service Account:`
    lines, `Mounts`, `Volumes` and `Tolerations` show `<none>` (phase 20b).
  - Decisions D-073 (strategic merge port), D-074 (`-f` reads everything first), D-075 (create/apply
    no-effect flags), D-076 (describe renders before writing), D-077 (describe masks in the
    runner), D-078 (delete's wait), D-079 (files, not objects, in transcripts and sim), D-080
    (generated COVERAGE section), D-081 (API warnings). D-052's reasoning corrected. Divergences
    DIV-034…036; DIV-017 narrowed to map-ordered warnings; DIV-015's impact gained apply's conflict
    text. `docs/ARCHITECTURE.md` §4.9, `docs/FIDELITY.md` §6.8, `docs/COVERAGE.md` (kubectl section
    generated; strategic merge row).
  - Fixed on the way: kubectl's `Warning:` prefix is bold yellow on a terminal
    (client-go rest/warnings.go); aggregate error messages flatten nested aggregates and drop
    duplicates; the normalizer tokenizes resourceVersions inside compact JSON; `golden.test.ts`'s
    stability check honors a case's `table:`; the Service warnings' headless test
    (`type == ClusterIP && clusterIP == None`); stale "not in the checkout" notes about `pkg/api`;
    `get/errors.t` used `describe` as its unsimulated example. The upstream checkout gained Go's
    `src/sort` and `src/path/filepath`.
  - Surprises. Plain strategic merge errors are reason-less 500s on the real server, and its type
    errors come from the unstructured converter (`unrecognized type: int32`). A client dry run of
    `delete` never fetches the objects it names, so a missing Pod prints "deleted (dry run)".
    `--all` with `-l` fails in the builder with a trailing space in its message. The apply warning
    names the plural resource without its group (`resource deployments/web`); `-o yaml` on apply
    prints nothing if any object failed; a Secret with `stringData` is `configured` on every apply.
    `describe pods,services web-1` with one missing prints "you may only specify a single resource
    type" (prefix matching runs for a single NotFound). Kubelet events carry a
    `spec.containers{x}: ` prefix in describe at this pin. The real server's ported warning reads
    `… is use "node-role.kubernetes.io/control-plane" instead` (sic). An agent ran `npx tsx` once,
    which put tsx into `~/.npm/_npx` (npm's cache) outside the repository; nothing else changed
    outside it.
  - For later phases. 08: `logs`, `rollout`, `explain`, `edit`, imperative verbs — reuse
    `resource/files.ts`, `cmd/helpers.ts` (dry run, validation, AddSourceToErr) and delete their
    shim entries; `kubectl patch` can now send strategic patches. 15: describers for the other
    kinds (the notice names them), jsonpath and custom columns. 20b: remove the describe admission
    masks with the others.
  - Workflow: the verb skeletons and provenance files were written first; five agents (strategic
    merge, describe, create/apply with the `-f` reader, delete, COVERAGE generation with API
    warnings) worked in parallel on separate files.

- 2026-11-16 — **Phase 07a done.** kubectl I: framework, get, output formats, differential tests.
  - Built: `packages/k8s/src/kubectl/` — the program `kubectl` (`kubectl.ts`) with cobra's Find
    and pflag's parser over the real command manifest (`cli/command.ts`, `cli/flagset.ts`,
    `cli/goduration.ts`), CheckErr's error texts (`cli/errors.ts`), kubeconfig loading and
    clientcmd's resolution (`client/kubeconfig.ts`), the transport by address with the real refused
    connection (`client/transport.ts`, `client/session.ts`), the REST mapper and category expander
    (`client/restmapper.ts`), the resource builder (`resource/builder.ts`), `get` (`cmd/get.ts`:
    tables, wide, yaml, json, name, `-A`, `-n`, `-l`, `--field-selector`, `--show-labels`, `-L`,
    `--no-headers`, `--show-kind`, `--ignore-not-found`, `-w`), help (`help/`, `cmd/help.ts`), the
    table printer and tab writer (`printers/`), provenance (`provenance.ts`). The API server makes
    Tables (`packages/k8s/src/printers/`, `as: 'Table'` on get, list and watch). go-yaml v2 and
    sigs.k8s.io/yaml (`packages/k8s/src/apimachinery/yaml/`: encoder, emitter, scanner, parser,
    decoder, manifest streams, Go JSON printer). Kernel: `PROVENANCE`, `ProvenanceSpec`,
    `validateProvenance`. Host: `Machine.addresses`. Tools: the differential runner
    (`tools/src/golden/kubectl/`, `npm run golden:diff`), `npm run fidelity:report`,
    `npm run bench:kubectl`, `golden:kubectl-manifest` now carries help and vendors the manifest
    (`--vendor`). Golden cases added: `client/kubectl-errors`, `client/help-more`,
    `client/yaml-output`, `client/yaml-input`, `configmaps/list-output`. `npm run sim -- --objects`.
  - Exit criteria. Differential runner over every case: 197 steps compared, 192 pass, 5 KNOWN with
    causes (kube-root-ca.crt missing ×3, DIV-015, a KWOK limit), none failing, PENDING empty; the
    cases it cannot run yet are listed in the report (FIDELITY §6.8). Transcripts
    (`packages/k8s/transcripts/kubectl/get/`): every printer plain and wide, yaml/json/name, Lists,
    mixed types, type/name pairs, `all`, selectors, `-A`, empty results, not-found, unknown types,
    unknown flags, real-but-unsimulated flags, formats, types and commands, refused connections and
    kubeconfig errors. `get -w` streams in virtual time and Ctrl-C ends it with status 1
    (`kubectl/cmd/get.watch.test.ts`). Latency p95 3.2 ms (ARCHITECTURE §4.9). Script mode showed a
    running three-replica Deployment as table, wide and YAML (`npm run sim -- --objects web.yaml`).
    Help of all 111 commands equals the binary's, piped and at four widths
    (`golden:kubectl-manifest -- --check`).
  - Decisions D-066 (categories skip unstored types), D-067 (dispatcher over the manifest, no-effect
    lists), D-068 (connection by address), D-069 (credentials ignored), D-070 (help rendered and
    proved), D-071 (Tables in the API server), D-072 (differential runner). Divergences DIV-031…033.
    `docs/ARCHITECTURE.md` §4.9 (new), `docs/FIDELITY.md` §6.7, §6.8 (new; Known limits is §6.9).
  - Fixed on the way: `apimachinery/gojsonsyntax.ts` read characters as single bytes (U+0122 looked
    like `"`), so quoted characters and offsets were wrong for non-ASCII JSON; it scans UTF-8 now.
    The upstream checkout gained cobra, pflag, liggitt/tabwriter, go-wordwrap, go-yaml v2,
    sigs.k8s.io/yaml, client-go clientcmd/rest/discovery/restmapper, Go's strconv and
    `pkg/util/node` (which confirmed the printer's `NodeLost`).
  - Surprises. kubectl reports an unknown type as `error: the server doesn't have…` (builder.go
    wraps it; checkErr's own NoResourceMatch branch is never reached). A NotFound outside `default`
    makes kubectl GET the namespace and report that instead. A list's BadRequest is rewritten to
    `Unable to find "/v1, Resource=pods" that match label selector …`. `--help` is undefined while
    cobra finds the command, so `kubectl --help get` prints kubectl's help. `kubectl rollout` prints
    help and exits 1, `kubectl config` prints it on stderr. Help prints `[]` for StringSlice and
    StringArray alike, so flags the simulator does not define are read as StringArray. The
    empty-user kubeconfig makes real kubectl prompt for a password on https (D-069). `get endpoints`
    prints the Endpoints deprecation warning. Go's toolchain updates its local telemetry counters
    in `~/.config/go/telemetry/local` on every run (the YAML agent compiled the vendored Go code
    against fuzzed inputs, with the build cache in the scratchpad); nothing else outside the repo.
  - For later phases. 07b: `kubectl create`/`apply` replace the `# objects:` header, the sim
    option and the runner's shim entries; `decodeManifestStream` and `unmarshalYaml` give `-f`'s
    parsing and errors; `printJson` without `sortKeys` gives typed generator output; warnings
    print through `session.ts`. 08: `logs`, `rollout`, `explain`, imperative verbs; delete their shim
    entries. 15: jsonpath, custom-columns, `--sort-by` (send `includeObject=Object`), `-o kyaml`.
    17: replace `Machine.addresses` with interfaces and DNS. 20a/25b: credentials. 27: route the
    components' clients through the transport.
  - Workflow: four agents (YAML/JSON, server and client tables, help, differential runner) worked
    in parallel on the framework written first.

- 2026-11-16 — **Phase 06b done.** Kubelet, container runtime, behavior models.
  - Built: `packages/k8s/src/kubelet/` — the kubelet as a controller-runtime instance per node
    (`kubelet.ts`), pod workers that suspend on CRI calls (`pods.ts`: sandbox, the serial image
    puller, create, start, back-offs, the reason cache, termination, deletion, GC), Pod status
    (`status.ts`: generateAPIPodStatus, getPhase, conditions), the container process (`env.ts`:
    command/args against Entrypoint/Cmd, env with `$(VAR)` and service variables, containerd's and
    runc's merge), node side (`node.ts`: start events, Lease, status with images, idle heartbeats),
    PLEG (`pleg.ts`), latencies (`latency.ts`), `backoff.ts`, `seed.ts`.
    `packages/k8s/src/runtime/` — the node's containerd as world data (`k8sSlice.runtimes`, slice
    version 4): sandboxes with host-local IPs, containers driven by behavior models, CRI log files
    and `/var/log/containers` links (`logs.ts`), images (`images/`: distribution/reference parser,
    pull outcomes and containerd's error texts, file tables, the captured catalog).
    `packages/host/src/models/` — the behavior model contract, the container shell (dash, ash,
    bash variants, resumable), utilities, and the image programs (nginx, its entrypoint, httpd,
    redis, pause, the `component` stand-in). Node health monitoring in the node lifecycle
    controller (`controllers/nodelifecycle/health.ts`). Tools: `npm run images:capture`
    (`tools/src/images/`), and `npm run upstream:fetch` now checks out several repositories
    (containerd v1.7.28, runc v1.3.0, Go 1.23.11, nginx, httpd, four redis tags).
  - Exit criteria, each a test in `packages/k8s/src/kubelet/kubelet.test.ts`: a three-replica
    Deployment Running and Ready on both workers 1.5–15 s after creation (nginx pulled, events
    Pulling/Pulled/Created/Started, repo tag and digest, containerd ids, Pod IPs from each node's
    CIDR); a wrong tag alternates ErrImagePull/ImagePullBackOff with the exact messages and pulls
    spaced by 10/20/40/80 s plus at most the jittered requeue; a crashing container restarts at
    once, then after ≥10/20/40/80 s, with rising restart counts, CrashLoopBackOff and the BackOff
    event text; exit 0 under Never ends Completed/Succeeded with PodCompleted conditions; a missing
    executable gives runc's full error, StartError 128 and RunContainerError; deleting a Pod shows
    Killing, `sleep` waits out the 30 s grace and dies with 137, nginx stops on SIGQUIT in under a
    second, the ReplicaSet replaces the Pod at once; with a kubelet stopped Pods and the Lease stop
    changing while containers keep logging, and a restart adopts running containers; a silent node
    goes Unknown 40–60 s after the stop with NodeNotReady, Pods marked not ready and the
    unreachable taint, and recovers; logs are CRI lines with increasing stamps and the world hash
    is the same on reruns. The container shell replays 59 scripts captured from the real dash,
    BusyBox and bash (`fixtures/reference/container-shell/`). Exercised in `npm run sim`: the node
    filesystems show `/var/log/pods` and `/var/log/containers` with the real modes; scenario runs
    through a scratch script showed CoreDNS pulled and Running two seconds after the build. No
    kubectl yet, so nothing was tried in `npm run play` beyond the files.
  - Decisions D-058 (kubelet, pod workers, sync triggers, modeled choices), D-059 (runtime as node
    data, IPAM, logs), D-060 (behavior model contract in host, per program), D-061 (captured
    catalog, the `[sim]` rule for images), D-062 (node side), D-063 (health without NoExecute),
    D-064 (seeded running containers), D-065 (latency table). Divergences DIV-021…DIV-030.
    `docs/BEHAVIOR_MODELS.md` (new), `docs/ARCHITECTURE.md` §3.9 and §4.8 (new),
    `docs/FIDELITY.md` §1 (containerd, runc, Go and the image programs' pins),
    `docs/SCENARIO_FORMAT.md` §5.4/§14.
  - Fixed on the way: the scheduling replay and the scheduler test compared fields the kubelet now
    writes (PodScheduled's observedGeneration, Node events in `default`); the topology golden test
    drops `status.images` as a kubelet-only field; the rollout bound tests got an explicit timeout
    (they took over 5 s with the larger suite in parallel); stale comments in `topology/nodes.ts`,
    `topology/build.ts`, `topology/kubeadm.ts` and `testing/kubelet.ts`.
  - Surprises. The waiting reasons reach the API one sync after their events (the reason cache), so
    ErrImagePull and ImagePullBackOff alternate, and CrashLoopBackOff shows only once the worker
    wakes for an expired or long back-off; the kubelet must not sync on its own status writes
    (status-only updates are reconciles). containerd 1.7 reports no `user`; ErrImagePull's message
    keeps `rpc error: code = NotFound desc =` only for NotFound (the CRI client strips Unknown).
    The kubelet's Image back-off BackOff event is Normal, the crash-loop one Warning. Docker Hub
    answers 401 insufficient_scope, not 404, for a missing repository. BusyBox's NOFORK `sleep`
    with a bad operand ends the whole shell. kubeadm 1.37 pulls pause:3.10.2 while containerd 1.7
    runs sandboxes with pause:3.8. Tags moved during the session: nginx latest is 1.31.8, alpine
    3.24, redis 8.10.3, so `images:capture -- --check` will report drift over time.
  - For later phases. 07a: `kubectl logs` reads `/var/log/pods/<ns>_<pod>_<uid>/<c>/<n>.log`
    (strip the CRI prefix; `--previous` is n−1, kept because the kubelet keeps one dead container);
    `describe pod` has everything in status and events (fieldPath on container events). 09: the
    declarative image model of SCENARIO_FORMAT §5.4 compiles to a ProgramModel
    (`docs/BEHAVIOR_MODELS.md` §6). 16a: init containers (pods.ts skips them with a gap),
    `valueFrom`/`envFrom` (env.ts), container files (`ProcessInput.file`). 16b: probes set
    `started`/`ready` in `status.ts`; OOMKilled. 17: `exec` into a container uses the same models
    and the `sh` model. 18a: the DaemonSet controller replaces `seedDaemonSetPods`. 20b:
    DefaultTolerationSeconds, NoExecute taints and taint eviction (D-063). 26a: tie
    `startKubelet`/`stopKubelet` to kubelet.service, read `/var/lib/kubelet/config.yaml`. 27: real
    models for the control-plane binaries instead of `component`.
  - Workflow: five agents — kubelet Pod lifecycle research, node/lease/health research, the
    multi-repository upstream fetch with containerd/runc error research, the image catalog capture,
    and the image program models — ran while the shell, runtime and kubelet were written.

- 2026-11-16 — **Phase 06a done.** Cluster topologies and kube-scheduler.
  - Built: `packages/k8s/src/topology/` — `ClusterDef` data (`cluster.ts`: `kubeadm-1cp-2w`,
    `kubeadm-1n`), one builder (`build.ts`), Nodes and Leases as a kubelet leaves them (`nodes.ts`,
    from upstream's setters: condition order, declaredFeatures, runningInUserNamespace), kubeadm's
    files and objects (`kubeadm.ts`, from `kubeadm/reference.ts`, which `npm run kubeadm:capture`
    generates from the real kubeadm's `init --dry-run`; mirror Pods and kube-proxy Pods seeded as
    running; kubeadm, kubelet, kubectl binaries as stubs with real sizes). `packages/k8s/src/scheduler/`
    — snapshot, cycle (PreFilter/Filter/PostFilter message/Score/heap), filter and score plugins,
    queueing hints, the queue on the controller runtime with the 5-minute flush, events through
    `controllers/events.ts` (the events.k8s.io recorder, D-054), start/stop. A minimal node
    lifecycle controller (NoSchedule tainting pass). The API server serves DaemonSets
    (`registry/apps/daemonset.ts`, golden case `api/daemonset`, byte-for-byte) and checks
    `pods/binding` preconditions. The runtime gained `ControllerSpec.user`, a `kube-scheduler`
    component and the controller's data in watch handlers. The CLI loads the k8s plugin.
  - Exit criteria, each a test. FailedScheduling messages equal the golden fixtures for an
    untolerated taint, an unmatched node selector, unsatisfied required affinity (and a nonexistent
    node in matchFields, which fails at PreFilter), insufficient cpu, memory, both, extended
    resources, host ports, cordoned nodes and a different reason on each node, with the preemption
    part ("not helpful", "No preemption victims", "preemptionPolicy=Never"):
    `tools/src/golden/scheduling.test.ts` replays all 9 scheduling cases (7 new) event for event,
    PodScheduled conditions included. Fixing the cause schedules with no further input: label,
    untaint, uncordon (with the real extra failure while the unschedulable taint lingers), deleting
    the port holder, freeing cpu, offering the extended resource (same file), adding a toleration
    (`scheduler/scheduler.test.ts`). Scheduler stopped: no binding, no condition, no event for 10
    minutes, then a start schedules. Deterministic per seed and 6 replicas split 3/3 over the
    workers. Nodes equal the oracle's in shape except KWOK-only fields (`tools/src/golden/topology.test.ts`).
    Topologies as data: `topology/topology.test.ts` (kubeadm-1n runs CoreDNS on its one node).
    Exercised with `npm run sim -- --topology kubeadm-1cp-2w`: root@controlplane, kubeadm's files,
    `kubectl` prints the `[sim]` notice (07a). No kubectl yet, so Pods and events were exercised
    through the tests only.
  - Decisions D-055 (topologies as data, entry, no workstation yet), D-056 (scheduler), D-057
    (kubeadm reference, what is left out); D-054 (events broadcaster, by the recorder agent); D-037's
    reasoning corrected (the tie comes from parallel filtering; no `selectHost` in v1.37).
    Divergences DIV-019 (static Pod config hash), DIV-020 (no PodTopologySpread/InterPodAffinity
    scoring). `docs/ARCHITECTURE.md` §4.3 (scheduler) and new §4.7 (topologies);
    `docs/SCENARIO_FORMAT.md` §5.1 lists the topologies; `docs/FIDELITY.md` §6.1 (oracles), §6.6.
  - Fixed on the way: the carry-over "concurrent oracles" (one state file per oracle; `down` and
    `env` take a directory; `golden:capture` owns its oracles), with a bug where `down`'s leftover
    check matched its own command line. The upstream checkout gained `staging/src/k8s.io/kube-scheduler`.
    The CLI's `PLUGINS` comment claimed Kubernetes registered itself; it now loads `k8sPlugin`.
  - Surprises. The taint reason is the literal "node(s) had untolerated taint(s)". A request above
    a node's allocatable makes that node "not helpful" for preemption; below it, "No preemption
    victims found". Uncordoning makes the scheduler fail once more, on the node lifecycle
    controller's `node.kubernetes.io/unschedulable` taint (timeAdded set), before succeeding. The
    second FailedScheduling after the 5-minute flush is a new Event, not a series: its `regarding`
    has the resourceVersion after the condition write; the third joins it as a series. A cordoned
    node reports "were unschedulable" even to a Pod whose selector excludes it (first filter wins).
    kubeadm 1.37 writes no cri-socket annotation and an empty `kubeadm-flags.env`; etcd falls back
    to 3.7.0-0; containerd 1.7 would get a RuntimeConfig preflight warning (for 29a). A joined
    worker's kubelet.conf uses `default-cluster`/`default-auth` names (the kubelet writes it).
    The Priority admission plugin rejects `preemptionPolicy: Never` without a class (20b).
  - For later phases. 06b: the kubelet takes over Node status (keep `nodes.ts` values as the
    registration), Leases, images (ImageLocality scoring reads `status.images`) and Pod status of
    the seeded Pods; CoreDNS should start running; the scheduler's Scheduled event already exists.
    07a: the kubeconfig's server is `https://172.16.0.10:6443`, found in `k8sSlice.apiServers`;
    reading `scheduling/*` fixtures' `get events` tables needs the events.k8s.io view (no count
    until a series; `-o wide` prints 1). 18a: replace `seedDaemonSetPods`, reuse its toleration and
    affinity code. 20a: create kubeadm's RBAC objects from the reference. 20b: Priority admission
    and PriorityClass (the `preemption` case's `cpu-1-never` then needs no stand-in), preemption,
    topology spread and inter-Pod affinity (the default profile's order is in
    `scheduler/plugins/filters.ts`). 25b/28: fill the `<<cert:…>>` tokens of the reference.
    27: replace the seeded mirror Pods and the topology's direct starts.
  - Workflow: six agents in parallel (scheduler research, Node shape research, events.k8s.io
    recorder, DaemonSet kind, golden captures plus the oracle carry-over, kubeadm capture) while the
    scheduler and topology were written.

- 2026-11-16 — **Phase 05b done.** Controller runtime and the first controllers.
  - Built (`packages/k8s/src/controllers/`): the runtime (`runtime.ts`: watch-fed queues in world
    data, one key per sync event, 5 ms modeled latency, client-go's per-key backoff, maxRetries,
    start/stop, `controller.sync`/`controller.write` trace records with causes), the event
    recorder (`record.ts`, client-go's correlator: counts, aggregation, spam filter),
    `manager.ts` (upstream start order), `catalog.ts`. Controllers: deployment (rolling and
    recreate, proportional scaling, revisions and history limit, the rollback annotation, paused,
    progress deadline, conditions), replicaset (slow start, victim ranking, adoption and release,
    status), garbage-collector (background, foreground, orphan, dangling and UID-mismatch owners),
    namespace (the deleter and its five conditions), serviceaccount, endpointslice (the
    staging/endpointslice reconciler, trigger times, tracker, hints), endpoints (RepackSubsets,
    truncation). `hash/`: the exact pod-template-hash (D-053). The API server gained
    `pods/binding` (D-048) and `namespaces/finalize` (D-050). `testing/kubelet.ts` (fake
    scheduler+kubelet) and `testing/workloads.ts` (what kubectl sends for create deployment, set
    image, scale, rollout undo). Six new golden cases in `fixtures/golden/cases/controllers/`
    (ReplicaSet Pods and Event objects, endpoints with not-ready and named ports, stuck rollout,
    paused, namespace deletion, orphan and foreground GC), with a KWOK stage for not-ready Pods
    (annotation `simlab.dev/kwok-not-ready`). The upstream checkout gained client-go's
    record/events/workqueue, staging/endpointslice, pkg/util/hash and vendored go-spew,
    k8s.io/utils/dump and integer, inf.v0.
  - Exit criteria, each a test: Deployment → ReplicaSet → Pods and scaling
    (`deployment/deployment.test.ts`, `replicaset/replica_set.test.ts`); rolling updates checked
    every virtual millisecond against maxSurge/maxUnavailable for three strategies, rollback
    reusing the old ReplicaSet with the next revision; the never-ready rollout stops at old 3/new 2
    with ProgressDeadlineExceeded exactly as `controllers/rollout-stuck`; background cascade and
    orphan deletion (`garbagecollector.test.ts`, `deployment/golden.test.ts` with
    `controllers/gc-orphan-foreground`); a Service has endpoints exactly for ready matching Pods,
    relabeling moves them (`endpointslice.test.ts`, `endpoints.test.ts`, against
    `controllers/endpoints`); Deployment conditions and events equal `deployments/rollout`,
    `deployments/create-and-read` (incl. the literal hash `69c6f74b8b`), `controllers/paused` and
    `controllers/replicaset-pods`; same seed → same world hash in every controller's tests.
    Exercised end to end with a script (deployment, rollout to a new image, all controllers): real
    hash names and event sequence, identical world hash on reruns. No program reaches the API yet,
    so there was nothing to try in `npm run play`.
  - Decisions D-047 (reads from the store, latency, backoff), D-048, D-049 (recorder state),
    D-050, D-051 (backoff override, `initial`, slice pseudo-keys), D-052 (merge patches for
    ownership), D-053. `docs/ARCHITECTURE.md` §4.3 rewritten, §4.6 has the Go layout file;
    `docs/FIDELITY.md` §6.4/§6.5 (endpoint sorting in captures, the not-ready KWOK stage).
  - Fixed on the way: `.gitignore`'s `data/` ignored `packages/k8s/src/openapi/data/` and
    `discovery/data/`, so phase 05a's vendored schema and registry were never committed and a
    fresh clone could not pass the gate; the pattern is now `/data/` and the files are committed.
    The finalizer name check (05a) accepted only `kubernetes` as a standard name; upstream's
    `IsStandardFinalizerName` also accepts `orphan` and `foregroundDeletion`, without which every
    status write of an object being deleted in the foreground failed.
  - Surprises. The collision count is hashed as 8 little-endian bytes, not 4. go-spew prints
    strings raw under `%#v`. A template's hash depends on the controller manager's time zone when
    it has timestamps (D-053). Upstream's namespace controller finalizes with the object read
    before its own status update, so every finalize meets one 409 and retries (visible in the
    trace); likewise a second status write in one Deployment sync. EndpointSlice ports are ordered
    by an FNV-128a hash of their spew dump, which happens to look like name order in the fixture.
    The real endpoint order within a slice varies between runs. No events for ProgressDeadline,
    pause or resume. A foreground-deleting Deployment has no `status.replicas`.
  - For later phases. 06a: the scheduler binds through `pods/binding` and runs on the controller
    runtime; it must create the topology's Nodes (the EndpointSlice controller needs them); KWOK's
    not-ready Pods carry no reason/message on their False conditions, a real kubelet writes
    `ContainersNotReady` (06b). 06b: replace the fake kubelet in scenario code (it stays for
    tests). 07a/07b: `testing/workloads.ts` shows the requests kubectl's create deployment, set
    image, scale and rollout undo send; the events.k8s.io view of events has `deprecated*` fields
    and no `reportingInstance` when empty (`controllers/replicaset-pods`). 18a: reuse
    `controllerref.ts`, `controller_utils.ts`, `podcontrol.ts` and `hash/`. 27: tie
    `startControllerManager` to the process. The GC scans every monitored resource per lookup; add
    a UID index if it gets slow.
  - Workflow: two agents (hash port, golden captures) ran while the runtime was written, then
    three controller agents (deployment+replicaset, GC+namespace+serviceaccount,
    endpointslice+endpoints) worked in parallel on it.

- 2026-11-16 — **Phase 05a done.** The API server: vendored schema and registry, store and watch,
  request pipeline, 13 kinds (plus IPAddress and ServiceCIDR minimally), a client.
  - Built: `npm run api:vendor` (`tools/src/openapi/`: OpenAPI v3 plus a reader of the Go type
    declarations, which give encoding/json's behavior; D-038) writes the schema
    (`packages/k8s/src/openapi/data/v1.37.2.ts`) and the resource registry from the oracle's
    discovery (`src/discovery/`; D-041). `src/apimachinery/`: Go JSON decode/encode against the
    schema (`gojson.ts`), field errors and Status errors in upstream formats, names and ObjectMeta
    validation, label and field selectors, quantities, IntOrString, merge patch, times, IP/CIDR,
    base64/PEM. `src/apiserver/`: store (etcd data per data directory, revisions, watch
    subscriptions, a 75 s/100-event history), the pipeline (stage order verified and documented in
    `docs/ARCHITECTURE.md` §4.2), NamespaceLifecycle admission (D-039), bootstrap. Strategies in
    `src/registry/`, defaulting and validation in `src/apis/`: Namespace, ConfigMap, Secret,
    ServiceAccount, Node, Pod, Service (IP allocation through IPAddress objects, NodePorts), Endpoints,
    EndpointSlice, Event in both APIs on one storage (D-044), Deployment, ReplicaSet, Lease.
    `src/client/client.ts`. The golden case format has a `request` step; five raw API cases in
    `fixtures/golden/cases/api/` (discovery, crud, lifecycle, validation, defaults).
  - Exit criteria. Defaulted objects: `tools/src/golden/defaulted.test.ts` creates
    `objects/defaulted`'s manifests through the pipeline and gets the stored objects back
    (minus controller, KWOK and admission fields, named per field); `api/defaults` covers every
    kind of the phase. Validation messages: every step of `api/validation` (missing selector,
    mismatch, names, unknown field strict and warn, wrong types, immutable selector, Pod update
    rules, Services, ConfigMaps, Namespaces) matches the real server's Status body byte for byte,
    except the Pod update's diff (DIV-016). Concurrency, finalizers, graceful deletion and
    selectors: `api/crud`, `api/lifecycle` steps and `apiserver/pipeline.test.ts`. Watch order and
    world hash: `pipeline.test.ts` (same seed → same hash, snapshot/restore, fork independence).
    Schema size and load time: `docs/ARCHITECTURE.md` §4.6 (`npm run bench:schema`). Divergences:
    DIV-015 (managedFields), DIV-016, DIV-017 (Pod warnings), DIV-018 (Event TTL). Exercised live:
    an ad-hoc probe sent new requests (not in any fixture) to a running oracle and to the
    simulator; all matched except allocated IPs/NodePorts (random) and admission fields. No
    program can reach the API yet, so there was nothing to try in `npm run play`.
  - Surprises. The real server de-duplicates Invalid causes, not only the message (checked on the
    oracle; upstream source suggests otherwise). Strict field errors on a merge patch are a 422 on
    the field `patch`, not a 400. Pods have `generation` (1 on create, +1 on spec change and on
    graceful deletion); Deployments bump it on annotation changes too. A DELETE of a ConfigMap
    answers a Success Status without `code`; Pods, Services, Namespaces return the object. An
    unbound Pod is stored with a deletionTimestamp and removed in the same request. Lease refuses
    unconditional updates with an Invalid naming the resource (`leases.coordination.k8s.io`).
    ClusterIPs come from the upper half of the range first; dry-run Services show 10.96.0.0 and
    NodePorts 32769, 32770, …. `image: nginx` (no tag) defaults to `imagePullPolicy: Always`.
    The workstation's Go 1.27 prints JSON errors in jsonv2 wording, the oracle in the old one, so the
    oracle is the reference for Go library messages. Feature gate defaults are in
    `pkg/features/kube_features.go` (added to the checkout at the end; the Pod port used the
    oracle's `/metrics`, `apis/core/validation/options.ts`).
  - For later phases. 05b: watch with `client.resource(…).watch(ns, {resourceVersion}, owner)`
    and read events after `k8s.watch:<id>` is published; list then watch at the list's
    resourceVersion is replayed from history. (05b served `namespaces/finalize`; `lifecycle#6`
    stays a KNOWN entry, for timing reasons now stated in `tools/src/golden/api.test.ts`.) 07a: `ApiResponse` has a third case,
    `notSimulated`, for the `[sim]` notice; warnings come back in `warnings`; Status bodies are
    what kubectl formats (`errors/validation` shows kubectl's renderings of the same errors).
    20b: delete the admission stripping in the differential tests (D-046).
  - Upstream checkout gained `apiserver/pkg/storage`, `kube-aggregator/pkg/apis`,
    `pkg/controlplane`, `pkg/api`, `pkg/features`.
  - Workflow: three research and helper agents (request semantics, Quantity, selectors and merge
    patch) and three kind agents (Pod/apps, Service/endpoints, the rest) worked in parallel on the
    core written first; a running oracle answered their questions.

- 2026-11-16 — **Phase 04 done.** The real control plane as an oracle; 20 golden cases captured.
  - Built: `tools/src/oracle/` (`binaries.ts` fetches and verifies kube-apiserver,
    kube-controller-manager, kube-scheduler, kubectl, kubeadm v1.37.2, etcd v3.7.0 and KWOK v0.8.0
    into `.upstream/bin/v1.37.2/`, digests pinned in `checksums.json`; `controlplane.ts` up/down;
    `pki.ts`; `topology.ts` with the `kubeadm-1cp-2w` Nodes; `kwok-stages.yaml`; `cli.ts` =
    `npm run oracle -- fetch|up|down|status|env`). `tools/src/golden/` (`case.ts` format,
    `normalize.ts`, `tabwriter.ts` = kubectl's tab writer and its inverse, `capture.ts` =
    `npm run golden:capture`, `pty_run.py`, `kubectl_manifest.ts` =
    `npm run golden:kubectl-manifest`). Tokens shared with transcripts:
    `packages/host/src/transcript/tokens.ts`; the transcript test accepts them. Cases in
    `fixtures/golden/cases/` (pods, deployments incl. rollout, services, namespaces, configmaps,
    nodes, defaulted objects, errors, apply, delete, scheduling, and five client-only cases),
    fixtures in `fixtures/golden/v1.37.2/`, plus `kubectl-commands.json` (109 commands, 30 global
    flags). Docs: `docs/FIDELITY.md` §6 (new), `docs/TRANSCRIPTS.md` Tokens, D-033…D-037.
  - Exit criteria. `npm run oracle -- up` (about 12 s) and `down` leave no process or port: `down`
    checks with `kill -0`, `ss` and `pgrep` and fails otherwise; shown at the end of the session.
    All 20 cases re-capture byte-identical (`npm run golden:capture -- --check`, run several
    times). The manifest re-generates identically (`--check`). `npm run check` reads only
    committed files; it was run inside `unshare -rn` (no network) and passed.
  - Surprises. kubectl 1.37 prints `deployment.apps "web" deleted from default namespace` and
    offers `-o kyaml`. `kubectl get` aligns with github.com/liggitt/tabwriter (RememberWidths),
    but each kind gets its own writer (`get all`'s tables have independent widths). describe
    writes Conditions as `"%v \t%v \n"`, so cells end in a space the layout reveals. The
    scheduler's tie-break between the two identical workers is random (D-037). kubectl prints
    local time unless `TZ=UTC`. The scheduler's events carry `reportingInstance:
    default-scheduler-<hostname>`, and leader leases `<hostname>_<uuid>`: mapped to
    `controlplane`. Ports chosen as free in the ephemeral range got taken by the components'
    own outgoing connections; oracle ports now come from 20000–29999.
  - For later phases. 05a: defaulted objects in `objects/defaulted`, validation errors in
    `errors/validation` (missing selector, mismatch, names, unknown field, wrong type, immutable
    selector, Pod update forbidden). 05b: `deployments/rollout` (events, ReplicaSets, history).
    06a: build the topology from `tools/src/oracle/topology.ts` (D-033), compare Nodes with
    `nodes/read`; FailedScheduling messages in `scheduling/failures` (KWOK's Node conditions are
    not real). 07a: the differential runner should normalize simulator output with
    `normalizeText`/`normalizeJson` from `tools/src/golden/normalize.ts` (re-aligned tables,
    sorted suffix rows), skip or relax steps marked `kwok`, and read `kubectl-commands.json`;
    the tab writer port in `tools/src/golden/tabwriter.ts` (render) can move into `packages/k8s`
    for the simulator's printers, with tools importing it. 07b/08: `delete/cascade`,
    `apply/created-configured-unchanged`, `client/generators`, `client/config`,
    `client/kustomize`, `client/help` (80-column help).
  - Known gaps. No kube-system workloads in the oracle (no CoreDNS, kube-proxy, static Pods);
    a case that needs them creates them. kubectl progress lines and `--watch` are not captured
    (timing). Kubelet-side output waits for tier 2 (phase 32). Fixtures are YAML with literal
    blocks; trailing spaces inside them are significant (describe's `Container ID:   `), so
    editors must not strip them (fixtures are never edited by hand anyway).
  - Fixed on the way: `docs/ARCHITECTURE.md` §6 assigned the provenance registry to phase 04;
    `prompts/07a` builds it, and the table now says so.

- 2026-11-16 — **Phase 03 done.** Terminal, line editor, completion, editor protocol, `play` and `sim`.
  - Built: the line discipline and readline's emacs mode in the engine (`packages/host/src/tty/`:
    `discipline.ts`, `editor.ts`, `display.ts`, `keys.ts`, `bindings.ts`, `complete.ts`; `screen.ts`
    is a terminal model for tests and script mode). bash reads with `ProcApi.readLine`, decodes and
    expands PS1/PS2 (`shell/prompt.ts`), completes through `shell/complete.ts`, honors
    `--noediting`, and sets `$?` to 130 after Ctrl-C at the prompt. The editor protocol
    (`proc/editor.ts`, inputs `editor.save`/`editor.close`, output records `editor.open`/
    `editor.status`) and the programs `vim` and `nano` (`programs/editors/`). The base system gained
    vim, vim-tiny, nano and sensible-utils with their alternatives (`editor`, `vi`, `vim`, `view`,
    `ex`, `pico`, plus `pager`, `rmt`, `nawk` that the old hand-written table missed), read from the
    packages' maintainer scripts. `apps/cli`: `play.ts` (raw-mode player, `$EDITOR`, recording,
    `--replay`), `sim.ts` (script mode), `player.ts`/`script.ts` (their testable cores), the
    topology `ubuntu-1` (`packages/host/src/topology.ts`). Kernel: `OutputRecord` is a union,
    registry kind constants (`TOPOLOGY`, …), `ENGINE_VERSION` 0.2.0, host slice version 2.
  - Exit criteria. Key-level tests: `tty/editor.reference.test.ts` replays 38 cases captured from
    real bash 5.2.21 on a pty (`fixtures/reference/bash/readline.{py,json}`) and requires the same
    screen and cursor after every key: editing, kill and yank, history, Ctrl-R (incl. failed,
    repeated, aborted), Ctrl-C at the prompt and during `sleep` and `cat`, Ctrl-D, wrapping at and
    across the margin, multi-line quotes and here-documents, completion with zero, one and many
    matches (common prefix, double Tab, `Display all 150 possibilities?`, `--More--`), typeahead.
    `tty/terminal.test.ts` covers program completers, `cd`, `~user`, notices, Ctrl-Z, resize,
    hang-up and a half-typed line across snapshot/restore. The player was run for real on a
    pseudo-terminal (a Python pty driver, since this session has no interactive terminal): pipes
    and redirects, `vim notes.txt` opening a real `$EDITOR` command that appended a line which
    `cat` then showed, Ctrl-C, `exit`; `--replay` of that recording printed "world hash
    fe172bb8974ba82a matches the recording". `apps/cli/src/player.test.ts` checks record → replay →
    same hash in the gate. Script mode works (`npm run sim -- --topology ubuntu-1 -c …`) and
    `CLAUDE.md` documents both commands. Not done by a human yet: the owner sitting in
    `npm run play` with their own editor; worth five minutes before phase 04.
  - Decisions D-026 (notice style: yellow), D-027 (line editor), D-028 (plain vs terminal
    sessions), D-029 (editor protocol), D-030 (CLI, `ubuntu-1`), D-031 (prompt shortcut).
    Divergences: DIV-005 removed; DIV-012 (no bracketed paste), DIV-013 (readline subset),
    DIV-014 (editors are overlays). `docs/COVERAGE.md` has a Terminal section.
  - Surprises. The reference exposed a phase 02 bug: assigning PATH did not empty bash's command
    hash table (fixed in `shell/state.ts`). bash keeps a here-document command's trailing newline in
    its history. When a Tab changed the line, the next Tab only rings the bell and the third lists.
    Command completion marks matches that are directories, so the builtin `.` lists as `./`.
    readline's `\e[4~` (End without an inputrc) rings the bell and inserts `~`, `\e[1~` only rings.
    Ctrl-C at the prompt echoes `^C` where the cursor is. Real bash 5.2 turns on bracketed paste.
  - For later phases. Phase 08's kubectl completer plugs into `ProgramSpec.complete`; through
    `alias k=kubectl` it needs the alias's value, but `completionData` hands the completer alias
    names only (or phase 08 models `complete -F … k`, which is what the real setup asks for).
    Phase 10's web terminal drives the same `tty.*` and `editor.*` inputs and renders the
    `editor.open` record as the overlay; it should decide on bracketed paste (DIV-012). Raw-mode
    readers (a pager, phase 22b) set `Tty.mode` through `setTtyMode` (`tty/discipline.ts`), which
    has no `ProcApi` method yet. The simulated server's `awk` is gawk, as on the cloud image
    (D-032, decided with the owner after this phase; `prompts/22b-awk-jq-pager.md` updated).
  - Workflow: two parallel agents captured the readline reference and regenerated the base
    binaries while the engine was written.

- 2026-11-16 — **Phase 02 done.** Shell, process runtime, 40 programs, the transcript format.
  - Built: processes as world data (`packages/host/src/proc/`): pipes with capacity and SIGPIPE,
    open file descriptions with shared offsets, signals with `finally` cleanup, preemption after
    1000 syscalls, `exec`, a minimal terminal (`tty.open`/`tty.bytes` inputs, Ctrl-C, Ctrl-D,
    `onlcr`), the `[sim]` notice and gap reporting. The kernel gained the `output` port and
    `SliceSpec.attach`, used to end frameless programs after fork and restore while the shell at
    its prompt is recreated from its saved state. The bash subset (`packages/host/src/shell/`):
    real lexer/parser one command line at a time, aliases, here-documents, expansion in bash's
    order, pipelines of subshells that exec, 17 builtins; everything else is a notice. Programs:
    cat, ls, dir, vdir, mkdir, touch, rm, rmdir, cp, mv, ln, chmod, chown, head, tail, wc, sort,
    uniq, cut, tr, tee, grep, base64, sleep, date, env, which, clear, seq, basename, dirname,
    whoami, hostname, id and the binaries echo, printf, true, false, pwd, test, `[`. The base system
    now installs every executable of 14 Ubuntu base packages as stubs or scripts with real sizes
    (`base/binaries.ts`, generated by `tools/src/base/capture_binaries.py`).
  - Exit criteria: all pass. Shell transcripts (`transcripts/shell/`) cover quoting and expansion,
    pipelines of 3–5 stages, redirections including both `2>&1` orders, here-documents into
    pipelines, command substitution, aliases, `&&`/`||`, exit statuses, command not found and
    syntax errors. Every program has golden transcripts for its common flags and errors:
    55 golden-verified files, about 2 200 commands, and `npm run transcript:capture -- --check`
    finds no difference from the real tools. Streaming: `proc/runtime.test.ts` pipes a producer
    that prints every virtual second through `grep` and `cat`, sees each line arrive as time
    advances, and stops it with Ctrl-C (status 130); also SIGPIPE (141), preemption, fork,
    snapshot/restore and replay. `docs/COVERAGE.md` is started.
  - Decisions D-022 (C.UTF-8, sshd's login environment), D-023 (runtime), D-024 (pty capture),
    D-025 (gaps for later phases). New docs: `docs/TRANSCRIPTS.md`, `docs/COVERAGE.md`.
    Divergences DIV-001…DIV-011 in `docs/FIDELITY.md` §5.
  - Surprises. bash orders the exported environment by its variable hash table (FNV-1 mod 1024),
    not by insertion; reproduced exactly. An alias defined on a line is not active on that line.
    `${x:?}` abandons the rest of an interactive line and exits a non-interactive shell with 127.
    `exit 1 2` prints `logout`, then aborts the line keeping `$?`. Python ignores SIGPIPE, and the
    capture had to restore it for its children. In C.UTF-8 coreutils quotes arguments with ‘…’
    but file names in shell style ('a b', "it's").
  - Workflow: programs were written by five parallel agents after the runtime, shell, program
    helpers and transcript tooling existed. The files agent downloaded the coreutils 9.4 source
    tarball (with its gnulib) into the session scratchpad and ported logic from it (rank 2; not
    committed). Later phases that cite coreutils source should add it to the upstream fetch.
    VFS fixes from their findings: O_CREAT with a trailing slash is EISDIR; `link`/`symlink` to a
    name with a trailing slash is ENOENT; truncation publishes the file topic. Gaps they found
    and left: no fstat/lseek in `ProcApi`, `wait` takes one topic, no directory-change topic for
    programs, no lchown/lutimes in the VFS, no `umask` builtin.
  - For phase 03: the session in `transcript/session.ts` is the base for script mode; the shell
    passes its prompt in each read (`readLoop` in `shell/bash.ts`), echo and `^C` echo belong to
    the line discipline, and a foreground job killed by SIGINT already gets bash's newline.
    `tty.open` exists as an input.

- 2026-11-15 — **Phase 01 done.** Kernel and VFS, with every exit criterion tested.
  - Built: `packages/kernel` contains the world (containers plus frozen values), tables, a binary
    heap event queue, the kernel loop (`runUntil`, `advance`, `settle`, `nextEventTime`, `act`,
    inputs, topics, a livelock guard), xoshiro128** streams, a Merkle cyrb53 hash with a cache,
    fork, snapshot and restore with version checks, the input log, recorder and replay with
    checkpoints, the interactive driver's logic, the trace buffer and ports, the registry, the
    check, fault, step and topology contracts, and civil-date functions. `packages/host`
    contains machines, the VFS (`createFs`: 21 calls with Linux check order and errno), Ubuntu's
    link protections, generated files and devices, executable stubs, users from
    `/etc/passwd` and `/etc/group`, and `buildUbuntuBase`. 172 tests in 24 files.
  - Exit criteria. Determinism (same seed and log give the same hash, snapshot plus continue
    equals continue, a fork never affects its parent) is tested in
    `packages/kernel/src/determinism.test.ts`. Pending events and waiters survive restore (same
    file). VFS edge cases, permissions and every errno are covered by
    `packages/host/src/vfs/linux-reference.test.ts`, which replays 90 captured Linux cases, and
    `fs.test.ts`. Fork takes 1.2 ms (median) for 3 machines and 9 708 inodes, against a 10 ms
    target, so the representation stays. The numbers are in `docs/ARCHITECTURE.md` §2.7;
    rerun them with `npm run bench:fork`.
  - Decisions D-018 to D-021 in `docs/decisions.md`: kernel API refinements; users, groups and
    environment as files; simulated hosts are Ubuntu 24.04.5 LTS built from the essential
    packages' real files; where rank 3 captures live (`fixtures/reference/`).
  - Surprises. A recorded input could run before zero-delay events already due at the same
    instant, while replay ran them first, so `Kernel.input` now drains due events (found by the
    replay test). mkdir(2) drops set-group-ID from its mode argument, so the base builder chmods
    after mkdir, as base-files does. `/bin/../etc` is ENOENT on a usrmerged system, because `..`
    is physical. Ubuntu's procps turns on `protected_regular = 2` and `protected_symlinks = 1`,
    which apply to root too: root cannot `>` into another user's file in `/tmp`. Pop!_OS keeps
    Ubuntu's identity files as `*.diverted`, which gave a verified `os-release`.
  - For phase 02. Decide the simulated locale (FIDELITY §2.1) and the process slice budget
    (ARCHITECTURE §6). Add the fork hook that ends running programs, and deferred deletion of
    open unlinked files. `checkExec` returns the inode; deciding script versus binary (the
    kernel's ENOEXEC) is the exec layer's job. `/etc/profile` sources `/etc/profile.d/*.sh`,
    which is still empty (D-020).
  - Workflow: the tools package now depends on `@simlab/kernel` and `@simlab/host`, with the
    lockfile updated offline. New memory: `memory/no-glob-rm-on-variable-paths.md`.

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
    the system `awk`; a stock Ubuntu server's `awk` is mawk (`/usr/bin/mawk`) (later corrected: the
    cloud image has gawk as `awk` too, D-032), so phase 22b calls
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
