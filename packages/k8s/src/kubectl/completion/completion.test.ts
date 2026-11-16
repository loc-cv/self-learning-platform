// kubectl's completion beyond what the golden cases compare: answers whose order the real binary
// randomizes (Go maps), the descriptions switch, the hidden command's own error, the script
// generator, printf %q, and the shell side's word handling.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootKernel, createRegistry, DEFAULT_START_TIME, TOPOLOGY, type Plugin, type TopologyInfo, type TopologySpec } from '@simlab/kernel';
import { captureOutput, createFs, hostPlugin, openSession, PROGRAM, type ProgramSpec } from '@simlab/host';
import { dispatch } from '../cli/command.ts';
import { helpCommands, helpOutput } from '../cmd/help.ts';
import { GLOBALS } from '../kubectl.ts';
import { k8sPlugin } from '../../plugin.ts';
import { parseYaml } from '../cmd/printing.ts';
import { compWords, shellQuote } from './bash.ts';
import { runComplete } from './run.ts';
import { bashCompletionScript, completionVerb } from './script.ts';

const registry = createRegistry([hostPlugin, k8sPlugin]);

function boot() {
  const capture = captureOutput();
  const kernel = bootKernel(registry, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
  const spec = registry.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
  const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
  kernel.advance(10_000);
  const machine = info.entry.machine;
  /** `kubectl __complete <args>` as root in /root on the control plane. */
  const complete = (args: string[], env: Record<string, string> = {}, noDesc = false) =>
    kernel.act('complete', (ctx) =>
      runComplete({ ctx, machine, fs: createFs(ctx, machine, { cred: { uid: 0, gid: 0, groups: [0] }, cwd: '/root', umask: 0o022 }), env: { HOME: '/root', ...env } }, args, noDesc),
    ) as { stdout: string; stderr: string };
  const session = () => openSession(kernel, capture, { machine, user: info.entry.user });
  return { kernel, complete, session };
}

describe('kubectl __complete', () => {
  test('the shells of `completion`, which kubectl ranges over a map, and the contexts of a kubeconfig', () => {
    const { complete, session } = boot();
    expect(complete(['completion', '']).stdout.split('\n').sort()).toEqual(['', ':4', 'bash', 'fish', 'powershell', 'zsh']);
    const s = session();
    s.run("printf 'apiVersion: v1\\nkind: Config\\ncontexts:\\n- name: b\\n  context: {cluster: c}\\n- name: a\\n  context: {cluster: c}\\nclusters:\\n- name: c\\n  cluster: {server: https://127.0.0.1:1}\\n' > /root/two");
    expect(complete(['--kubeconfig', '/root/two', '--context', '']).stdout.split('\n').sort()).toEqual(['', ':4', 'a', 'b']);
  });

  test('KUBECTL_COMPLETION_DESCRIPTIONS=false drops descriptions; __completeNoDesc always does', () => {
    const { complete } = boot();
    expect(complete(['ge']).stdout).toBe('get\tDisplay one or many resources\n:4\n');
    expect(complete(['ge'], { KUBECTL_COMPLETION_DESCRIPTIONS: 'false' }).stdout).toBe('get\n:4\n');
    expect(complete(['ge'], { KUBECTL_COMPLETION_DESCRIPTIONS: 'nonsense' }).stdout).toBe('get\tDisplay one or many resources\n:4\n');
    expect(complete(['ge'], {}, true).stdout).toBe('get\n:4\n');
  });

  test('names come from the namespace of -n, of the context, and of none when the server is unreachable', () => {
    const { complete, session } = boot();
    const pods = complete(['-n', 'kube-system', 'get', 'pods', 'kube-api']).stdout;
    expect(pods).toBe('kube-apiserver-controlplane\n:4\n');
    // The kubeconfig points at nothing that listens: no candidates, only the directive.
    expect(complete(['--server', 'https://127.0.0.1:1', 'get', 'pods', '']).stdout).toBe(':4\n');
    // As a process, kubectl's discovery logs each attempt on standard error.
    const err = session().run("kubectl __complete --server https://127.0.0.1:1 get pods '' 2>&1 >/dev/null").output;
    expect(err).toMatch(/memcache\.go:381\] "Couldn't get current server API group list" err="Get \\"https:\/\/127\.0\.0\.1:1\/api\?timeout=32s\\": dial tcp 127\.0\.0\.1:1: connect: connection refused"\n/);
    expect(err.split('\n').filter((l) => l.includes('memcache.go')).length).toBe(5);
    expect(err.endsWith('Completion ended with directive: ShellCompDirectiveNoFileComp\n')).toBe(true);
  });

  test('the hidden command needs the words to complete', () => {
    const { session } = boot();
    const s = session();
    expect(s.run('kubectl __complete').output).toBe('error: requires at least 1 arg(s), only received 0\n');
    expect(s.run('echo $?').output).toBe('1\n');
  });

  test('it answers fast enough to run on every Tab', () => {
    const { complete } = boot();
    complete(['get', '']);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      complete(['get', '']);
      complete(['-n', 'kube-system', 'get', 'pods', '']);
      complete(['get', '--']);
    }
    expect((performance.now() - t0) / 60).toBeLessThan(25);
  });
});

describe('kubectl completion bash', () => {
  test('prints the boilerplate and cobra V2 script the real binary prints', () => {
    const fixture = readFileSync(join(import.meta.dirname, '../../../../../fixtures/golden/v1.37.2/completion/script.yaml'), 'utf8');
    const doc = parseYaml(fixture);
    if (!('value' in doc)) throw new Error('fixture does not parse');
    const steps = (doc.value as { steps: { run: string; stdout: string }[] }).steps;
    const real = steps.find((s) => s.run === 'kubectl completion bash')?.stdout as string;
    const boilerplate = real.slice(0, real.indexOf('# bash completion V2'));
    expect(boilerplate.startsWith('\n# Copyright 2016 The Kubernetes Authors.')).toBe(true);
    expect(boilerplate + bashCompletionScript()).toBe(real);
  });
});

describe('kubectl completion SHELL', () => {
  // The verb as kubectl's dispatch runs it, in a program of its own until kubectl.ts lists it.
  const kctl: ProgramSpec = {
    name: 'kctl',
    *main(p) {
      return yield* dispatch(p, {
        verbs: [completionVerb],
        globals: GLOBALS,
        help: (q, path) => helpOutput(q, path),
        helpCommands: (q, path, args) => helpCommands(q, path, args),
        *unsupported(q, kind, what) {
          return yield* q.unsupported({ kind, what });
        },
        *fail(q, text) {
          yield* q.write(2, text.endsWith('\n') ? text : `${text}\n`);
          return 1;
        },
      });
    },
  };
  const plugin: Plugin = { name: 'kctl', contributions: { [PROGRAM]: [kctl] } };

  test('the usage errors of the real binary, and a notice for the shells other than bash', () => {
    const reg = createRegistry([hostPlugin, k8sPlugin, plugin]);
    const capture = captureOutput();
    const kernel = bootKernel(reg, { seed: 1, startTime: DEFAULT_START_TIME, ports: capture.ports });
    const spec = reg.get<TopologySpec>(TOPOLOGY, 'kubeadm-1cp-2w') as TopologySpec;
    const info = kernel.act('topology', (ctx) => spec.build(ctx, {})) as TopologyInfo;
    kernel.advance(10_000);
    kernel.act('install', (ctx) => createFs(ctx, info.entry.machine, { cred: { uid: 0, gid: 0, groups: [0] }, umask: 0o022 }).installProgram('/usr/local/bin/kctl', 'kctl', { size: 100 }));
    const s = openSession(kernel, capture, { machine: info.entry.machine, user: info.entry.user });
    expect(s.run('kctl completion 2>&1; echo $?').output).toBe("error: Shell not specified.\nSee 'kubectl completion -h' for help and examples\n1\n");
    expect(s.run('kctl completion tcsh 2>&1; echo $?').output).toBe('error: Unsupported shell type "tcsh".\nSee \'kubectl completion -h\' for help and examples\n1\n');
    expect(s.run('kctl completion bash zsh 2>&1; echo $?').output).toBe("error: Too many arguments. Expected only the shell type.\nSee 'kubectl completion -h' for help and examples\n1\n");
    expect(s.run('kctl completion bash | head -3').output).toBe('\n# Copyright 2016 The Kubernetes Authors.\n#\n');
    expect(s.run('kctl completion zsh').output).toContain('[sim]');
  });
});

describe('the script side', () => {
  test('printf %q escapes as bash 5.2 does', () => {
    expect(shellQuote('pods,secrets')).toBe('pods\\,secrets');
    expect(shellQuote('kubernetes-admin@kubernetes')).toBe('kubernetes-admin@kubernetes');
    expect(shellQuote('a b')).toBe('a\\ b');
    expect(shellQuote('~a')).toBe('\\~a');
    expect(shellQuote('a~')).toBe('a~');
    expect(shellQuote('#a')).toBe('\\#a');
    expect(shellQuote('a=b:c')).toBe('a=b:c');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a\tb')).toBe("$'a\\tb'");
  });

  test('words keep `=` and `:` and split at the other word breaks', () => {
    expect(compWords('kubectl get pods --namespace=te').words).toEqual(['kubectl', 'get', 'pods', '--namespace=te']);
    expect(compWords('kubectl get pods ').words).toEqual(['kubectl', 'get', 'pods', '']);
    expect(compWords('kubectl config use-context a@b').words).toEqual(['kubectl', 'config', 'use-context', 'a', '@', 'b']);
    expect(compWords("kubectl get pods 'we").open).toBe(true);
  });
});
