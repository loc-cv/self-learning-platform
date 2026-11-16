# Behavior models

Nothing really executes in Simlab (`PLAN.md` §6.3). A program that runs in a container (and, from
phase 25a, in a systemd unit) is a **behavior model**: a pure state machine over plain data that
says what the process writes, when it wakes up, whether it exits, execs another program or waits,
and how it answers signals. This document is the reference for the contract, the models that
exist, how the container runtime drives them, and the image catalog they run from. Decisions:
D-060 (the contract), D-061 (the catalog), `docs/decisions.md`.

## 1. The contract

`packages/host/src/models/types.ts`. Models are contributed under the registry kind
`host.behavior-model`, one per program, keyed by the name an image's file table maps an
executable to (§4).

```ts
interface ProgramModel {
  name: string;                                   // `sh`, `sleep`, `nginx`
  start(p: ProcessInput): ModelStep;              // the process starts (execve)
  resume(p: ProcessInput, state: Json): ModelStep; // after a `wake`
  signal?(p: ProcessInput, state: Json, s: Signal): ModelStep | 'default';
}

interface ProcessInput {
  argv: string[];               // argv[0] as the caller wrote it
  env: [string, string][];      // in the order the process received it
  exe: Executable;              // { path, model, variant }: what execve ran
  pid: number; init: boolean;   // a container's process is PID 1 of its namespace
  hostname: string; cpus: number; now: Millis;
  which(name: string): Executable | undefined;   // execvp's lookup with this process's PATH
  file(path: string): string | undefined;        // files a model reads (none yet: DIV-029)
}

interface ModelStep {
  output?: { after?: Millis; stream: 'stdout' | 'stderr'; text: string }[];
  next:
    | { wake: Millis; state: Json }                // call resume after this delay
    | { wait: true; state: Json }                  // run until a signal arrives
    | { exit: number; after?: Millis }
    | { exec: { exe; argv; env? }; after?: Millis };
  listen?: { port: number; protocol: 'tcp' | 'udp' }[];
  gaps?: { what: string; detail?: string }[];      // input the model cannot simulate
}
```

Rules:

- **Pure.** The same input gives the same step. A model keeps everything it needs in `state`
  (plain JSON). Time comes from `now`; nothing else.
- **Output is bytes as text.** Lines end in `\n`; a partial line continues in the next output.
  `after` offsets are non-decreasing within a step and at most the next wake-up.
- **Signals.** `'default'` means the program installed no handler. The runtime then applies the
  default action (`defaultSignalAction`): terminate with 128+n, except for PID 1, which the kernel
  does not deliver default-action signals to (pid_namespaces(7)). So `sleep 3600` or a shell
  without a `trap` as a container's command ignores SIGTERM and is killed by SIGKILL (137) when
  the grace period ends, exactly the 30-second wait learners meet on real clusters. SIGKILL never
  reaches a model.
- **Gaps, not guesses.** Input a model cannot simulate is reported in `gaps`; the runtime writes it
  to the gap log and the trace. The model then does the least surprising honest thing (usually:
  keep running without output) and says so in the gap's detail.
- **Grounding.** Every line a model writes for a real program comes from a cited source (hard
  rule 3): the program's source at the version the image ships, the image's own scripts
  (`fixtures/reference/images/scripts/`), or a capture of the real tool on the workstation. Lines
  of an invented application declared by content (§6) are exempt.

## 2. How the container runtime drives a model

`packages/k8s/src/runtime/runtime.ts` (docs/ARCHITECTURE.md §4.8).

1. **argv and environment** (`kubelet/env.ts`): `command` replaces the image's Entrypoint and drops
   its Cmd; `args` alone replaces Cmd. The environment is containerd's default PATH, `HOSTNAME`,
   the image's variables, the kubelet's (the container's `env` with `$(VAR)` expansion, then the
   Services' variables), runc keeping the last of duplicate keys, and `HOME` from the user's entry
   when absent.
2. **The executable**: `imageView(imageId).which(env, argv[0])` resolves it in the image's file
   table (§4). Not found: StartContainer fails with runc's create-time error (exit 128,
   `StartError`, waiting reason `RunContainerError`).
3. **Start**: the model's `start` step. Output due now goes to the CRI log file; output with an
   offset, a wake-up, an exit or an exec is due later, and the runtime keeps one
   `k8s.runtime.container` event pending per container at the earliest of them.
4. **Exec** replaces the model (same PID) and calls the new model's `start`.
5. **Stop** (StopContainer with a timeout): the image's StopSignal (SIGTERM if none) through
   `signal`, then SIGKILL at the timeout.
6. **Exit**: partial lines are flushed (tag `P`), the container is exited with containerd's reason
   (`Completed` for 0, `Error` otherwise), and the kubelet hears it at its next PLEG relist.

Log lines: `/var/log/pods/<ns>_<pod>_<uid>/<container>/<restartCount>.log`, one line per output
line, `<RFC 3339 nano time> <stream> <F|P> <text>`, written at the virtual time the model produced
it. `/var/log/containers/<pod>_<ns>_<container>-<id>.log` links to it.

## 3. The models

### 3.1 Generic (`packages/host/src/models/`)

| Model | Programs | Notes |
|---|---|---|
| `sh` | `sh`, `ash`, `bash`, `dash` | One interpreter, three variants (`sh/variant.ts`): dash in Debian-based images, BusyBox ash in busybox and Alpine images, bash. Resumable: compiled to an instruction list, state = program counter, variables, loop stack, traps. Supported: simple commands with assignments and redirections to `/dev/null`, `>&2`, `2>&1`; `;`, newlines, `&&`, `\|\|`, `!`; `{ }`, `( )`; while, until, for, if/elif/else; quoting; `$VAR`, `${VAR}`, `$?`, `$$`, `$#`, `$0`…`$9`, `$@`; `$(( ))`; `$( )` and backquotes (without waiting); builtins echo, printf, test/`[`, true, false, `:`, exit, export, unset, cd, set -e, trap, exec, read, wait, shift, pwd; the utilities below as children. Error texts (not found, syntax errors, bad numbers) per variant. `sh -c` with no script reads stdin, which is `/dev/null`: it exits 0. Gaps (the container then runs without output): pipelines, `case`, functions, here-documents, background jobs, writes to files, a loop that never waits. |
| `sleep` | `sleep` | GNU (strtod, `s/m/h/d`, `infinity`, several operands) and BusyBox texts. As PID 1 it ignores SIGTERM. |
| `echo`, `printf` | | dash interprets escapes; bash and BusyBox only with `-e`. |
| `date` | | `+FORMAT` and `-u`, in UTC (containers have no time zone). |
| `hostname`, `env`, `printenv`, `cat`, `true`, `false` | | `cat` of a file is a gap (DIV-029). |
| `unmodeled` | any other executable | Runs without output; a gap names the program. |

The shell's behavior is checked against the real dash 0.5.12, BusyBox 1.36.1 and bash 5.2.21 on
the workstation: `fixtures/reference/container-shell/` (`capture.py`, `cases.json`) and
`packages/host/src/models/sh/reference.test.ts`.

### 3.2 Image programs (`packages/host/src/models/images/`)

Each model cites its sources next to the lines it prints: the image's own scripts
(`fixtures/reference/images/scripts/`), the program's source at the image's version (pins in
`docs/FIDELITY.md` §1), and facts read from the image's layers (configuration files, build
strings). Timestamps are the virtual clock in UTC.

| Model | Program | What it does |
|---|---|---|
| `nginx-entrypoint` | `/docker-entrypoint.sh` of the nginx images | The script's own lines and those of the `/docker-entrypoint.d` scripts it runs under default conditions (IPv6 listen enabled, no templates, no autotune or local resolvers), nothing with `NGINX_ENTRYPOINT_QUIET_LOGS`; then `exec "$@"`. A target that is not nginx is exec'd directly; a missing one gives the shell's `exec` error and 127. Other branches (templates, autotune, resolvers) are gaps |
| `nginx` | `nginx`, `nginx-debug` | The master's startup notices on stderr in the error-log format (`using the "epoll" event method`, `nginx/<version>`, `built by …` for the captured builds, `OS: Linux 6.8.0-88-generic`, `getrlimit(RLIMIT_NOFILE): 1048576:1048576`, `start worker processes`, one `start worker process N` per CPU); listens on 80. SIGQUIT (the image's StopSignal): graceful shutdown lines and exit 0; SIGTERM/SIGINT: fast shutdown. `-v`, `-t`, `-q` and invalid options are modeled; without `daemon off;` nginx daemonizes and PID 1 exits 0. nginx 1.14.2 logs nothing (its `error_log` level is `warn`). Worker PIDs are estimated from the forks the entrypoint makes (commented) |
| `httpd-foreground`, `httpd` | the httpd images | `exec httpd -DFOREGROUND "$@"`; AH00489 (`Apache/2.4.71 (Unix) configured -- resuming normal operations`) and AH00094 (`Command line: 'httpd -D FOREGROUND'`). SIGWINCH (StopSignal): AH00492 and exit 0 after a second; SIGTERM: AH00491. AH00558 (ServerName) needs `/etc/hosts` and is a gap until containers have files |
| `redis-entrypoint`, `redis-server` | the redis images | Redis 8: `Starting Redis Server` and the bundled modules' `--loadmodule` arguments; 6.2/7.x: a silent script. The server's lines for each catalog version (`Redis version=…, bits=64, …, pid=1, just started`, the configuration warning or `Configuration loaded`, `monotonic clock`, `Running mode=standalone, port=6379.`, `Server initialized`, `Ready to accept connections tcp`), in redis's `1:M DD Mon YYYY HH:MM:SS.mmm` format; SIGTERM saves the RDB and exits 0 at the next 100 ms cron tick. The modules' own log lines are a gap |
| `pause` | `/pause` | No output; SIGINT/SIGTERM print glibc's `Shutting down, got signal: …` and exit 0 |
| `component` | coredns, etcd, kube-apiserver, kube-controller-manager, kube-scheduler, kube-proxy | A stand-in until their own models (DIV-028): runs without output, exits 0 on SIGTERM |

## 4. File tables

An image's executables come from its layers, listed by `npm run images:capture` (`IMAGE_FILES`
in `packages/k8s/src/runtime/images/catalog.data.ts`): every entry in the PATH directories (the
standard six and the image's own PATH), the entrypoint scripts, and for distroless images every
executable file. `runtime/images/files.ts` resolves a name as execvp does, follows symlinks
(Debian's merged `/bin → /usr/bin`, `/usr/bin/sh → dash`) and BusyBox's hard-linked applets, and
maps the file to a model:

- a BusyBox applet → the model named like the applet (`sh`/`ash` → `sh`), variant `busybox`;
- `dash`, `bash` → `sh` with that variant; GNU coreutils programs → their model, variant `gnu`;
- the official images' entrypoint scripts and programs → their image models (§3.2);
- anything else → `unmodeled`.

Only one image per family has its layers listed; other tags borrow that table (`filesFrom`), an
approximation that can miss a binary one tag added or dropped.

## 5. The image catalog

`npm run images:capture [-- --check]` (`tools/src/images/`) queries Docker Hub and registry.k8s.io
for a fixed list of tags (`tools/src/images/references.ts`) and writes
`fixtures/reference/images/catalog.json` (raw, committed) and
`packages/k8s/src/runtime/images/catalog.data.ts` (generated): per image the repository and tags,
the repo digest, index and linux/amd64 manifest sizes, the config (digest = image ID, Entrypoint,
Cmd, Env, WorkingDir, ExposedPorts, StopSignal, User, labels), the compressed layers; the full tag
list of each captured repository; Docker Hub's official image names; the file tables (§4). Images
on the nodes and in Pods report what containerd reports: `image` is the repo tag
(`docker.io/library/nginx:1.29`), `imageID` the repo digest, the size the index plus one manifest,
the config and the compressed layers.

What a pull yields (`runtime/images/catalog.ts`, D-061, DIV-025):

| Reference | Result |
|---|---|
| A captured tag (or digest) | The image, after a pull whose time follows its size (`kubelet/latency.ts`) |
| A captured repository, tag not in its tag list | containerd's NotFound (`… : not found`) |
| `docker.io/library/<name>` that is not an official image | `pull access denied, repository does not exist or may require authorization: …` |
| A registry under `.example`, `.invalid`, `.test`, `.localhost` | `dial tcp: lookup <host> on 127.0.0.53:53: no such host` |
| Anything else (a real image that was not captured) | `[sim] image … is not in the simulator's image catalog`, and a gap |

To add an image: add its tags to `tools/src/images/references.ts`, run `npm run images:capture`,
and make sure its programs have models (or knowingly run `unmodeled`).

## 6. Declarative models (content images)

`docs/SCENARIO_FORMAT.md` §5.4 lets a content item declare an invented image (`listen`, `routes`,
`requires`, `startup`, `exit`). It will compile into a `ProgramModel` like those above (startup
lines with `after`, listeners, an exit or a wait, `requires` checked through the network model of
phase 17). The generic interpreter is built with the first item that declares an image (phase 09
or later); any field beyond §5.4 is decided then and recorded here.

## 7. Extending

1. Write the model as plain functions in `packages/host/src/models/` (or a domain package for a
   domain-only program), with its sources cited next to each line it prints.
2. Contribute it under `host.behavior-model`; map the executable to it in
   `packages/k8s/src/runtime/images/files.ts` if the file's base name is not the model's name.
3. Test it step by step (`start`, `resume`, `signal`) and through a Pod in a kubelet simulation
   test.
