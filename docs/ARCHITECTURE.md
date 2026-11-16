# Architecture

The contract that phases 01 onward implement. `PLAN.md` §6 and §7 decide what exists; this
document decides how the pieces fit: the data shapes, the interfaces between packages and the
rules that keep the engine deterministic. Interface sketches are TypeScript and are normative in
structure, not in every field name: a phase may add fields, and records the change here.

Reading order: §1 gives the model in one page, §2 to §4 specify the kernel, the host substrate and
the Kubernetes plugin, §5 answers the hard questions in one place, §6 lists what each phase still
has to decide.

## 1. The model in one page

```mermaid
flowchart LR
  subgraph outside[Outside the engine]
    UI[UI or CLI]
    DRV[Time driver]
    LOG[(Input log)]
    SINKS[(Trace, output, gap sinks)]
  end
  subgraph engine[Engine: kernel + host + plugins]
    K[Kernel loop]
    W[(World state<br/>plain data)]
    H[Handlers and actors<br/>pure code over world state]
    P[Program coroutines<br/>frames outside world state]
  end
  UI -- inputs stamped with virtual time --> DRV
  DRV -- deliver input, run until T --> K
  DRV --> LOG
  K -- pop event --> H
  K -- resume --> P
  H -- read, write, schedule --> W
  P -- syscalls --> K
  K -- trace, terminal output, gaps --> SINKS
  SINKS --> UI
```

- **World state** is one tree of plain data. Everything the simulated environment *is* lives
  there: machines, files, processes, Kubernetes objects, the clock, PRNG state, pending events.
- **Behavior is code outside the world**, registered by plugins: event handlers, actors
  (controllers, kubelets, units), programs (`ls`, `kubectl`), checks, faults.
- **Time is virtual.** The kernel pops the earliest pending event, sets the clock to its time and
  dispatches it. Nothing in the engine reads a real clock or sets a real timer.
- **The only way in is an input**: terminal bytes, an editor result, a UI action, each stamped
  with the virtual time at which it is delivered. The same scenario, seed and input log produce
  the same world, the same output and the same trace.
- **Two kinds of running things.** *Actors* are long-lived simulated components; their whole state
  is world data and they advance by handling events, so they survive fork and snapshot. *Programs*
  are what a shell runs; each is a synchronous generator whose frame lives outside world state and
  which the kernel resumes at deterministic points.

Package boundaries (enforced by `simlab/package-boundaries`, table in `tools/eslint/boundaries.js`):

| Package | May import | Holds |
|---|---|---|
| `kernel` | nothing | world, clock, queue, PRNG, fork, hash, replay, trace, registry, extension contracts |
| `host` | `kernel` | machines, VFS, processes, streams, TTY, shell, coreutils, systemd, network endpoints |
| `k8s` (and later domains) | `kernel`, `host` | domain state slice, actors, programs, checks, faults, topologies |
| `learn` | `kernel` | content model, scenario runner, grader, skills, scheduler, progress log |
| `content` | `kernel`, `learn` | packs as data |
| apps, tools | any package | wiring, real I/O, time drivers |

`learn` never imports a domain. It reaches checks, faults, setup steps and topologies through the
kernel registry, whose contracts (§2.11) are defined in `kernel` for exactly that reason.

## 2. Kernel

### 2.1 World state

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface World {
  /** Layout version of the kernel part; slices carry their own. */
  schema: number;
  seed: number;
  clock: Clock;
  /** Binary min-heap ordered by (at, seq), stored as an array. Cancelling removes the entry. */
  queue: PendingEvent[];
  /** One state per named PRNG stream, created on first use and advanced in place. */
  prng: Record<string, PrngState>;
  /** Counters for deterministic ids (pids, inode numbers, input numbers, waiter ids). */
  counters: Record<string, number>;
  /** Wake topics with their waiting subscribers (§2.4). A table: entries are frozen. */
  topics: Table<TopicState>;
  /** One slice per plugin, keyed by plugin name: `host`, `k8s`, … */
  slices: Record<string, unknown>;
}
```

Phase 01 implemented this in `packages/kernel/src/world.ts`. It dropped the planned `cancelled`
map: `cancel` finds the event in the heap and removes it (O(n) to find, O(log n) to fix), which
keeps the world free of tombstones.

Rules for everything reachable from `World` (CLAUDE.md hard rule 5):

- Only JSON types. No class instances, functions, `Map`, `Set`, `Date`, `undefined` values,
  `NaN`, typed arrays or cycles. References between things are ids (strings), never pointers.
- Every node is either a **container** or a **value**:
  - A *container* is mutable and belongs to exactly one world: the root, a slice, a table.
  - A *value* is deeply frozen and may be shared between worlds: a Kubernetes object, an inode, a
    process record, a pending event.
  - A **table** is a container `Record<string, V>` whose entries are values. Changing an entry
    means storing a new frozen value under the key; values are never edited in place.
- The frozen flag is the marker. `Object.isFrozen(node)` means value. The kernel's `put` helper
  deep-freezes what it stores. Editing a value in place throws a `TypeError` (modules are strict
  mode), so a violation is loud.

```ts
type Table<V> = Record<string, V>;

/** Deep-freezes `value` and stores it. The only way entries enter a table. */
function put<V>(table: Table<V>, key: string, value: V): V;
function remove<V>(table: Table<V>, key: string): void;
/** Keys in code-unit order. Iteration that affects behavior uses this, never `for…in`. */
function keys<V>(table: Table<V>): string[];
```

Iteration order: JavaScript iterates integer-like keys first and the rest in insertion order.
That order is deterministic but an accident of history, so code whose result depends on order
iterates `keys(table)` (sorted) or an explicit order field. This is the "defined order" of
CLAUDE.md hard rule 4.

A **slice** is declared by its plugin:

```ts
interface SliceSpec<S> {
  /** Plugin name; the key under `world.slices`. */
  name: string;
  /** Bumped when the slice layout changes. A snapshot with another version is refused. */
  version: number;
  init(seed: number): S;
  /** After deserialization: freeze the values so later forks share them (§2.7). */
  adopt(slice: S): void;
  /** When a kernel is created over a world (boot, fork, restore); phase 02 added it (§3.4). */
  attach?(ctx: Ctx): void;
}
```

### 2.2 Clock

```ts
/** Milliseconds, an integer. */
type Millis = number;

interface Clock {
  /** Virtual wall-clock time in ms since the Unix epoch. */
  now: Millis;
  /** Value of `now` when the world was created; `now - start` is the uptime. */
  start: Millis;
  /** Sequence number for the next scheduled event. */
  seq: number;
}
```

- `clock.start` comes from the session header (§2.8). An interactive session uses the real time at
  which it began, read once by the app and recorded; headless runs use the scenario's
  `world.startTime` or a fixed default. Either way the engine receives it as data.
- Dates are rendered by pure functions in the kernel (`formatRfc3339(ms)`, civil-date arithmetic).
  The `Date` object is banned in engine packages. Simulated machines run in UTC.

### 2.3 Events

```ts
interface PendingEvent {
  /** Unique within the world: the `seq` it was scheduled with, as a string. */
  id: string;
  at: Millis;
  seq: number;
  /** Dotted, prefixed by the plugin that handles it: `host.proc.run`, `k8s.controller.sync`. */
  type: string;
  payload: Json;
  /** Id of the event or input being handled when this one was scheduled (causal chain, §2.9). */
  cause?: string;
}

interface HandlerSpec {
  type: string;
  /** Periodic background work (heartbeats, resyncs). See `settle` in §2.5. */
  idle?: boolean;
  handle(ctx: Ctx, payload: Json): void;
}
```

- Order is `(at, seq)`. `seq` is assigned when the event is scheduled, so events for the same
  instant run in the order they were scheduled. There is no other tie-break.
- An event is data. It names its handler by `type`; a handler is found in the registry. A closure
  can never be scheduled.
- A handler runs to completion and synchronously. It may read and write the world, schedule and
  cancel events, draw from PRNG streams, publish to topics and emit trace records.
- An event whose type has no registered handler is an engine bug: the kernel throws.
- `at` is never in the past: `schedule(delay, …)` takes a delay of zero or more.

```ts
interface Ctx {
  readonly world: World;
  readonly registry: Registry;
  readonly now: Millis;
  /** What is being handled: an event id (`<seq>`), an input id (`in<n>`) or an action label. */
  readonly during: string;
  schedule(delay: Millis, type: string, payload: Json): string;
  /** False if the event was not pending. */
  cancel(eventId: string): boolean;
  random(stream: string): Random;
  /** Next value of a world counter, starting at 1. */
  nextId(counter: string): number;
  /** Adds a waiter to `topic` (§2.4); returns its id. */
  subscribe(topic: string, type: string, payload: Json): string;
  unsubscribe(topic: string, waiterId: string): void;
  /** Wake everything waiting on `topic` (§2.4). */
  publish(topic: string): void;
  /** Returns the record's id, for `causes` of later records. */
  trace(record: TraceInput): number;
  gap(record: GapInput): void;
  /** Typed access to a plugin's slice. */
  slice<S>(name: string): S;
}
```

Modeled latency lives in the delay passed to `schedule`. Each delay that a learner can observe
(image pull time, controller reaction, probe period, backoff) is a named constant with its upstream
source, or a parameter of a behavior model.

### 2.4 Topics: waiting for a state change

Programs and actors often wait for "something changed": bytes arrived on a pipe, an object was
written, a child exited. Polling would cost events and add latency, so the kernel has topics.

```ts
interface TopicState {
  /** Subscribers in subscription order. */
  waiters: Waiter[];
}
/** Schedule this event at `now` when the topic is published. */
interface Waiter { id: string; type: string; payload: Json }
```

A process waiting on a topic is a waiter whose event is `host.proc.run` with its pid (§3.4), so
the kernel needs no notion of processes. Phase 01 merged the two planned waiter kinds into this
one for that reason.

`ctx.publish(topic)` schedules one event at the current time for each waiter, in subscription
order, and clears the list. Waiters are world data. A topic name is a string such as
`host.stream:<id>`, `host.proc.exit:<pid>`, `k8s.watch:<subscription>`.

### 2.5 The kernel loop and time drivers

```ts
interface Kernel {
  readonly world: World;
  readonly registry: Registry;
  readonly now: Millis;
  /** Deliver one input at the current time (§2.8), after running events already due. */
  input(input: Input): void;
  /** Run every event with `at <= t`, then set the clock to `t`. */
  runUntil(t: Millis): void;
  /** `runUntil(now + d)`. */
  advance(d: Millis): void;
  /**
   * Run until only idle events are pending, or `until(world)` holds, or `timeout` has passed.
   * Returns which of the three ended it.
   */
  settle(opts: { timeout: Millis; until?: (w: World) => boolean }): 'quiet' | 'until' | 'timeout';
  /** Time of the next pending non-idle event, if any ("skip to next event"). */
  nextEventTime(): Millis | undefined;
  /** Runs code with a `Ctx` outside any event: topology build, setup and solution steps, faults, tests. */
  act<T>(label: string, fn: (ctx: Ctx) => T): T;
  fork(options?: { ports?: Ports }): Kernel;
  hash(): string;
  traceRecords(): TraceRecord[];
}
```

`settle` tests `until` before each virtual instant it runs, and returns `'quiet'` without moving
the clock. Inputs reach plugins through input handlers that a plugin registers by input kind
(`Plugin.inputs`, §2.11); the kernel registers `learn.action` itself as a no-op.

A **time driver** decides when to call these. It lives in an app, not in the engine, because it
is the one component allowed to look at a real clock.

| Driver | Where | Behavior |
|---|---|---|
| Interactive | `apps/web` (worker), `apps/cli` player | On each tick: `target = now + realElapsed × speed`; `runUntil(target)`. Before delivering an input: `runUntil(target)`, then `input(...)`. "Skip to next event" sets `target = nextEventTime()`. Pausing stops ticking. |
| Headless | scenario runner, tests, `npm run sim` | Time moves only through `advance`, `settle` and the steps of a scenario. A command runs with the clock advancing only as far as the command itself waits. |
| Replay | session resume, debrief, bug reports | For each logged input: `runUntil(input.t)`, `input(...)`. Then `runUntil(log.end)`. |

Why this is deterministic although real time is involved: the real clock only decides *which
virtual time an input is stamped with*. The stamp is recorded. The engine sees virtual times and
inputs, nothing else, and the replay driver feeds it the same ones.

Ordering rule at one instant: `runUntil(t)` runs all events with `at <= t` before an input stamped
`t` is delivered. `Kernel.input` enforces it: it first runs every event already due, including
events that an earlier input at the same instant scheduled with delay zero. Without that, a
recorded session and its replay would interleave those events differently (phase 01 found this
in a test).

**Work per instant is bounded.** A handler or program that loops without consuming virtual time
would freeze the driver. Two guards:

- A process may execute a fixed number of syscalls per run slice; then it is preempted and
  resumed 1 ms later (§3.4). `yes > /dev/null` therefore burns virtual time and can be interrupted.
- The kernel counts events dispatched without the clock advancing. Past a limit
  (`MAX_EVENTS_PER_INSTANT`, 100 000) it throws with the most frequent event types involved: that
  is an engine bug (two handlers scheduling each other at delay zero).

The interactive driver's logic is in the kernel (`createInteractiveDriver` in `driver.ts`) and is
tested headlessly: the app calls `tick(realElapsed)` and `deliver(input, realElapsed)`, and the
driver carries fractions of a virtual millisecond between ticks. Only reading the wall clock is
left to the app.

### 2.6 PRNG streams

```ts
/** Four unsigned 32-bit integers: xoshiro128** state. */
type PrngState = [number, number, number, number];

interface Random {
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform float in [0, 1). */
  float(): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** `length` characters drawn from `alphabet`. */
  chars(length: number, alphabet: string): string;
}
```

- The generator is xoshiro128** (Blackman and Vigna). A stream's initial state is SplitMix32
  output seeded from the hash (§2.7) of the world seed and the stream name. `int(n)` uses
  rejection sampling, so it has no modulo bias. A test pins the generator to the reference
  algorithm's output.
- A stream is identified by a name: `k8s.names`, `k8s.scheduler.filter-order`, `host.pids`.
- A stream's initial state is a pure function of `(world.seed, name)`. It does not depend on the
  order in which streams are first used, so adding a draw in one subsystem never changes what
  another subsystem draws.
- The state lives in `world.prng[name]` and advances with each draw. Fork copies it, so a fork
  draws the same sequence the original would have.
- Scenario parameters are resolved from the seed before the world exists (stream `params`,
  `docs/SCENARIO_FORMAT.md` §4), so the world seed and the parameter choice are independent.

### 2.7 Snapshot, fork, hash

**Fork** copies the world so that the copy can diverge: checks run on a fork, the debrief replays
on one, tests compare branches.

```ts
/** Copies containers, shares values. */
function forkWorld(world: World): World;
```

The algorithm is one recursive function: a frozen node is returned as is; an unfrozen object or
array is shallow-copied and its children are visited. Because tables hold frozen values, the walk
stops one level below each table. The cost is proportional to the number of table entries
(thousands), not to the size of the data (megabytes): a fork copies pointers, never file contents
or object bodies.

Why this design and not the alternatives:

| Alternative | Why not |
|---|---|
| Deep copy (`structuredClone`, JSON round trip) | Cost grows with every file and object; too slow to run on each check press and in content tests that fork per check and per seed. |
| A fully immutable world with path-copying updates | Fork is free, but every write becomes a path update; verbose in exactly the code that should stay readable (VFS, controllers). |
| A proxy-based draft library | Hides cost in reads, adds a dependency to the innermost loop, and a draft that leaks is a silent bug. |
| Undo journal | Makes fork a rewind, so two live branches cannot coexist. |

The chosen scheme fails safe. A value that someone forgot to freeze is a container, so it is
copied: slower, still correct. A container that someone froze by mistake throws on the next write.
Neither can make two worlds share mutable state.

A fork drops running programs (§3.4): the copy contains their process records but not their
coroutine frames, so the fork procedure terminates them in the copy. Actors are unaffected.

**Snapshot** is serialization: `JSON.stringify` of the world plus a header with the kernel schema,
each slice's version and the engine version. **Restore** parses it, refuses a version mismatch and
calls each slice's `adopt` to freeze values again. Snapshots are for scenario baselines (the world
after setup, so that reset is instant) and checkpoints. A snapshot is taken only when every
program is quiescent (§3.4); the runner guarantees this for baselines because no terminal session
exists yet.

**Hash** identifies a world state for determinism tests and replay verification.

- It is a Merkle hash. A node's canonical form lists its keys in code-unit order, each with its
  child: primitives in JSON form, objects and arrays by their own hash. The result depends only
  on the data, never on which nodes are frozen, so a world hashes the same before a snapshot and
  after a restore.
- Hashes of frozen nodes are cached by object identity in a `WeakMap` outside the world. After a
  small change, only the containers on the path to it and the new values are hashed again.
- The function is the cyrb53 core (bryc, public domain) with both 32-bit lanes printed: 64 bits as
  16 hex digits. It is non-cryptographic and needs no platform crypto. Tests check it against
  cyrb53's published values and pin two outputs.

**Measured** (phase 01, `npm run bench:fork`, Node 26.13.1 on the workstation in
`docs/FIDELITY.md` §2.1). The world had three Ubuntu base machines plus 3 000 extra files each:
9 708 inodes and 95 MB of file content, 1–20 kB per file.

| Operation | Median | p90 |
|---|---|---|
| fork | 1.2 ms | 2.2 ms |
| hash, warm (nothing changed) | 9 ms | 10 ms |
| fork, write one file, hash | 11 ms | 13 ms |
| hash, cold (just restored, no cache) | 1.34 s | 1.37 s |
| snapshot (95.5 MB of JSON) | 451 ms | 472 ms |
| restore | 344 ms | 350 ms |

Fork is well under the 10 ms target, so the representation stays. A cold hash is linear in the
bytes of content; it happens once after a restore. The warm hash is dominated by walking the
inode tables.

Tests that must hold from phase 01: same seed and input log give the same hash; fork then run
equals run; snapshot, restore and continue equals continue; a fork that is mutated leaves the
original's hash unchanged.

### 2.8 Input log and replay

```ts
interface SessionLog {
  v: 1;
  header: {
    item?: string;            // content item id, absent for free play
    topology: string;
    seed: number;
    params?: Record<string, Json>;   // resolved parameters, for readability; recomputed on replay
    startTime: Millis;        // becomes clock.start
    engine: string;           // engine version
    versions?: Record<string, string>;   // domain pins, e.g. { kubernetes: 'v1.37.2' }
    contentHash?: string;     // hash of the item source
  };
  inputs: LoggedInput[];
  /** Virtual time the session reached; replay runs to here after the last input. */
  end: Millis;
  /** Occasional world hashes, to detect a replay that diverges. */
  checkpoints: { t: Millis; inputs: number; hash: string }[];
}

type LoggedInput = { t: Millis } & Input;

type Input =
  | { kind: 'tty.open'; tty: string; machine: string; user: string; cols: number; rows: number }
  | { kind: 'tty.bytes'; tty: string; data: string }
  | { kind: 'tty.resize'; tty: string; cols: number; rows: number }
  | { kind: 'tty.close'; tty: string }
  | { kind: 'editor.save'; session: string; content: string }
  | { kind: 'editor.close'; session: string }
  | { kind: 'learn.action'; action: string; data?: Json };   // hint shown, check pressed, …
```

- The header names domain pins generically (`versions`), so the kernel names no domain. A
  checkpoint records how many inputs had been delivered, because several inputs can share a
  time stamp. Taking a checkpoint first runs the events already due, as `input` does.
- `createRecorder(kernel, header)` delivers and logs inputs and takes checkpoints;
  `replay(log, boot)` rebuilds the world and reports the first checkpoint that does not match.
- Only inputs change the world from outside. `learn.action` inputs do not change it at all; they
  are logged so that the debrief can place them on the timeline.
- Speed changes, pauses and skips are not inputs. Their whole effect is in the stamps.
- The log is appended to as the session runs and stored through the server under `data/`.
- **Resume** replays the log on a fresh world. **Reset** starts a new log from the baseline.
- A replay is valid for the engine version that recorded it. After an engine change a replay can
  diverge; the checkpoints detect that. On divergence the app says so and offers to start the item
  again; it never continues on a world it cannot vouch for.

### 2.9 Trace

```ts
interface TraceRecord {
  /** Monotonic within a run. */
  id: number;
  t: Millis;
  /** Emitting component: `k8s.scheduler`, `k8s.kubelet/node01`, `host.systemd/controlplane`. */
  source: string;
  /** What happened, dotted: `pod.unschedulable`, `unit.failed`, `request.denied`. */
  kind: string;
  /** What it is about, as a reference the UI can link: `pod/shop/web-5d7…`. */
  subject?: string;
  /** Human-readable cause, in the component's own terms. */
  message: string;
  data?: Json;
  /** The event or input being handled when the record was emitted. */
  during: string;
  /** Records this one follows from. */
  causes?: number[];
}
```

- The trace answers "why": why the Pod is Pending, which controller created what. The X-ray view,
  the debrief and simulation tests read it.
- The trace is **not world state**. It is written to a bounded buffer in the kernel runtime and
  handed to a sink. Engine logic never reads it; a check never asserts on it.
- It is deterministic all the same, because it is emitted by deterministic code. A resumed
  session gets its trace back by replay.
- `during` plus each event's `cause` field give the causal chain from an input to its
  consequences without any component having to thread ids by hand.
- Trace messages are simulator vocabulary, not real tool output. They are not subject to the
  grounding rule, and they must never be shown where the learner could take them for real output.

### 2.10 Ports

The engine does no I/O. Three write-only ports carry what must leave it; the app connects sinks.

| Port | Carries | Typical sink |
|---|---|---|
| `trace` | `TraceRecord` | ring buffer for X-ray and debrief; assertions in tests |
| `output` | terminal bytes per TTY; editor requests (§3.8) | xterm.js; the CLI's stdout; a transcript buffer in tests |
| `gap` | `GapRecord` without wall time (`docs/FIDELITY.md` §4.4) | `data/gaps.jsonl` through the server; failure in content tests |

Write-only is what allows these to live outside world state: nothing the engine does can depend
on them. Phase 02 added `output` to `Ports` and `Ctx.output(record)`; phase 03 made
`OutputRecord` a union: `{ kind: 'tty', tty, data }` (newlines already turned into CR LF by the
terminal's `onlcr`, or written as CR LF by the line editor), `{ kind: 'editor.open', session,
tty?, request }` and `{ kind: 'editor.status', session, ok, message? }` (§3.8).

### 2.11 Plugin registry and extension contracts

```ts
interface Plugin {
  name: string;
  /** Plugins this one builds on; registration order follows it. */
  requires?: string[];
  slice?: SliceSpec<unknown>;
  handlers?: HandlerSpec[];
  /** Handlers for inputs (§2.8), by input kind: `tty.bytes`, `editor.save`. */
  inputs?: InputHandlerSpec[];
  /** Contributions for other layers, each keyed by a registry kind. */
  contributions?: { [kind: string]: Contribution[] };
}

interface Contribution {
  /** Unique within its kind: `k8s.podsReady`, `kubeadm-1cp-2w`, `apply`. */
  name: string;
  [field: string]: unknown;
}

interface Registry {
  readonly plugins: readonly Plugin[];       // in registration order
  readonly slices: readonly SliceSpec<unknown>[];
  handler(type: string): HandlerSpec;
  input(kind: string): InputHandlerSpec;
  get<T extends Contribution>(kind: string, name: string): T | undefined;
  list<T extends Contribution>(kind: string): T[];   // sorted by name
}
```

The registry is built once at start-up from a fixed list of plugins (`createRegistry(plugins)`)
and is immutable afterwards. It orders plugins by `requires` and refuses a missing requirement,
a cycle, or a duplicate plugin, handler, input kind or contribution name.
It is code and static data, so it lives outside world state; two worlds on one engine share it.

Registry kinds. The kernel defines the contracts that `learn` consumes; the host defines the
ones that concern machines.

| Kind | Contract defined in | Registered by | Consumed by |
|---|---|---|---|
| `check` | kernel | host, domains | `learn` grader |
| `fault` | kernel | host, domains | `learn` runner |
| `step` | kernel | host, domains | `learn` runner (setup and solution steps) |
| `topology` | kernel | domains | `learn` runner, CLI |
| `visualizer` | kernel | domains | web X-ray |
| `program` | host | host, domains | shell, systemd |
| `completion` | host | host, domains | TTY line editor |
| `fileProvider` | host | host, domains | VFS generated files |
| `behaviorModel` | host | host, domains | processes behind units and containers |
| `provenance` | kernel | everyone | `fidelity:report` |

```ts
/** A JSON Schema object (draft 2020-12 subset) describing `args`. Plain data. */
type ArgsSchema = { [key: string]: Json };

interface CheckSpec extends Contribution {
  args: ArgsSchema;                       // schema of the check's `with` map
  /** Runs against a fork. May advance the fork's time. Must not depend on anything else. */
  run(ctx: CheckCtx, args: Json): CheckResult;
}
interface CheckCtx { kernel: Kernel; registry: Registry; session: StepSession; baseline: World; }
interface CheckResult {
  pass: boolean;
  /** What the check wants, from its arguments: "3 ready Pods matching app=web in shop". */
  expected: string;
  /** What was observed, for the debrief: "2 of 3 Pods ready". */
  observed: string;
  /** Set when the check could not be evaluated (a `[sim]` notice, a missing machine). */
  error?: string;
}

interface FaultSpec extends Contribution {
  args: ArgsSchema;
  /** Mutates the world into a state a real system could be in. */
  inject(ctx: Ctx, args: Json): void;
}

interface StepSpec extends Contribution {
  args: ArgsSchema;                       // schema of the whole step map, without `when`
  /** Executes one setup or solution step. Throws with a message on failure. */
  run(ctx: StepCtx, args: Json): void;
  /** How the step reads in a reference solution: `$ kubectl get pods`. */
  show?(args: Json): string;
}
interface StepCtx { kernel: Kernel; registry: Registry; session: StepSession; }

/** Per step list (or check), held by the runner outside the world (D-094). */
interface StepSession {
  readonly entry: { machine: string; user: string };
  local<T>(key: string, create: () => T): T;   // state of one step kind: open shells
  onEnd(fn: () => void): void;                 // log out when the list ends
  listen(ports: Ports): () => void;            // the runner's port hub
}

interface TopologySpec extends Contribution {
  params: ArgsSchema;
  /** Builds the machines and domain state into an empty world. */
  build(ctx: Ctx, params: Json): TopologyInfo;
}
interface TopologyInfo {
  /** Where a learner's terminal opens by default. */
  entry: { machine: string; user: string };
  machines: string[];
}
```

Argument schemas are data so that content can be validated at build time without running a check,
and so that an editor can offer completion for item files (`docs/decisions.md` D-009).

### 2.12 What may live outside world state

| Outside the world | Why it is allowed |
|---|---|
| Registry: handlers, programs, checks, schemas, the image catalog, processed OpenAPI | Code and static data, identical for every world on this engine build |
| Derived caches: hash cache, indexes over tables, parsed forms of files | Rebuilt from the world on demand; keyed by frozen-value identity or invalidated on write; never the only copy of anything |
| Program coroutine frames | Not serializable. Recreated by replay; quiescent programs are recreated from their world record (§3.4) |
| Trace buffer, terminal output, gap records | Write-only for the engine (§2.10) |
| Input log, time driver state, speed, pause | They are the *cause* of the world, held by the app |

Anything else is world state. The test for a new piece of state: if forking the world and running
both copies could give different results because of it, it belongs in the world.

## 3. Host substrate

The host slice is `world.slices.host`. Kubernetes nodes, the student workstation and containers
are all machines.

### 3.1 Machine

```ts
interface HostSlice {
  machines: Record<string, Machine>;      // by machine id
  streams: Table<Stream>;                 // pipes and other byte channels
  ttys: Record<string, Tty>;
  net: HostNet;                           // addresses, routes between machines, listeners index
}

interface Machine {
  id: string;
  /** The kernel hostname (`uname -n`); /etc/hostname is a separate file, read at boot. */
  hostname: string;
  kind: 'node' | 'workstation' | 'container';
  /** For a container: the machine and runtime container it belongs to. */
  parent?: { machine: string; container: string };
  vfs: Vfs;
  procs: Table<Proc>;
  /** Mutable per-process state that changes often: fd tables, shell session state. */
  procState: Record<string, ProcState>;
  units: Table<Unit>;
  journal: JournalState;
  packages: Table<Package>;
  sysctl: Table<string>;
  kernelModules: Table<true>;
  interfaces: Table<NetInterface>;
  /** Listening sockets: `proto:addr:port` → owner. */
  listeners: Table<Listener>;
  boot: { bootedAt: Millis; state: 'running' | 'off' };
}
```

Phase 01 built `id`, `hostname`, `kind`, `vfs` and `boot`; phase 02 added `procs` and `files` (open
file descriptions, §3.3) and the slice's `streams` and `ttys`; each later field arrives with the
phase that models it. `procState` does not exist: phase 02 merged it into `Proc` (§3.3). Users, groups and the system-wide environment are **not** fields. As on Linux
with NSS `files`, they are the contents of `/etc/passwd`, `/etc/group` and `/etc/environment`,
parsed on demand with a cache keyed by inode identity (`users.ts`, `docs/decisions.md` D-019).
Editing the file is how a user is added, and nothing else can disagree with it.

`buildUbuntuBase(ctx, machine, { user })` lays down what an Ubuntu 24.04.5 LTS server's
essential packages create: directories with base-files' modes, the usrmerge links, identity
files, `/etc/profile` and the skeleton dotfiles, base-passwd's accounts plus one login user, and
`/dev/null` (D-020).

### 3.2 VFS

```ts
interface Vfs {
  root: string;                    // inode id of `/`
  inodes: Table<Inode>;
  mounts: Table<Mount>;            // by mount point (phases 16a, 17, 25a)
}

type Inode =
  | (InodeMeta & { type: 'dir'; entries: Record<string, string>; parent: string })  // name → inode id; `..`
  | (InodeMeta & { type: 'file'; data: string })                        // UTF-8 text
  | (InodeMeta & { type: 'symlink'; target: string })
  | (InodeMeta & { type: 'program'; program: string; size: number })    // an executable
  | (InodeMeta & { type: 'generated'; provider: string; args: Json;     // content computed on read;
                   device?: { major: number; minor: number } })         // with `device`, a char device
  | (InodeMeta & { type: 'opaque'; what: string; ref: Json; size: number }); // binary stand-in (phase 28)

interface InodeMeta {
  id: string;
  mode: number;          // permission bits, as chmod sees them
  uid: number;
  gid: number;
  mtime: Millis;
  ctime: Millis;
  nlink: number;
}

interface Mount {
  at: string;
  source:
    | { kind: 'bind'; machine: string; path: string; readOnly: boolean }   // hostPath, volumes
    | { kind: 'provider'; provider: string; args: Json; readOnly: boolean }; // ConfigMap, Secret, proc
}
```

- **Executables are files.** `/usr/bin/kubectl` is an inode of type `program` naming a registered
  program. `PATH` lookup, `which`, permission bits, a missing binary and a wrong `ExecStart` all
  follow from ordinary file semantics. Reading such a file as text prints a `[sim]` notice.
- **Generated files** (`/proc/…`, `/etc/hostname` derived from state) call a `fileProvider` on
  read and, where the real file is writable, on write. The provider is a pure function of the world.
- **Opaque files** stand for binary content that has structure in the simulation: an etcd
  snapshot, a container image tarball. `ref` points at the structured data.
- **Certificates and keys** are text files in PEM shape whose body encodes a structured stand-in
  (`PLAN.md` §4.3). The format is fixed in phase 25b.
- Inodes are values. Appending to a log file stores a new inode; the old content string is shared
  with any fork that still holds the old inode.
- Path resolution, permission checks and error numbers follow Linux; error *messages* come from
  the program that reports them (`ls: cannot access …`), grounded per program.
- Change notification: a write under a directory publishes the topic
  `host.vfs:<machine>:<directory inode>`. The kubelet watches its manifest directory this way.

Phase 01 built the VFS in `packages/host/src/vfs/` without `mounts` and `opaque` inodes; the
phases that need them add them. Inode ids are decimal numbers from a per-machine counter, and the
root is 2 as on ext4. A directory records its parent, so `..` is physical: `/bin/..` is `/usr`
when `/bin` links to `usr/bin`. The calls are made through `createFs(ctx, machine, { cred, cwd,
umask })`: `stat`, `lstat`, `readFile`, `writeFile` (open with `O_CREAT` plus truncate, append or
`O_EXCL`), `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `symlink`, `readlink`, `readdir`, `chmod`,
`chown`, `utimes`, `access`, `realpath`, `checkExec`, `installProgram` and `createGenerated`.

- Failures throw `FsError` with the errno name and number, the syscall and the path.
  `strerror` gives glibc's message. Something the simulator cannot do (the bytes of an executable
  stub, writing a generated file whose provider has no `write`) throws `UnsupportedError`, which
  callers turn into a `[sim]` notice and a gap record. It is never shown as a real error.
- The order of checks follows the kernel, so when two errors apply, the one Linux reports wins.
  `fixtures/reference/linux/vfs-syscalls.txt` records 90 cases captured on the workstation, and
  a test replays every one of them against the simulator.
- Ubuntu's link protections are on (`fs.protected_hardlinks = 1`, `protected_symlinks = 1`,
  `protected_regular = 2`). They are constants until the sysctl table exists (phase 25b).
- A file is deleted when its last link goes. Deferring that while a descriptor is open comes with
  descriptors (phase 02).

### 3.3 Processes

```ts
interface Proc {
  pid: string;
  ppid: string;
  pgid: string;
  sid: string;
  uid: number;
  gid: number;
  argv: string[];
  /** What runs: a program coroutine or a behavior model. */
  kind: 'program' | 'model';
  /** Registry name of the program or behavior model. */
  image: string;
  cwd: string;
  env: Record<string, string>;
  tty?: string;
  unit?: string;                         // systemd unit that owns it
  startedAt: Millis;
  state: 'running' | 'stopped' | 'zombie';
  exit?: { code: number } | { signal: number };
}

interface ProcState {
  /** File descriptor → open file description. */
  fds: Record<string, Fd>;
  /** What the process is blocked on, if anything (§3.4). */
  wait?: WaitState;
  /** For programs that declare themselves restartable: their data (§3.4). */
  resume?: Json;
}

type Fd =
  | { kind: 'stream'; stream: string; end: 'read' | 'write' }
  | { kind: 'tty'; tty: string }
  | { kind: 'file'; inode: string; offset: number; flags: number }
  | { kind: 'null' };
```

Phase 02 built program processes (`packages/host/src/proc/`) with these refinements
(`docs/decisions.md` D-023): `ProcState` is merged into `Proc`, which also holds `traps` (signal
dispositions: ignored, or turned into an `Interrupted` error at the blocked syscall), `signal` (a
signal not yet acted on), `groups`, `umask` and `spawnData` (what a parent hands its child, such as
a subshell's command). A descriptor of kind `file` names an open file description in
`Machine.files` (`{ inode, offset, read, write, append, refs }`), shared by `dup` and inheritance as
on Linux, so `> f 2>&1` writes both streams at one offset. A file unlinked while open keeps
`nlink` 0 until its last description closes. The first pid on a machine is 1000. Processes are
iterated in numeric pid order.

Two kinds of process share the table, `ps` and signals:

- A **program** process runs a coroutine (§3.4). Everything a shell starts is one.
- A **model** process is an actor: a behavior model instance (`PLAN.md` §6.3) such as the kubelet,
  containerd, etcd, nginx, or the main process of a container. Its state is world data and it
  advances by events. systemd units and container runtimes create model processes.

### 3.4 The program interface: blocking and interruption

A program is a synchronous generator. It performs effects by yielding **syscalls**; the kernel
executes each and resumes the generator with the result. A syscall that cannot complete now
leaves the process blocked, recorded as data in `ProcState.wait`.

```ts
interface ProgramSpec extends Contribution {
  /** Runs the program. Returns the exit status. */
  main(p: ProcApi): Generator<Syscall, number, unknown>;
  /** Tab completion for this program's arguments. */
  complete?(c: CompletionCtx): Completion[];
  /** Set when the program can be recreated from `ProcState.resume` at its restart point. */
  restart?(p: ProcApi, resume: Json): Generator<Syscall, number, unknown>;
}

interface ProcApi {
  readonly pid: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly machine: MachineApi;          // VFS, users, units of this machine, with permission checks
  readonly now: Millis;
  random(stream: string): Random;
  trace(record: TraceInput): void;

  // Each returns a generator to be used with `yield*`.
  read(fd: number, opts?: { max?: number; line?: boolean }): Op<string | null>;  // null = end of file
  write(fd: number, data: string): Op<void>;
  sleep(d: Millis): Op<void>;
  /** Blocks until `topic` is published or the timeout passes. */
  wait(topic: string, timeout?: Millis): Op<'published' | 'timeout'>;
  spawn(req: SpawnRequest): Op<string>;                // returns the child pid
  waitpid(pid: string): Op<ExitStatus>;
  openEditor(req: EditorRequest): Op<EditorResult>;    // §3.8
  /** Prints the `[sim]` notice, records the gap, and ends the program with status 250. */
  unsupported(gap: GapInput): Op<never>;
}

type Op<T> = Generator<Syscall, T, unknown>;
```

A program reads naturally:

```ts
function* main(p: ProcApi) {
  for (;;) {
    const line = yield* p.read(0, { line: true });
    if (line === null) return 0;
    if (line.includes(p.argv[1] ?? '')) yield* p.write(1, line);
  }
}
```

**How this stays deterministic.**

- Generators are synchronous. There are no promises, no microtasks and no `await`; `async`
  functions are not used in engine packages. A coroutine runs only when the kernel calls
  `next()`, and stops at its next `yield`.
- The kernel resumes a process only while handling a `host.proc.run` event for it. Such an event
  is scheduled when the process is spawned, when what it waits for happens (a topic it waits on is
  published, its sleep expires), or when it was preempted. Those events sit in the one queue,
  ordered by `(at, seq)` like everything else. The interleaving of processes is therefore a pure
  function of the world.
- A run slice executes syscalls until one blocks, the program returns, or the slice budget is
  used up. The budget is a fixed number of syscalls; a process that exhausts it is rescheduled
  1 ms later. That bounds work per instant and gives busy loops a duration.
- What a process waits on is data: `WaitState` is `{ topic, deadlineEvent? }` plus the syscall
  that will be retried. Blocked processes cost nothing until woken.

**Interruption.** A signal is delivered by the kernel between syscalls.

| Signal | Default effect on a program process |
|---|---|
| `SIGINT` (Ctrl-C), `SIGTERM`, `SIGHUP`, `SIGPIPE` | The kernel calls the generator's `return()`, so `finally` blocks run and release what the program holds (watch subscriptions, temp files). The process exits with the signal recorded; the shell reports status 128 + signal number. |
| `SIGKILL` | The frame is dropped without running `finally`. The kernel releases the process's descriptors and subscriptions itself. |
| `SIGTSTP` (Ctrl-Z), `SIGCONT` | Stop and continue: the process keeps its frame and is not scheduled while stopped. |

A program may register a handler for a catchable signal; then the blocked syscall returns an
`interrupted` result instead (the shell uses this for `trap` and to survive Ctrl-C at the prompt).
Model processes receive signals as events and react according to their behavior model.

**Frames, fork and snapshot.** A coroutine frame is not data, so it is not in the world.

- A process is **quiescent** when it is blocked at a restart point: a point where everything it
  needs to continue is in `ProcState.resume`. The interactive shell waiting for a command line is
  quiescent; its variables, aliases, functions (as source), options, history, jobs and last status
  are data. `kubectl get -w` in the middle of a watch is not.
- `fork()` and `restore()` produce a world without frames. In that world every program process
  that is quiescent is recreated lazily through `restart`; every other program process is
  terminated as if by `SIGKILL`, and its descriptors are closed. The result is the world as it
  would be had the learner's running commands been killed at that instant. For grading this is
  what is wanted: checks assert on state, and open their own shells in the fork.
- A snapshot used as a baseline or checkpoint is taken only when all program processes are
  quiescent (`PLAN.md` §6.1), so restoring it loses nothing.
- A session is resumed by replay, which rebuilds every frame exactly.

A program that throws is a simulator bug. The kernel turns the exception into a `[sim]` notice of
kind `internal`, a gap record and exit status 250.

**As built in phase 02** (`proc/runtime.ts`, `proc/api.ts`, `proc/program.ts`):

- The slice budget is 1000 syscalls (`SLICE_BUDGET`). The blocking operations are the syscalls
  `read`, `write`, `sleep`, `wait` and `waitpid`; everything that cannot block (file system calls,
  `open`, `close`, `dup2`, `pipe`, `spawn`, `kill`, `setCwd`, `setResume`, `trap`) is a plain method
  of `ProcApi` that acts on the world at once. A failed syscall is thrown into the generator
  (`FsError` with `EBADF` for a closed descriptor).
- `exit(code)` and `exec(...)` throw; the runtime catches them. `exec` replaces the program of the
  process in place (same pid, descriptors and process group; caught signals reset).
- `finally` blocks run on SIGINT, SIGTERM, SIGHUP and SIGPIPE and must not perform syscalls.
- Frames are kept per world object. The host slice's `attach` ends every running program without
  a frame, in machine and pid order, as if by SIGKILL, unless it is at a restart point; a program
  at a restart point is recreated through `restart` the next time it runs. The interactive shell
  stores its whole state at each prompt with `setResume` and clears it when a line arrives.
- An `UnsupportedError` that escapes a program becomes a `[sim]` notice of kind `behavior`.

### 3.5 Streams and pipelines

Phase 02 stores the unread data as one string (`data`) and records the stream's `machine`.

```ts
interface Stream {
  id: string;
  /** Unread data, as chunks in write order. */
  chunks: string[];
  size: number;                 // total length of `chunks`
  capacity: number;             // a full pipe blocks its writer
  readers: number;              // open read ends
  writers: number;              // open write ends
}
```

- `a | b | c` is three processes and two streams. Each process is spawned with the stream ends as
  its descriptors, in one process group, the way a real shell does it.
- `read` on an empty stream with writers blocks on `host.stream:<id>`; with no writers it returns
  end of file. `write` on a full stream blocks; on a stream with no readers it raises `SIGPIPE`.
  A write publishes the topic, which schedules the reader. Order of execution follows from the
  queue: no process runs "inside" another.
- This is what makes streaming pipelines work and stay deterministic: `kubectl get pods -w | grep
  Running` prints each line when the watch event happens, `yes | head -1` ends because `head`
  exits and `yes` gets `SIGPIPE`, and `cat` with no input waits until Ctrl-D.
- Redirections open files as descriptors. Here-documents and command substitution are streams
  that the shell writes or reads.
- Stream contents are text. Programs that would emit binary data print a `[sim]` notice.
- The pipeline's exit status, `PIPESTATUS` and `pipefail` follow bash.

### 3.6 TTY

```ts
interface Tty {
  id: string;
  machine: string;
  cols: number;
  rows: number;
  session: string;              // session leader pid
  foreground: string;           // foreground process group
  mode: { canonical: boolean; echo: boolean; signals: boolean };
  /** Input waiting for a reader in raw mode, or completed lines in canonical mode. */
  input: string[];
  /** The line editor's state while a line is being read with editing. */
  editor?: LineEditorState;
  /** Open editor overlay, if any (§3.8). */
  overlay?: { session: string; pid: string };
}

interface LineEditorState {
  prompt: string;
  buffer: string;
  cursor: number;
  history: { index: number; saved: string };
  search?: { query: string; match: number };          // Ctrl-R
  completion?: { candidates: string[]; shown: boolean };
}
```

- Input bytes arrive as `tty.bytes` inputs. The TTY actor (an event handler, state in the world)
  applies the line discipline: with `signals` on, Ctrl-C, Ctrl-Z and Ctrl-\ become signals to the
  foreground process group; Ctrl-D on an empty line is end of file.
- **Line editing is part of the engine.** When a program reads a line with editing (the shell
  does, through `read` with an edit request), the TTY actor runs the line editor as a state
  machine over `LineEditorState`: cursor movement, kill and yank, history, Ctrl-R search, and tab
  completion through the registry's `completion` contributions. It writes the echo and redraw
  sequences to the output port. On Enter it hands the line to the reader. Because this is an
  event handler over world data, it is tested headlessly and a shell at its prompt is quiescent.
- Programs that need raw input (a pager, a container shell attached through `kubectl exec -it`)
  switch the mode and read bytes.
- Output written to a TTY descriptor goes to the `output` port tagged with the TTY id. The engine
  keeps no screen and no scrollback: the UI's terminal emulator does. Nothing in the engine reads
  terminal output back.
- The UI moves bytes and nothing else: keystrokes in, output bytes out, plus resize.

**As built in phase 03** (`packages/host/src/tty/`, `docs/decisions.md` D-027):

- `Tty` (`proc/types.ts`) holds `mode` (`icanon`, `echo`, `isig`; a new terminal is `stty sane`),
  `input` and `eof` (completed canonical input), `line` (the canonical line being typed),
  `typeahead` (bytes that arrived without echo after the editor finished its line), `editor`,
  and `readline` (kill ring and last search string, which outlive one line). Inputs `tty.open`,
  `tty.bytes`, `tty.resize` (redraws a line being edited) and `tty.close` (SIGHUP to the session,
  reads see end of file) drive it.
- `discipline.ts` is n_tty: ICRNL, echo with ECHOCTL (`^C`), ECHOE/ECHOKE erasure, VEOF, VERASE,
  VKILL, VWERASE, VREPRINT. Signal characters act when they arrive. Ctrl-C flushes input and sends
  SIGINT; Ctrl-\ and Ctrl-Z do nothing at the prompt (bash ignores SIGQUIT and SIGTSTP) and print
  a notice during a command (no core dumps or job control). What was typed while no editor read
  (echoed by the discipline) becomes the next editor's input, as with readline.
- A program reads a line with editing through `ProcApi.readLine(fd, { prompt, history,
  completer })`: a `read` syscall with an edit request. The prompt carries readline's \x01…\x02
  markers around non-printing text. `editor.ts` is the state machine (one key at a time, bindings
  from `bindings.ts`); `display.ts` lays out prompt and line with xterm's wrapping and writes the
  redraws; `keys.ts` splits input into key sequences. The read completes when the line is
  accepted (with its newline) or at Ctrl-D on an empty line (null).
- Completion: readline's half in `complete.ts` and the editor, the program's half through the
  `completion` contribution the request names (`shell/complete.ts` for bash) and
  `ProgramSpec.complete` for a program's arguments.
- The bash shell uses `readLine` when it is interactive, its input is a terminal and it was not
  started with `--noediting`; otherwise it writes the prompt to standard error and reads lines.
  PS1 and PS2 are decoded and expanded in `shell/prompt.ts`.
- `screen.ts` is a small terminal model (not part of engine behavior) that tests and script mode
  use to turn output bytes into what a screen shows.

### 3.7 Shell

The shell is a program (`bash`) with three parts, each testable alone: a lexer and parser
producing an AST for the supported grammar; an expander (parameters, command substitution,
globbing, quoting rules); an executor that spawns processes and wires descriptors. Syntax outside
the documented subset is detected by the parser and reported with a `[sim]` notice before anything
runs. The supported surface is documented in `docs/` by phases 02 and 22a.

Builtins run inside the shell process. External commands are resolved through `PATH` in the VFS.
The shell's session state lives in `ProcState.resume`, which is what makes it restartable.

Phase 02 built it in `packages/host/src/shell/`: `parse.ts` (lexer and parser, one command line at
a time, with alias substitution and here-documents), `expand.ts` and `glob.ts`, `shell.ts`
(executor), `state.ts` (session state as data), `builtins/` and `bash.ts` (invocation and the read
loop). The AST is plain JSON, so a subshell receives the node it runs as spawn data. Each stage of
a multi-stage pipeline is a subshell process that execs an external command; a single command
runs in the shell (builtin) or as one child (external). An interactive shell gives each foreground
job its own process group and makes it the terminal's foreground group. The supported grammar and
builtins are listed in `docs/COVERAGE.md`.

### 3.8 Editor protocol

`vim`, `vi`, `nano` and `kubectl edit` do not draw a terminal UI. They open an editor overlay.

```ts
interface EditorRequest {
  /** As the program was invoked: decides key bindings in the UI. */
  flavor: 'vim' | 'nano';
  path: string;
  content: string;
  readOnly: boolean;
  /** Language hint for highlighting, from the file name. */
  language?: string;
}
type EditorResult = { saved: boolean };
```

```mermaid
sequenceDiagram
  participant U as UI (CodeMirror)
  participant K as Kernel
  participant V as vim (program)
  participant F as VFS
  V->>K: openEditor(path, content)
  K-->>U: output port: editor.open(session, request)
  Note over V: blocked on host.editor:<session>
  U->>K: input editor.save(session, content)
  K->>F: write file (as the process's user)
  U->>K: input editor.close(session)
  K-->>V: resume with { saved: true }
  V->>K: exit 0
```

- `openEditor` records the overlay on the TTY and blocks the program. The request leaves through
  the output port.
- Each save in the UI (`:w`) is an `editor.save` input: the kernel writes the file with the
  process's permissions; a failure is reported back for the UI to show. Closing is `editor.close`.
  Both are in the input log with full content, so replay needs no UI.
- `kubectl edit` writes a temporary file, opens the editor on it, reads it back when the editor
  closes, and reopens it with the error in a comment header when the API server rejects the
  change, as the real command does.
- Headless runs answer the request without a UI: a scenario step supplies the new content or a
  list of replacements (`docs/SCENARIO_FORMAT.md` §6.3), and the runner turns it into the same two
  inputs.
- That the editor is an overlay and not a terminal vi is a divergence: `docs/FIDELITY.md`
  DIV-014.

**As built in phase 03** (`packages/host/src/proc/editor.ts`, `programs/editors/`, D-029): the
request also carries `name`, the file name as typed, which vim calls the buffer. Sessions are
world data (`HostSlice.editors`). `ProcApi.openEditor` returns `{ saved }` when the front end
closes the session; each `editor.save` writes in place with the program's credentials and answers
with `editor.status`. `vim` (also run as `vi`, `view`, `vim.basic`, `vim.tiny`) and `nano` (also
`rnano`) edit one named file; options, several files, no file, a directory, an unreadable file
and no terminal print notices. Headless sessions answer with `Session.onEditor`; script mode with
`@editor`; the terminal player with the user's editor.

### 3.9 Units, behavior models and the network

A systemd **unit** is a state machine in world data (`Unit`: load state, active state, sub state,
enablement, the parsed unit file, main pid, restart counters). `systemctl` requests transitions;
transitions are events; starting a unit resolves `ExecStart` through the VFS and creates a model
process, or fails the way systemd fails when the binary is missing or exits.

```ts
interface BehaviorModelSpec extends Contribution {
  /** Called when the process starts and when something it depends on changes. Pure. */
  evaluate(input: ModelInput): ModelOutcome;
}

interface ModelInput {
  argv: string[];
  env: Record<string, string>;
  /** Reads files as the process sees them (its machine, its mounts). */
  file(path: string): string | undefined;
  /** Client-visible result of connecting from this process (§4.5 for the Kubernetes network). */
  connect(host: string, port: number): ConnectResult;
  now: Millis;
  /** The model's own state from the previous evaluation. */
  state: Json;
}

interface ModelOutcome {
  /** Keeps running, or exits. */
  status: { running: true } | { exit: number; after: Millis };
  listen: { port: number; protocol: 'tcp' | 'http' | 'https'; ready: boolean }[];
  /** Log lines to append, with their delay from now. */
  logs: { after: Millis; line: string }[];
  /** Topics whose publication should trigger a new evaluation. */
  watch: string[];
  /** Re-evaluate at this time even if nothing changed. */
  recheckAfter?: Millis;
  state: Json;
  /** How it answers requests on its listeners, as data the network model interprets. */
  responses?: Json;
}
```

Most models are declarative data interpreted by one generic model (the form content can also
declare, `docs/SCENARIO_FORMAT.md` §5.4); components with real logic (kubelet, etcd, the API
server process) are coded models. Phase 06b fixed the details (D-060): the contract is
`packages/host/src/models/types.ts`, a pure step machine (`start`, `resume`, `signal` → output with
offsets, then a wake-up, a wait, an exit or an exec) contributed per program under
`host.behavior-model`; the sketch above is its first form. `docs/BEHAVIOR_MODELS.md` is the
reference.

The host network is a reachability model: machines have interfaces and addresses, model
processes own listeners, and `connect(source, host, port)` returns what a client would observe:
answered, refused, timed out, or could not resolve. Domains extend resolution and routing
(cluster DNS, Services, NetworkPolicy) by registering resolvers. There are no packets.

## 4. Kubernetes plugin

The slice is `world.slices.k8s`. Everything here follows `PLAN.md` §7; the exact strings and orders
are taken from upstream by the phase that implements each part.

```ts
interface K8sSlice {
  /** etcd data, per data directory: `<machine>:<path>` → the stored objects. */
  etcd: Record<string, EtcdData>;
  /** Watch subscriptions of every API server, with their undelivered events. */
  watches: Table<WatchSubscription>;
  /** Running controllers, `<instance>/<name>` → ControllerState (§4.3). */
  controllers: Table<ControllerState>;
  /** Event recorder (correlator) state per controller (§4.3). */
  recorders: Table<RecorderState>;
  /** events.k8s.io/v1 broadcaster state (isomorphic-event cache, series) per component (§4.3). */
  eventBroadcasters: Table<EventBroadcasterState>;
  /** Serving API servers by `<address>:<port>` (the topology records its own; phase 27 derives it). */
  apiServers: Table<ApiServerConfig>;
  /** Each node's container runtime: images, sandboxes, containers and their processes (§4.8). */
  runtimes: Table<NodeRuntime>;
  // The scheduler's and each kubelet's state are their ControllerStates (§4.3, §4.8). Added by
  // later phases: network (kube-proxy and CNI state per node).
}
```

Code: `packages/k8s/src/apiserver/store.ts` (store, watch), `pipeline.ts` (request handling),
`types.ts` (requests, responses, the strategy contract), `admission.ts`, `bootstrap.ts`;
`packages/k8s/src/registry/<group>/<resource>.ts` (strategies),
`packages/k8s/src/apis/<group>/` (defaulting and validation ported from `pkg/apis`),
`packages/k8s/src/apimachinery/` (Go JSON semantics, field errors, Status errors, selectors,
quantities, merge patch), `packages/k8s/src/client/client.ts`.

### 4.1 Store and watch

```ts
interface EtcdData {
  /** Global revision; each write increments it and becomes the object's resourceVersion. */
  revision: number;
  /** Storage resource (`pods`, `deployments.apps`; `events` for both Event APIs) → key → object. */
  resources: Record<string, Table<ApiObject>>;
  /** Keys that are not API objects: allocator ranges. A write takes a revision too. */
  ranges: Table<Json>;
  /** Recent changes, so that a watch can start from a past resourceVersion. */
  history: Table<HistoryEntry>;
}

interface WatchSubscription {
  id: string;
  etcd: string;            // the data directory the watched server reads
  storage: string;         // storage resource
  group: string; version: string; resource: string;   // the API it was opened on (events convert to it)
  namespace?: string;
  labelSelector?: string;  // selector strings; matching recompiles them
  fieldSelector?: string;
  owner: Json;             // for cleanup when the owner goes away
  pending: WatchEvent[];   // events not yet consumed, in order
}

interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  object: ApiObject;       // storage version
}
```

- Objects are stored in their storage version, fully defaulted, as frozen values. A write stores a
  new object with a new `resourceVersion`; `metadata.generation`, `uid`, `creationTimestamp` and
  `managedFields` follow the API server's rules.
- **The store is the content of an etcd data directory.** Which data an API server sees is
  decided by its `--etcd-servers` flag and by the `--data-dir` of the etcd process that answers
  there. Pointing etcd at another directory shows another cluster. `etcdutl snapshot restore`
  creates a new `EtcdData` under a new path; because objects are shared frozen values, a snapshot
  costs one table copy.
- **Watch.** After a write is persisted, the store appends a `WatchEvent` to every subscription
  it matches (resource, namespace, selectors, in subscription id order) and publishes
  `k8s.watch:<id>`. As the watch cache does, a watcher whose selector stops matching an object
  sees DELETED and one that starts matching sees ADDED. A watch opened without a resourceVersion
  (or with "0") starts with ADDED for every current object in key order; one opened at a past
  revision replays the changes after it from `history`, which keeps at least the last 100 events
  and every event younger than 75 s (upstream: `apiserver/pkg/storage/cacher`
  `watch_cache_history.go`, `DefaultEventFreshDuration`); older revisions are `Expired`
  (`too old resource version: N (M)`). A `kubectl get -w` process waits on that topic; a component's subscription
  feeds its work queue (§4.3). Subscriptions are world data; they are removed when their owner
  exits or the API server stops.
- A list returns objects in key order, as etcd does.
- Label and field selectors, `resourceVersion` semantics on update (conflict on mismatch) and
  finalizer-driven deletion are part of the store API.

### 4.2 Request pipeline

Every API access, from `kubectl`, from a controller, from a kubelet, is a request through the
same pipeline. Nothing writes to the store beside it, except etcd-level tools (`etcdctl`,
snapshot restore) and fault injectors that model etcd-level damage.

```ts
interface ApiRequest {
  verb: 'get' | 'list' | 'watch' | 'create' | 'update' | 'patch' | 'delete';
  /** Resolved from the URL path by discovery. */
  group: string;
  version: string;
  resource: string;
  subresource?: string;   // status, scale
  namespace?: string;
  name?: string;
  body?: Json;
  options?: {
    dryRun?: boolean;
    fieldManager?: string;
    fieldValidation?: string;          // Strict | Warn | Ignore; absent means Warn
    labelSelector?: string;
    fieldSelector?: string;
    resourceVersion?: string;          // where a watch starts
    propagationPolicy?: string;
    orphanDependents?: boolean;
    gracePeriodSeconds?: number;
    preconditions?: { uid?: string; resourceVersion?: string };
    patchType?: 'merge' | 'json' | 'strategic' | 'apply';   // only merge so far
  };
  /** Filled by authentication from the client's credentials (phase 20a). */
  user?: { username: string; groups: string[] };
}

type ApiResponse =
  | { ok: true; code: number; object: Json; warnings: string[] }
  | { ok: false; code: number; status: Status; warnings: string[] }      // metav1.Status, as the server returns it
  | { ok: false; code: 0; notSimulated: string; warnings: string[] };   // a gap: the client prints a [sim] notice

type ClientResult =                    // from the transport, added with kubeconfig handling (phase 07a)
  | { kind: 'response'; response: ApiResponse }
  | { kind: 'transport'; error: ConnectResult };   // refused, timeout, could not resolve, TLS failure
```

```mermaid
flowchart TB
  C[Client: kubectl, controller, kubelet] --> T{Transport<br/>connect to server URL}
  T -- refused, timeout,<br/>unresolved, bad TLS --> E1[transport error<br/>the client prints its own message]
  T -- listener owned by a running<br/>kube-apiserver process --> A[Authentication<br/>client cert or token against this server's CA and token store]
  A --> Z[Authorization<br/>modes from --authorization-mode: Node, RBAC]
  Z --> D[Decode, convert to the storage version, default]
  D --> M[Mutating admission<br/>plugins from --enable-admission-plugins]
  M --> V[Validation<br/>schema from OpenAPI, then semantic rules per kind]
  V --> VA[Validating admission<br/>quota, LimitRange, Pod Security, …]
  VA --> S{etcd reachable?}
  S -- no --> E2[server error as the real server returns it]
  S -- yes --> P[Persist: new revision]
  P --> W[Append watch events, publish topics]
  W --> R[Response]
  A -- rejected --> R401[401 Status]
  Z -- denied --> R403[403 Status]
  V -- invalid --> R422[422 Status with field causes]
```

- Each stage is a function `(ctx, request, state) → continue | Status`. The pipeline is the list
  of stages; the configuration of the API server process that received the request selects and
  parameterizes them. An API server started with other flags behaves differently because the
  pipeline reads those flags, not because a scenario said so.
- **Verified order** (phase 05a, `staging/src/k8s.io/apiserver/pkg/endpoints/handlers/create.go`,
  `registry/rest/create.go` `BeforeCreate`, `registry/generic/registry/store.go`). Defaulting
  happens while decoding, before admission, and authentication and authorization come first, as
  drawn. What the diagram compresses: on create, mutating admission is followed by the store's
  own steps, in order: `generateName` (up to 8 attempts while the name is taken), `uid` and
  `creationTimestamp`, the strategy's `PrepareForCreate`, `Validate` (and the generic ObjectMeta
  check only if that found nothing), warnings, `Canonicalize`; then validating admission; then
  storage allocation (Service IPs and ports); then the write, which is where `AlreadyExists` is
  decided. On update the order is namespace and name checks, mutating admission, existence and
  `resourceVersion` (Conflict, or unconditional where the strategy allows), `BeforeUpdate`
  (generation and system fields from the old object, `PrepareForUpdate`, ObjectMeta update
  checks, `ValidateUpdate`), validating admission, then either removal (the last finalizer of an
  object being deleted with no grace left) or the write; an update that changes nothing is not
  written. A patch decodes and defaults the merged object, then takes the update path. Deletion
  runs `BeforeDelete` (graceful deletion for Pods), then finalizers and propagation, then removal.
  `pipeline.ts` cites the functions step by step.
- Admission is an explicit chain (`admission.ts`). Only NamespaceLifecycle exists before phase
  20b (D-039).
- Errors are `metav1.Status` objects built by ported upstream functions, so that `kubectl` prints
  them through its own formatting as the real one does.
- The pipeline is synchronous: a request is handled within one event. Modeled latency belongs to
  the caller (a controller's reaction time), not to the request.
- Kinds the simulator has no strategy for answer with a gap (`notSimulated`), which a client
  turns into a `[sim]` notice; the registry still lists every resource the real server serves.
- A **client library** used by `kubectl`, controllers and kubelets wraps this: it reads a
  kubeconfig (or in-cluster credentials) from the VFS of the calling machine, connects through the
  network model, and returns a `ClientResult`. `kubectl` turning a transport error into its
  message is `kubectl` code, grounded in `kubectl` source.

### 4.3 Controller runtime

Code: `packages/k8s/src/controllers/` — `types.ts` (the contract), `runtime.ts` (queues, watches,
sync dispatch, retries, start and stop), `record.ts` (the core/v1 event recorder), `events.ts`
(the events.k8s.io/v1 event recorder), `manager.ts`
(kube-controller-manager's start order), `catalog.ts` (the controllers the plugin contributes
under the registry kind `k8s.controller`), one directory per controller.

```ts
interface ControllerSpec {
  name: string;                 // upstream name, as --controllers spells it: `deployment`
  component: 'kube-controller-manager';
  serviceAccount: string;       // identity of its requests: `deployment-controller`
  eventSource?: string;         // EventSource.Component: `deployment-controller`
  watches: { resource: string; keys(ev: ControllerEvent, read: Reader): string[] }[];
  sync(c: SyncCtx, key: string): SyncResult;
  latency: Millis;              // watch event → sync of the keys it produced
  backoff?: { baseMs: Millis; maxMs: Millis };  // when the queue's limiter is not the default
  maxRetries?: number;          // deployment, endpoints, endpointslice: 15
}

interface ControllerEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  object: ApiObject;
  old?: ApiObject;              // MODIFIED: the previous state
  initial?: true;               // part of the list at controller start
}

type SyncResult = { done: true } | { requeueAfter: Millis } | { error: string };

interface ControllerState {
  id: string;                   // `<instance>/<name>`
  name: string; instance: string; server: ApiServerConfig;
  watches: { index: number; subscription: string; waiter: string }[];
  queue: { key: string; at: Millis; cause: string }[];   // each key at most once
  failures: Record<string, number>;
  scheduled?: { event: string; at: Millis };            // the one pending sync event
  data: Record<string, Json>;   // controller bookkeeping that changes behavior (rare)
}
```

```mermaid
sequenceDiagram
  participant St as Store
  participant Q as Work queue (world data)
  participant K as Kernel queue
  participant C as Controller sync
  St->>K: publish k8s.watch:<id> → k8s.controller.watch event
  K->>Q: take events → keys(event) → enqueue at now + latency (deduplicated)
  Q->>K: one k8s.controller.sync pending, at the earliest due key
  K->>C: dispatch: sync one key
  C->>St: read the store (the informer cache)
  C->>St: write through the request pipeline (as the controller's service account)
  St->>K: resulting watch events, later in the same instant
  C->>K: next due key → schedule the next sync
```

- **One sync event processes one key.** Controllers interleave at key granularity, in the order
  the kernel queue gives, which is deterministic. Within a controller the earliest due key goes
  first; ties keep arrival order.
- **Queue semantics** follow client-go's workqueue: adding a queued key is a no-op, and a delayed
  add of a queued key keeps the earlier time. A sync result `{ error }` requeues the key with
  `DefaultTypedControllerRateLimiter`'s per-item backoff, 5 ms · 2^failures capped at 1000 s
  (`staging/src/k8s.io/client-go/util/workqueue/default_rate_limiters.go`); a controller with
  `maxRetries` drops the key after that many failures, as the deployment controller does after 15.
  The limiter's overall 10 qps/100 burst bucket is not modeled (it only matters above about a
  hundred failing keys at once).
- **Latency** is modeled, not measured: 5 ms from a watch event to the sync, standing for
  informer delivery and queue pickup, for every controller unless upstream adds an explicit
  delay for a path (named and cited in the controller). The oracle's timestamps have second
  precision and cannot measure it. Rollout pacing comes from the kubelet's timing (phase 06b),
  not from controller latency.
- **Reads come from the store.** What a real controller keeps in its informer cache is read from
  the store, which the cache mirrors with negligible lag in a healthy cluster. Bookkeeping that
  exists to hide informer lag (ReplicaSet expectations) is therefore not needed. A MODIFIED watch
  event carries the previous object (`old`), standing in for the informer's old copy that update
  handlers receive.
- **Writes go through the pipeline** with the controller's identity
  (`system:serviceaccount:kube-system:<serviceAccount>`, as kubeadm's
  `--use-service-account-credentials=true` sets up). A broken RBAC binding for a controller will
  break that controller once authorization exists (phase 20a).
- **Start and stop.** `startController` opens one watch per watched resource from "now", which
  begins with ADDED for every object, so a start lists everything, as an informer does. `stop`
  closes the watches and drops the queue, the pending sync and the failure counts: a stopped
  process forgets. `startControllerManager` starts the registered controllers in the registration
  order of upstream's `NewControllerDescriptors` (upstream then iterates a Go map; the fixed order
  is the simulator's choice). Phase 27 ties both to the controller-manager process.
- **Trace.** Every sync is a `controller.sync` record naming the key and the event that queued
  it (`queued by MODIFIED apps/v1/replicasets default/web-5d7`); every write is a
  `controller.write` (or `controller.write-failed`, with the status) record whose `causes` is the
  sync's record; retries, drops, start and stop have their own kinds. Trace ids are not stored in
  world state (trace buffers differ between forks), so the cause is carried as text.
- **Events** go through `record.ts`, a port of client-go's legacy recorder and EventCorrelator
  (`tools/record/event.go`, `events_cache.go`): de-duplication into `count` and `lastTimestamp`
  (patching the first event), aggregation of the tenth similar event within ten minutes into
  `(combined from similar events): …`, and the per-object spam filter (burst 25, one more every
  five minutes). Each controller has its own correlator state, as each has its own broadcaster
  upstream. Modeled: the LRU caches evict by a use counter, `PopAny` takes the oldest key, the
  asynchronous broadcaster writes within the sync, and event names use the virtual clock in
  nanoseconds made unique within a millisecond.
- **events.k8s.io events** (kube-scheduler's `Scheduled` and `FailedScheduling`) go through
  `events.ts`, a port of client-go's `tools/events` recorder and broadcaster. There is no
  correlator: an event with the same type, action, reason, reporting controller and instance,
  `regarding` and `related` as a cached one (the note does not count) is isomorphic. The second
  occurrence adds `series: {count: 2, lastObservedTime}` to the first Event with a patch (a
  create under the first name if the Event is gone); later occurrences only count in the cache.
  The broadcaster's periodic work, on a grid from its start, writes a series' final count at the
  first 6-minute tick more than 6 minutes after its last observation and forgets it, rewrites
  every series every 30 minutes, and forgets single events at the first tick more than 6 minutes
  after them. A kernel event is pending only while a series is cached (`k8s.events.tick`);
  singletons are forgotten lazily. Modeled choices: D-054.
- Controllers act as their own identity and go through authorization like any client.
- The **scheduler** (`packages/k8s/src/scheduler/`, D-056) uses the same runtime as the
  component `kube-scheduler` (identity `system:kube-scheduler`). `snapshot.ts` builds the NodeInfos
  from the store, `cycle.ts` runs one scheduling cycle (PreFilter, Filter with the first rejecting
  plugin per node, the FitError and preemption messages, Score, the score heap), `plugins/` holds
  the filter and score plugins, `hints.ts` the queueing hints, `scheduler.ts` the queue: a failed
  Pod is held as unschedulable with its rejecting plugins in the controller's data, the Pod and
  Node watch handlers requeue it when a hint says Queue (watch handlers receive the controller's
  data for this), and the leftover flush retries it after five minutes. It binds through
  `pods/binding` with the Pod's uid as precondition, writes PodScheduled=False when it changed,
  and records `Scheduled` and `FailedScheduling` through the events.k8s.io recorder. Trace kinds:
  `scheduler.filter` (one per node: the plugin, its reasons and status code), `scheduler.score`,
  `scheduler.bound`, `scheduler.unschedulable`, all caused by the `controller.sync` record.
  `startScheduler`/`stopScheduler` start and stop it with its events broadcaster; phase 27 ties
  them to the static Pod's process.
- Time-driven controllers (CronJob, node lifecycle, HPA, TTL, the Deployment progress deadline)
  schedule their own next wake with `requeueAfter` or `enqueueAfter`, computed from the object,
  so nothing polls.
- **Tests** run Pods with `packages/k8s/src/testing/kubelet.ts`, a stand-in for the scheduler and
  the kubelets (itself a controller on the runtime, never registered by the plugin): it binds
  Pods round robin, reports them Running and Ready, not ready, or failed after a delay, and
  finishes graceful deletions.

### 4.4 Components are processes on nodes

This coupling is what CKA troubleshooting is about, so it is structural.

```mermaid
flowchart TB
  subgraph node[Machine: controlplane]
    UF["kubelet unit file and drop-ins (VFS)"] --> KU[Unit kubelet.service]
    KU --> KP[Model process: kubelet<br/>flags and config file parsed]
    MF["Static Pod manifests in /etc/kubernetes/manifests (VFS)"] -- VFS topic --> KP
    KP --> RT[Runtime: sandboxes and containers]
    RT --> AP[Model process: kube-apiserver]
    RT --> EP[Model process: etcd]
    RT --> CP[Model process: kube-controller-manager]
    RT --> SP[Model process: kube-scheduler]
    EP -- data-dir --> ED[(EtcdData)]
    AP -- etcd-servers --> EP
    CP -- kubeconfig --> AP
    SP -- kubeconfig --> AP
    KP -- kubeconfig --> AP
  end
  CP --> CTRL[Controller syncs run]
  SP --> SCH[Scheduling runs]
  AP --> PIPE[Requests are served]
```

A component's work happens only while its process is healthy. Health is derived, not stored:

```ts
interface ComponentHealth {
  running: boolean;
  /** Why not, in trace vocabulary: the first failing link in the chain. */
  reason?: string;
}

/** Pure function of the world. */
function componentHealth(world: World, component: string): ComponentHealth;
```

The chain it evaluates, for the API server as an example: the kubelet unit on the machine is
active → the kubelet's configuration names the static Pod directory → the manifest file there
parses → the image exists in the runtime → the container's command and flags are valid for the
behavior model (an unknown flag makes the real binary exit; so does the model) → files the flags
name exist and are readable (certificates, keys) → etcd is reachable at `--etcd-servers` with the
client certificate → the process listens on its secure port.

Consequences that need no scenario-specific code:

| Broken link | What follows |
|---|---|
| API server not running | The client library gets "connection refused" from the network model; `kubectl` prints its real message for that. Controllers, scheduler and kubelets fail their requests too. |
| Scheduler not running | Its sync events find the component unhealthy and do nothing. Pods stay Pending. |
| Controller manager not running | No ReplicaSets are created, no endpoints updated. |
| Kubelet stopped or unable to reach the API server | Its node Lease is not renewed; the node lifecycle controller marks the node NotReady; containers on the node keep running. |
| etcd pointed at another data directory | The API server serves that directory's objects. |
| A certificate past its validity at the virtual time | TLS fails at the step that uses it, with that client's error. |

Rules for implementers:

- A handler for a component's event starts by asking `componentHealth`. Unhealthy means the
  event is dropped, with a trace record saying why.
- When a component becomes healthy (process start), it does what the real one does at start:
  list what it watches and enqueue everything. Work missed while it was down is found that way,
  not replayed from a backlog.
- Process start and stop are events with modeled durations, so a restart is visible in time.
- Container logs are files in the node's VFS, written by the runtime from behavior model output.
  `kubectl logs`, `crictl logs` and reading `/var/log/pods` see the same bytes.

### 4.5 Network model

`connect(source, destination, port)` is one function used by probes, `curl`, `wget`, `nc`,
`nslookup`, the client library and checks. For a source inside the cluster it resolves in the
order `PLAN.md` §7 gives: name resolution through the Pod's DNS configuration and the health and
configuration of CoreDNS; Service virtual IP to endpoints, only if kube-proxy on the source node
is healthy; NetworkPolicy, only if the CNI enforces it; then the target's listeners.

```ts
type ConnectResult =
  | { outcome: 'answered'; by: Listener; response?: Json }
  | { outcome: 'refused' }
  | { outcome: 'timeout' }
  | { outcome: 'unresolved'; name: string }
  | { outcome: 'tls'; problem: 'expired' | 'unknown-authority' | 'name-mismatch' | 'bad-certificate' };
```

Each step that changes the outcome emits a trace record (which policy dropped it, which Service
had no endpoints). The result carries only what a real client could observe; the explanation is
in the trace.

### 4.6 Vendored schema and resource registry

`npm run api:vendor` (`tools/src/openapi/vendor.ts`) writes per Kubernetes version:

- `packages/k8s/src/openapi/data/<tag>.ts`: every type reachable from a served kind. The
  OpenAPI v3 documents give the structure and annotations, but not what encoding/json does, so
  the tool also reads the Go type declarations of the API packages (`tools/src/openapi/gotypes.ts`)
  and fails if the two disagree. Per struct: each field's JSON name, its Go type as an expression
  (`*int32`, `[]@core/v1.Container`, `map[string]string`, `bytes`), `omitempty`/`omitzero`,
  OpenAPI `required`, list type and keys, patch strategy and merge key, enum values. Named
  non-struct types keep their underlying type (`v1.RestartPolicy` → `string`), and types with
  their own JSON methods are marked (`time`, `microtime`, `quantity`, `intstr`, `json`, …). The
  Go display names (`v1.PodSpec`) are what encoding/json prints in type errors.
  `apimachinery/gojson.ts` decodes request bodies against this (case-sensitive fields, strict
  unknown-field detection, the first type error kept, custom unmarshallers' errors) and encodes
  results as Go does (struct fields in declaration order, map keys sorted, `omitempty`,
  `omitzero`, nil as `null`): decode plus encode is the canonical form stored and returned.
- `packages/k8s/src/discovery/data/<tag>.ts`: the resource registry, from the real API server's
  discovery documents (`fixtures/golden/<tag>/api/discovery.yaml`, captured by the oracle):
  groups in discovery order with their versions and preferred version, and per group version every
  resource and subresource with its singular name, kind (and the kind's group and version for
  subresources such as `scale`), scope, verbs, short names, categories and storage version hash.
- `packages/k8s/src/openapi/data/<tag>.golayout.ts`: the Go struct layouts of the types reachable
  from `core/v1.PodTemplateSpec` (field order, Go names, embedded structs, unexported fields),
  which `controllers/hash` needs to print a template the way go-spew does for the
  `pod-template-hash` (DeepHashObject). Format in `tools/src/openapi/vendor.ts`.
- `packages/k8s/src/openapi/data/<tag>.openapiv3.ts`: the OpenAPI v3 documents the real API
  server serves per group version, captured from an oracle by `npm run openapi:capture`
  (`tools/src/openapi/capture.ts`, D-082; the checked-in spec lacks the enums explain prints) and
  reduced to the keys `kubectl explain` reads. `openapi/v3.ts` rebuilds each document and
  `apiserver/openapi.ts` serves `/openapi/v3`. 1102 KiB (196 KiB gzipped); parsed on the first
  explain in 7–13 ms, all 23 documents built in 4–6 ms (`npm run bench:schema`, phase 08).

The data is a JSON string in a TypeScript module, parsed on first use and cached outside world
state (§2.12). Measured with `npm run bench:schema` (phase 05a, this workstation): the schema is
223 KiB (26 KiB gzipped) and the registry 28 KiB (3 KiB); parsing the schema takes about 4 ms,
building all 760 types reachable from the 142 kinds about 17 ms, the registry about 1.4 ms.


### 4.7 Cluster topologies

`packages/k8s/src/topology/` (D-055, D-057). A topology is a `ClusterDef` in `cluster.ts`: nodes
with role, address, Pod CIDR and machine IDs, the network ranges, whether the control-plane taint
was removed, and the entry. `build.ts` turns any of them into a world, in this order: the machines
(`createMachine`, `buildUbuntuBase` with the user `ubuntu`), kubeadm's files on each node
(`kubeadm.ts`: manifests, kubeconfigs, kubelet files, root's kubeconfig, the kubeadm, kubelet and
kubectl binaries), the API server's bootstrap and its entry in `apiServers`, each Node and its
Lease as a healthy kubelet leaves them (`nodes.ts`), kubeadm's API objects in kubeadm's order, the
control plane's mirror Pods and kube-proxy's Pods as running objects, then the controller manager
and the scheduler, which create and bind CoreDNS. File texts and objects come from the real
kubeadm (`kubeadm/reference.ts`, generated by `npm run kubeadm:capture`). Registered topologies:
`kubeadm-1cp-2w` (controlplane, node01, node02; entry root@controlplane) and `kubeadm-1n` (one
untainted node). Building `kubeadm-1cp-2w` and running ten virtual seconds takes about 0.3 s; a
fork of the result about 0.3 ms.

### 4.8 Kubelet and container runtime

`packages/k8s/src/kubelet/` and `packages/k8s/src/runtime/` (D-058, D-059). Each node's kubelet is
an instance of the controller runtime named after the node (`<node>/kubelet`), acting as
`system:node:<node>`; the runtime (containerd 1.7.28 behind the CRI) is world data of the node,
`k8sSlice.runtimes[node]`, and outlives the kubelet.

```mermaid
flowchart LR
  W[Pod watch: spec, labels,<br/>annotations, deletion] --> Q[kubelet queue<br/>ns/name/uid]
  P[PLEG: runtime change,<br/>next 1 s relist tick] --> Q
  Q --> S[pod worker: SyncPod]
  S -- status first --> API[(pods/status)]
  S -- RunPodSandbox / PullImage /<br/>CreateContainer / StartContainer / StopContainer --> R[NodeRuntime]
  R -- suspended until the call returns --> S
  R --> M[behavior models<br/>host.behavior-model]
  M --> L["/var/log/pods/…/N.log"]
```

- **Pod workers** (`pods.ts`): one SyncPod per Pod at a time. Status is written first, from the
  runtime's view and the reason cache; then the sandbox, then each container in spec order:
  doBackOff (crash loop: 10 s doubling to 5 min, reset after 10 min), EnsureImageExists (pull
  policies, the per-image back-off, the serial puller), CreateContainer, StartContainer. A call that
  takes time suspends the sync in the worker's `PodOp`; the key returns when it completes; other
  triggers set the pending flag. completeWork's requeues are upstream's. Deletion kills the
  containers with the grace period (floored at 2 s), stops the sandbox, writes the terminal status
  (TerminatePod) and deletes the Pod with grace 0 and its UID as precondition.
- **Status** (`status.ts`): generateAPIPodStatus, getPhase, the five kubelet conditions with their
  reasons and lastTransitionTime rules, container statuses (state and lastState from the two newest
  containers, the reason cache overriding the state), observedGeneration.
- **Runtime** (`runtime/runtime.ts`): CRI operations on world data; one `k8s.runtime.container`
  event pending per container for its next model wake-up, delayed output, exit or SIGKILL.
  StopContainer sends the image's StopSignal, then SIGKILL at the timeout. Exits get containerd's
  reasons (Completed, Error, StartError with exit 128 for runc's create-time failure).
- **Images** (`runtime/images/`): `catalog.data.ts` from `npm run images:capture` (D-061);
  `reference.ts` is distribution/reference's parser; `catalog.ts` decides what a pull yields and
  containerd's error texts; `files.ts` resolves executables in an image and the model each runs.
- **Process** (`kubelet/env.ts`): command/args against Entrypoint/Cmd, the environment as the
  kubelet builds it ($(VAR) expansion, service variables) and containerd and runc merge it.
- **Node side** (`node.ts`): start events, Lease renewal and node status as idle periodic events
  (D-062). The node lifecycle controller's health monitoring (`controllers/nodelifecycle/
  health.ts`, D-063) marks a silent node Unknown after 50 s.
- **Timing**: `kubelet/latency.ts` holds the modeled step durations, each drawn from its own
  stream (D-065). Starting nginx on a fresh node takes two to four seconds, mostly the pull.
- **Trace kinds**: `controller.sync` for each pod-worker turn, then `kubelet.sandbox`,
  `kubelet.pull.start`/`.done`, `kubelet.backoff`, `kubelet.sync.done`, `kubelet.pod.terminal`,
  `kubelet.pod.terminated`, `kubelet.gc`, `kubelet.gap`; `runtime.sandbox.ready`/`.stopped`,
  `runtime.container.created`/`.started`/`.start-failed`/`.exited`/`.signal`,
  `runtime.signal.ignored`, `runtime.process.wake`/`.exec`, `runtime.model.gap`;
  `nodelifecycle.unknown`.
- `startKubelet`/`stopKubelet` start and stop one kubelet; phase 26a ties them to the
  `kubelet.service` unit and its configuration.

### 4.9 kubectl

`packages/k8s/src/kubectl/` (phases 07a, 07b and 08; D-066…D-070, D-073…D-078, D-082…D-092). One program, `kubectl`,
registered by the k8s plugin; a simulated command is one `Verb` module under `cmd/`, the phase 08
verbs one directory per group (`cmd/<group>/index.ts` registers them and their provenance).

```mermaid
flowchart LR
  A[argv] --> F[cli/command.ts<br/>cobra Find over the manifest tree]
  F --> P[cli/flagset.ts<br/>pflag parse: command + global flags]
  P -->|unknown command/flag| E[cli/errors.ts<br/>CheckErr texts]
  P -->|real but not simulated| N["[sim] notice + gap"]
  P --> V[cmd/get.ts …]
  V --> K[client/kubeconfig.ts<br/>files, contexts, namespace]
  V --> T[client/transport.ts<br/>server URL → API server or refusal]
  V --> R[resource/builder.ts + client/restmapper.ts<br/>args → visits]
  V --> S[client/session.ts → apiserver handle()]
  S --> O[printers: Table, YAML, JSON, name]
```

- **The manifest is the command tree.** `manifest.ts` reads `kubectl/data/v1.37.2.ts`, which
  `npm run golden:kubectl-manifest` writes from the real binary's help (every command, alias and
  flag, the global flags, and the help text). `cli/command.ts` runs cobra's `Find` over it
  (`stripFlags`, `argsMinusFirstX`, aliases, `legacyArgs` with Levenshtein suggestions), so an
  unknown command or flag gets kubectl's own error, and a real one the simulator lacks gets the
  `[sim]` notice: a command without a `Verb` (`the command "kubectl logs"`), or a flag the
  verb does not declare and no no-effect list names (`the flag --sort-by`). Flags are parsed as
  pflag parses them (`cli/flagset.ts`: long and short forms, `=` or a separate value, grouped
  shorthands, bools with `NoOptDefVal`, slices, `--`, `_` normalized to `-`) with the real types'
  value errors (strconv, time.ParseDuration).
- **No-effect flags** (docs/FIDELITY.md §4.1) are listed with their reason: globally
  `--request-timeout`, `--cache-dir`, `--log-flush-frequency` (`kubectl.ts`); per verb in
  `Verb.noEffect` (get: `--chunk-size`, `--allow-missing-template-keys`, `--show-managed-fields`).
- **Client configuration** (`client/kubeconfig.ts`) is clientcmd's: `--kubeconfig` (must exist),
  else `KUBECONFIG` (missing files skipped), else `~/.kube/config`, read from the machine's VFS as
  the process; first file wins per entry; `--context`, `--cluster`, `--user`, `-n`, `-s`
  override; `Namespace()` runs ConfirmUsable before `ClientConfig()`, which fixes which error a
  bad name produces. The default server is `http://localhost:8080`. Credentials are not read
  (D-057, D-069).
- **Transport** (`client/transport.ts`, D-068): the server URL's host is resolved to a machine by
  its addresses (`Machine.addresses`, a stand-in until phase 17's network model; loopback is the
  local machine). An API server listens on every address of its machine at its secure port
  (`k8sSlice.apiServers`); nothing listening is a refusal, which `client/session.ts` prints as
  kubectl does (five `memcache.go:381` klog lines, then `The connection to the server … was
  refused`). A host no machine has, a machine that is off, or plain HTTP to the secure port
  prints a notice.
- **Resources** (`client/restmapper.ts`, `resource/builder.ts`): discovery is the real server's
  (`discovery/registry.ts`); the shortcut expander, the priority REST mapper (core first, then
  discovery order) and the category expander are ported; the builder turns arguments into visits
  (list with selectors, or get by name) and reports argument errors before any request. A visit
  of a type the API server does not store answers `notSimulated`: printed as a notice when the
  type was named, skipped when it came from a category (`get all`, D-066).
- **get** (`cmd/get.ts`): human-readable output asks for server-side Tables (`as: 'Table'`) and
  prints them with one printer per mapping and a blank line between mappings; `-o yaml|json|name`
  fetch objects and wrap several in kubectl's `List`; `-w` prints the first state and then the
  watch's events (one-row Tables) until Ctrl-C, which ends it with status 1 as kubectl's interrupt
  handler does. Formats kubectl knows but the simulator does not print (jsonpath, custom-columns,
  templates, kyaml) are notices; others get kubectl's "unable to match a printer" error.
- **Manifests** (`resource/files.ts`, D-074): `-f` paths (files, directories by extension, `-R`,
  globs, `-`) are read from the machine's VFS and decoded with go-yaml and sigs.k8s.io/yaml
  (`apimachinery/yaml/`) before the first request; each document is mapped to its resource and
  namespace. create, apply, delete and describe visit the items in order with ContinueOnError.
- **create and apply** (`cmd/create.ts`, `cmd/apply.ts`, `util/apply.ts`): create posts each object
  with fieldValidation from `--validate`; apply writes the
  `kubectl.kubernetes.io/last-applied-configuration` annotation, creates what is missing and
  otherwise sends the three-way strategic merge patch of last-applied, the file and the live
  object (`apimachinery/strategicpatch/`, D-073), which the API server applies as its smpPatcher
  does; an empty patch is `unchanged`. Dry runs are client-side (no request) or `dryRun=All`.
- **delete** (`cmd/delete.ts`, D-078): one DELETE per object with the grace period and propagation
  policy the flags give, then (unless `--wait=false`) a watch per object until it is gone, in
  virtual time, so a Pod's grace period is a real wait at the prompt.
- **describe** (`cmd/describe.ts`, `describe/`, D-076): describers for Pod, Deployment, Service and
  Node send the requests upstream's do (events by involvedObject field selector, a Deployment's
  ReplicaSets, a Node's non-terminated Pods and Lease, a Service's EndpointSlices) and write
  through a port of the PrefixWriter onto the tab writer.
- **Generators** (`cmd/generate/`, D-085, D-089): run, expose, `create deployment|namespace|
  serviceaccount|configmap|secret generic|service *`. Typed objects print through
  `cmd/typed.ts` (struct order via the vendored Go types); `--overrides` through merge, strategic
  and JSON patch.
- **Changing things** (`cmd/change/`, D-091, D-092): scale (the scale subresource,
  `apiserver/scale.ts`; `--timeout` polls in virtual time), set image (a typed strategic patch),
  label and annotate (JSON merge patches), edit (the editor as a child process on a temporary
  file, the reopen-on-invalid loop); `finder.ts` is their shared builder.
- **Rollouts** (`cmd/rollout/`, D-083, D-084): status watches the object by name in virtual time
  and prints the status viewer's line per event; history and undo read the ReplicaSets; undo
  sends a JSON patch (`apimachinery/jsonpatch.ts`, a json-patch v4 port); pause, resume and
  restart send two-way strategic patches.
- **logs** (`cmd/logs/`, D-088): LogsForObject picks Pods, `apiserver/log.ts` is LogREST and
  `kubelet/logs.ts` ReadLogs over the CRI file; `-f` waits on the topic `k8s.logs` and ends when
  the container or the kubelet stops, or on Ctrl-C (status 1).
- **explain** (`cmd/explain/`, D-082): explain.go and explain/v2 ported; `template.ts` is
  plaintext.tmpl define by define over the served document, `fieldpath.ts` the jsonpath subset
  field paths use.
- **Version and discovery** (`cmd/info/`, D-087): version, api-resources, api-versions and
  cluster-info read `/version` and legacy discovery from `apiserver/nonresource.ts` through
  `session.getNonResourcePath`.
- **config** (`cmd/config/`, D-086): the kubeconfig model (`client/kubeconfigmodel.ts`, whose
  decoder every verb's loader uses), clientcmd's PathOptions and ModifyConfig; view, get-contexts, get-clusters, get-users, current-context, use-context,
  set-context, delete-context.
- **Completion** (`completion/`, D-090): cobra's `__complete` over the manifest with kubectl's
  completion functions, and the bash V2 script's presentation; the shell runs it as the
  documented setup does, through aliases too.
- **Latency** (`npm run bench:kubectl`, PLAN.md §2: p95 under 50 ms for read commands): from Enter
  to the prompt in a login shell on the control plane with a three-replica Deployment running,
  200 runs each, measured 2026-11-16 on the workstation (§2.1 of docs/FIDELITY.md): `get pods`
  p95 2.7 ms, `-o wide` 2.4 ms, `-A` 2.6 ms, `get all` 2.7 ms, `get deployment web -o yaml`
  4.1 ms, `get nodes` 2.4 ms; all together p50 1.4 ms, p95 3.2 ms (the first run's 31 ms is
  warm-up).
- **Provenance**: `kubectl/provenance.ts` (framework, client, get) and the printers' own lists,
  gathered by `packages/k8s/src/provenance.ts` and contributed as `provenance` (docs/FIDELITY.md §3,
  `npm run fidelity:report`).

## 5. The hard questions, answered in one place

**How do blocking programs stay deterministic?** A program is a synchronous generator that
yields syscalls (§3.4). It runs only when the kernel resumes it, and the kernel resumes it only
while handling a `host.proc.run` event taken from the single event queue ordered by
`(time, sequence)`. What a blocked process waits for is world data. There is no promise, no
microtask, no real timer and no thread anywhere in the engine, so there is no second source of
ordering. Asynchrony from the outside world enters only as inputs stamped with virtual time and
recorded (§2.5, §2.8).

**How do streaming pipelines stay deterministic?** Each stage is its own process; stages are
connected by streams that are world data with a capacity (§3.5). A write wakes the reader through
a topic, which schedules an ordinary event. Back-pressure, end of file and `SIGPIPE` are modeled,
so pipelines end for the reasons real ones end. A stage that never blocks is preempted after a
fixed syscall budget and charged 1 ms of virtual time, which bounds the work per instant and lets
Ctrl-C arrive.

**How does fork stay cheap?** World state is split into containers and deeply frozen values
(§2.1). Fork copies containers and shares values, so its cost follows the number of table
entries, not the bytes of state (§2.7). The frozen flag is the marker, so the algorithm needs no
schema, and mistakes fail safe: an unfrozen value is copied, a frozen container throws on write.
Hashing reuses the same property through a cache keyed by value identity.

**What may live outside world state?** Five things, each for a stated reason (§2.12): the
registry (code and static data), derived caches (rebuildable), program coroutine frames (rebuilt
by replay, or recreated at a restart point), write-only ports (the engine cannot read them), and
the input log with the time driver (they cause the world). The price of keeping frames outside is
that a fork terminates programs that are mid-flight in the copy; `PLAN.md` §6.1 already accepts
this by resuming sessions through replay and taking snapshots only at quiescent points.

**Why are actors not coroutines too?** Because they must survive fork, snapshot and restore
unchanged. A check that forks the world needs the kubelet and the controllers to keep working in
the fork. So everything long-lived is an event handler over world data, and only what a shell
starts is a coroutine.

**Where does real time enter?** In the time driver, outside the engine, and only to choose the
virtual timestamp of an input. In the session header as `startTime`, read once by the app. In
the gap sink, which adds a wall-clock time to a record after it has left the engine.

## 6. Left to the implementing phases

Each item is decided by the phase named, and recorded here when decided.

| Item | Phase |
|---|---|
| PRNG algorithm (xoshiro128**, §2.6), hash function (cyrb53 core, Merkle, §2.7), heap (binary min-heap in an array, `heap.ts`), zero-time event limit (100 000, §2.5): **decided in 01** | 01 |
| Process slice budget: **1000 syscalls, decided in 02** (§3.4) | 02 |
| Supported shell grammar and the list of builtins: **phase 02's in `docs/COVERAGE.md`** | 02, 22a |
| Line editor key bindings (bash 5.2.21's `bind -p`, D-027); SGR style of the `[sim]` notice (yellow, D-026): **decided in 03** | 03 |
| Normalization tokens (`<<kind>>`, `packages/host/src/transcript/tokens.ts`; D-034, D-035): **decided in 04** | 04 |
| Provenance registry implementation: **decided in 07a** (`provenance` contributions of `ProvenanceSpec`, `validateProvenance` in `packages/kernel/src/contracts.ts`, `npm run fidelity:report`) | 07a |
| Processed OpenAPI format (§4.6); exact pipeline stage order verified against upstream (§4.2): **decided in 05a** | 05a |
| Work queue backoff parameters, controller latencies with their sources: **decided in 05b** (§4.3) | 05b |
| Behavior model contract (D-060, `docs/BEHAVIOR_MODELS.md`) and image catalog format (D-061): **decided in 06b**; declarative fields beyond `docs/SCENARIO_FORMAT.md` §5.4 come with the first item that declares an image (none in 09; the runner refuses `world.images` until then) | 06b |
| Certificate stand-in format | 25b |
| Container machines: how mounts project volumes | 16a, 17 |
