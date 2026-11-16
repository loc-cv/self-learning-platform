// The steps and checks the host and the k8s plugin register for scenarios (docs/SCENARIO_FORMAT.md
// §6, §7.1), on a real world: what they do, how they fail, and how they read in a solution.

import { describe, expect, test } from 'vitest';
import { CHECK, STEP, type CheckSpec, type Json, type StepSpec } from '@simlab/kernel';
import { createFs, ROOT_CRED } from '@simlab/host';
import { buildBaseline, createPortHub, createStepSession, evaluate, runSteps, startSession, StepFailure, variantOf, type Item, type Step } from '@simlab/learn';
import { contentRegistry } from './registry.ts';

const world = (() => {
  const item = {
    id: 'test.steps.world-01',
    kind: 'lab',
    title: 't',
    skills: [],
    curriculum: [],
    difficulty: 1,
    targetMinutes: 1,
    world: { topology: 'kubeadm-1cp-2w', setup: [] },
    ticket: 't',
    hints: [],
    checks: [],
    solutions: [],
    debrief: 't',
  } as unknown as Item;
  return buildBaseline(variantOf(item, 1), contentRegistry);
})();

function session() {
  const s = startSession(world);
  const run = (steps: Step[]): void => runSteps(s.kernel, steps, { registry: contentRegistry, entry: world.entry, hub: s.hub, baseline: world.kernel.world }, 'test');
  const fails = (steps: Step[]): StepFailure => {
    try {
      run(steps);
    } catch (e) {
      if (e instanceof StepFailure) return e;
      throw e;
    }
    throw new Error('the steps did not fail');
  };
  const check = (assert: string, args: Json, not = false) => evaluate(s.kernel, { assert, with: args as never, not }, { registry: contentRegistry, entry: world.entry, baseline: world.kernel.world });
  const read = (machine: string, path: string): string => s.kernel.act('read', (c) => createFs(c, machine, { cred: ROOT_CRED, umask: 0 }).readFile(path));
  return { s, run, fails, check, read };
}

describe('run', () => {
  test('one shell per machine and user for the whole list: cd and variables persist', () => {
    const t = session();
    t.run([{ run: 'mkdir -p /tmp/w && cd /tmp/w && X=7' }, { run: 'echo $X > here' }, { run: 'touch elsewhere', on: 'node01' }]);
    expect(t.read('controlplane', '/tmp/w/here')).toBe('7\n');
    expect(t.read('node01', '/root/elsewhere')).toBe('');
  });

  test('fails on an unexpected exit status, with the output', () => {
    const t = session();
    expect(t.fails([{ run: 'ls /nope' }]).reason).toBe("exit status 2, expected 0; output:\nls: cannot access '/nope': No such file or directory");
    t.run([{ run: 'ls /nope', expect: { exit: 2 } }]);
  });

  test('a [sim] notice fails the step as unsupported', () => {
    const f = session().fails([{ run: 'kubectl taint nodes node01 a=b:NoSchedule' }]);
    expect(f.gap).toBe(true);
    expect(f.reason).toMatch(/^the simulator does not support this: kubectl: /);
  });

  test('answers the editor; an editor without an answer, a missing text, or a reopened editor fail', () => {
    const t = session();
    t.run([{ run: 'echo "replicas: 1" > /root/f' }, { run: 'vim /root/f', editor: [{ replace: { from: 'replicas: 1', to: 'replicas: 3' } }] }]);
    expect(t.read('controlplane', '/root/f')).toBe('replicas: 3\n');
    expect(t.fails([{ run: 'vim /root/f' }]).reason).toBe('/root/f: the command opened an editor and the step has no `editor` answer');
    expect(t.fails([{ run: 'vim /root/f', editor: [{ replace: { from: 'nope', to: 'x' } }] }]).reason).toBe('editor: "nope" is not in the buffer');
    expect(t.fails([{ run: 'true', editor: [{ write: 'x' }] }]).reason).toBe('the step has an `editor` answer but the command opened no editor');
    t.run([{ run: 'kubectl create configmap c --from-literal=k=v' }]);
    const reopened = t.fails([{ run: 'kubectl edit configmap c', editor: [{ replace: { from: '  k: v', to: '  bad key!: v' } }] }]);
    expect(reopened.reason).toMatch(/the editor opened again after the edit/);
  });

  test('an unknown machine or user', () => {
    expect(session().fails([{ run: 'true', on: 'node09' }]).reason).toBe('there is no machine node09');
    expect(session().fails([{ run: 'true', as: 'alice' }]).reason).toBe('machine controlplane has no user alice');
  });
});

describe('write', () => {
  test('relative to the home of the user, with mode, owner and group', () => {
    const t = session();
    t.run([
      { write: { path: 'notes/a.txt', content: 'hello\n' }, on: 'node01', as: 'ubuntu' },
      { write: { path: '/etc/x.conf', content: 'k=v\n', mode: '0640', owner: 'ubuntu', group: 'adm' } },
    ]);
    expect(t.read('node01', '/home/ubuntu/notes/a.txt')).toBe('hello\n');
    expect(t.check('host.file', { on: 'node01', path: '/home/ubuntu/notes/a.txt', owner: 'ubuntu', mode: '0644' })).toMatchObject({ status: 'pass' });
    expect(t.check('host.file', { on: 'controlplane', path: '/etc/x.conf', mode: '0640', owner: 'ubuntu', group: 'adm', contains: 'k=v' })).toMatchObject({ status: 'pass' });
  });
});

describe('apply', () => {
  test('applies as the cluster admin with kubectl apply semantics', () => {
    const t = session();
    t.run([{ apply: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n  namespace: default\ndata:\n  a: "1"\n' }]);
    expect(t.check('k8s.object', { kind: 'ConfigMap', name: 'settings', where: [{ path: "{.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']}", contains: '"a":"1"' }] })).toMatchObject({ status: 'pass' });
  });

  test("fails with kubectl's own error", () => {
    const f = session().fails([{ apply: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: Bad_Name\n' }]);
    expect(f.reason).toMatch(/^kubectl apply exited with 1:\nThe ConfigMap "Bad_Name" is invalid: metadata.name: Invalid value: "Bad_Name"/);
  });
});

describe('shell.exec and host.file', () => {
  test('exit status, standard output and standard error are judged separately', () => {
    const t = session();
    expect(t.check('shell.exec', { run: 'echo out; echo err >&2', stdout: { equals: 'out' }, stderr: { equals: 'err' } })).toMatchObject({ status: 'pass' });
    expect(t.check('shell.exec', { run: 'echo out; echo err >&2', stdout: { contains: 'err' } })).toMatchObject({ status: 'fail', observed: 'its output does not contain "err"; output "out", standard error "err"' });
    expect(t.check('shell.exec', { run: 'ls /nope', exit: 2, stderr: { matches: '^ls: cannot access' } })).toMatchObject({ status: 'pass' });
    expect(t.check('shell.exec', { run: 'false' })).toMatchObject({ status: 'fail', expected: '`false` exits with 0', observed: 'exited with 1; output nothing' });
    expect(t.check('shell.exec', { run: 'kubectl taint nodes node01 a=b:NoSchedule' })).toMatchObject({ status: 'error' });
  });

  test('shell.exec leaves no trace in the session world', () => {
    const t = session();
    const before = t.s.kernel.hash();
    expect(t.check('shell.exec', { run: 'touch /root/trace' })).toMatchObject({ status: 'pass' });
    expect(t.check('host.file', { on: 'controlplane', path: '/root/trace', exists: false })).toMatchObject({ status: 'pass' });
    expect(t.s.kernel.hash()).toBe(before);
  });

  test('host.file reports what differs', () => {
    const t = session();
    expect(t.check('host.file', { on: 'controlplane', path: '/root/none' })).toMatchObject({ status: 'fail', observed: '/root/none does not exist' });
    expect(t.check('host.file', { on: 'controlplane', path: '/etc', type: 'file' })).toMatchObject({ status: 'fail', observed: 'it is a directory' });
    expect(t.check('host.file', { on: 'nowhere', path: '/etc' })).toMatchObject({ status: 'error', error: 'there is no machine nowhere' });
  });
});

describe('how steps read in a reference solution', () => {
  const show = (name: string, args: Json): string => (contentRegistry.get<StepSpec>(STEP, name)?.show?.(args) ?? '');

  test('run, with machine, user and editor', () => {
    expect(show('run', { run: 'kubectl get pods' })).toBe('$ kubectl get pods');
    expect(show('run', { run: 'vim f', on: 'node01', as: 'root', editor: [{ replace: { from: 'a', to: 'b' } }] })).toBe('# on node01 as root\n$ vim f\n# in the editor, change "a" to "b"\n# then save and quit');
  });

  test('write and apply as heredocs a person could type', () => {
    expect(show('write', { write: { path: '/root/a.yaml', content: 'x: 1\n', mode: '0600' } })).toBe("$ cat > /root/a.yaml <<'EOF'\nx: 1\nEOF\n$ chmod 0600 /root/a.yaml");
    expect(show('apply', { apply: 'kind: X\n' })).toBe("$ kubectl apply -f - <<'EOF'\nkind: X\nEOF");
  });

  test('every registered step kind and check has an argument schema; every step kind shows itself', () => {
    for (const s of contentRegistry.list<StepSpec>(STEP)) {
      expect(s.args['type'], s.name).toBe('object');
      expect(typeof s.show, s.name).toBe('function');
    }
    for (const c of contentRegistry.list<CheckSpec>(CHECK)) expect(c.args['type'], c.name).toBe('object');
  });
});

test('the hub delivers to listeners only while they are attached', () => {
  const hub = createPortHub();
  const seen: string[] = [];
  const s = createStepSession(hub, world.entry);
  s.listen({ output: (o) => seen.push(o.kind) });
  hub.ports.output?.({ kind: 'tty', tty: 'x', data: 'a' });
  s.end();
  hub.ports.output?.({ kind: 'tty', tty: 'x', data: 'b' });
  expect(seen).toEqual(['tty']);
});
