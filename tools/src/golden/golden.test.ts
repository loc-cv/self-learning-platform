// Offline tests of the golden tooling: the tab writer port and its inverse, normalization rules,
// the case format, and the committed fixtures themselves. Nothing here starts the oracle or uses
// the network (docs/FIDELITY.md §6).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, test } from 'vitest';
import { casesDir, fixturesDir } from '../oracle/paths.ts';
import { defaultTable, parseCase } from './case.ts';
import { newContext, normalizeJson, normalizeText, normalizeValue } from './normalize.ts';
import { DESCRIBE, GET_TABLE, parse, render } from './tabwriter.ts';

function files(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p, ext) : n.endsWith(ext) ? [p] : [];
    });
}

describe('tab writer', () => {
  test('renders like kubectl get: minimum width 6, padding 3, last cell unpadded', () => {
    expect(render([['NAME', 'READY', 'AGE'], ['nginx', '1/1', '5s']], GET_TABLE)).toBe('NAME    READY   AGE\nnginx   1/1     5s\n');
  });

  test('a line with one cell ends the column blocks (describe sections)', () => {
    const out = render([['Name:', 'x'], ['Containers:'], ['  long-name:', 'y']], DESCRIBE);
    expect(out).toBe('Name:  x\nContainers:\n  long-name:  y\n');
  });

  test('RememberWidths keeps a column at least as wide as an earlier flush made it', () => {
    const p = { ...GET_TABLE, rememberWidths: true };
    expect(render([['LONGNAME', 'A'], [''], ['N', 'B']], p)).toBe('LONGNAME   A\n\nN          B\n');
  });

  test('parse reads continuation lines as an empty first cell', () => {
    const text = 'Labels:       app=web\n              tier=x\nAnnotations:  <none>\n';
    expect(parse(text, DESCRIBE)).toEqual([['Labels:', 'app=web'], ['', 'tier=x'], ['Annotations:', '<none>']]);
  });

  test('parse keeps indents, empty last cells and a trailing space of a cell', () => {
    const text = '    Container ID:   \n    Image:          nginx\nConditions:\n  Type              Status\n  ContainersReady   True \n';
    const cells = parse(text, DESCRIBE);
    expect(cells).toBeDefined();
    expect(render(cells ?? [], DESCRIBE)).toBe(text);
  });

  test('get tables are cut at the header columns, so an empty cell survives', () => {
    const text = 'OBJECT   SUBOBJECT   SOURCE\npod/a                default-scheduler\n';
    expect(parse(text, GET_TABLE)).toEqual([['OBJECT', 'SUBOBJECT', 'SOURCE'], ['pod/a', '', 'default-scheduler']]);
  });

  test('parse refuses text that is not tab writer output', () => {
    expect(parse('a  b\nccc  d\n', DESCRIBE)).toBeUndefined();
  });
});

describe('normalization', () => {
  test('re-aligns a table after replacing ages and addresses', () => {
    const ctx = newContext();
    const text = 'NAME   CLUSTER-IP      AGE\nweb    10.100.200.17   12s\nk      10.96.0.1       3m4s\n';
    expect(normalizeText(text, ctx, 'get')).toBe('NAME   CLUSTER-IP   AGE\nweb    <<ip>>       <<age>>\nk      10.96.0.1    <<age>>\n');
  });

  test('numbers UIDs and hashes by first appearance; suffixes and event names are unnumbered', () => {
    const ctx = newContext();
    const a = '3f1c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01';
    expect(normalizeValue(`uid: ${a}\nowner: ${a}\npod: web-7c5ddbdf54-x8k2p`, ctx)).toBe('uid: <<uid:1>>\nowner: <<uid:1>>\npod: web-<<hash:1>>-<<suffix>>');
    expect(normalizeValue('web-7c5ddbdf54-x8k2p.187a3b4c5d6e7f80 pod-template-hash=7c5ddbdf54', ctx)).toBe('web-<<hash:1>>-<<suffix>>.<<hex>> pod-template-hash=<<hash:1>>');
  });

  test('maps the oracle to the topology and leaves node addresses alone', () => {
    const ctx = newContext({ apiserverPort: 23456, hostname: 'work.station', workdir: '/tmp/simlab-golden-x' });
    expect(normalizeValue('https://127.0.0.1:23456 172.16.0.10:23456 work.station_x /tmp/simlab-golden-x/a.yaml 172.16.0.11', ctx)).toBe(
      'https://172.16.0.10:6443 172.16.0.10:6443 controlplane_x /home/student/a.yaml 172.16.0.11',
    );
  });

  test('a NodePort the case chose stays; an allocated one becomes a token', () => {
    const ctx = newContext({ literals: new Set(['30080']) });
    expect(normalizeValue('80:30080/TCP,80:31999/TCP', ctx)).toBe('80:30080/TCP,80:<<port>>/TCP');
    expect(normalizeJson({ nodePort: 31999, port: 80 }, ctx)).toEqual({ nodePort: '<<port>>', port: 80 });
  });

  test('klog headers and PEM bodies', () => {
    const ctx = newContext();
    expect(normalizeValue('E1115 20:18:03.214429  210912 memcache.go:381] "x"\n', ctx)).toBe('E<<time>> <<pid>> memcache.go:381] "x"\n');
    expect(normalizeJson({ 'ca.crt': '-----BEGIN CERTIFICATE-----\nMIIB\nhaIl\n-----END CERTIFICATE-----\n' }, ctx)).toEqual({
      'ca.crt': '-----BEGIN CERTIFICATE-----\n<<cert>>\n-----END CERTIFICATE-----\n',
    });
  });

  test('rows whose order hinged on a hidden suffix are sorted', () => {
    const ctx = newContext();
    const text = 'NAME           AGE\nweb-np-bz7wq   1s\nweb-x8k2p      1s\n';
    expect(normalizeText(text, ctx, 'get')).toBe('NAME                AGE\nweb-<<suffix>>      <<age>>\nweb-np-<<suffix>>   <<age>>\n');
  });
});

describe('case format', () => {
  test('rejects unknown keys and steps', () => {
    expect(() => parseCase('description: x\nsteps:\n  - run: kubectl get pods\n    colour: red\n', 'c')).toThrow(/unknown key "colour"/);
    expect(() => parseCase('description: x\nsteps:\n  - shell: ls\n', 'c')).toThrow(/expected one of/);
    expect(() => parseCase('description: x\nsetup:\n  - run: ls\nsteps:\n  - run: ls\n', 'c')).toThrow(/expected one of do, until, sleep/);
  });

  test('infers the table kind from the command', () => {
    expect(defaultTable('kubectl get pods')).toBe('get');
    expect(defaultTable('kubectl get pods -o wide')).toBe('get');
    expect(defaultTable('kubectl get pods -o yaml')).toBeUndefined();
    expect(defaultTable('kubectl get pods -oname')).toBeUndefined();
    expect(defaultTable('kubectl describe pod x')).toBe('describe');
    expect(defaultTable('kubectl get pods | head')).toBeUndefined();
  });

  test('every case parses and has a committed fixture, and every fixture has a case', () => {
    const cases = files(casesDir, '.yaml').map((f) => path.relative(casesDir, f));
    for (const c of cases) parseCase(readFileSync(path.join(casesDir, c), 'utf8'), c);
    const fixtures = files(fixturesDir, '.yaml').map((f) => path.relative(fixturesDir, f));
    expect(fixtures).toEqual(cases);
  });
});

describe('committed fixtures', () => {
  const fixtures = files(fixturesDir, '.yaml');

  test('carry no workstation detail', () => {
    for (const f of fixtures) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\/tmp\/|simlab-(?:golden|oracle)|127\.0\.0\.1:[0-9]/);
    }
  });

  test('re-aligned tables are stable: parsing and rendering them again changes nothing', () => {
    for (const f of fixtures) {
      const fx = parseYaml(readFileSync(f, 'utf8')) as { case?: string; steps: { run?: string; stdout?: string; exit?: number }[] };
      // The case's own `table` setting wins over the command's default, as in capture.
      const caseFile = fx.case === undefined ? undefined : path.join(casesDir, `${fx.case}.yaml`);
      const recorded = caseFile && statSync(caseFile, { throwIfNoEntry: false }) ? parseCase(readFileSync(caseFile, 'utf8'), fx.case as string).steps.filter((x) => 'run' in x || 'objects' in x || 'request' in x) : [];
      for (const [i, s] of fx.steps.entries()) {
        if (s.run === undefined || s.exit !== 0 || !s.stdout) continue;
        const step = recorded[i];
        const table = step && 'run' in step && step.run === s.run ? step.table : undefined;
        if (table === 'none') continue;
        const kind = table ?? defaultTable(s.run);
        if (!kind) continue;
        const p = kind === 'get' ? GET_TABLE : DESCRIBE;
        expect(parse(s.stdout, p), `${path.relative(fixturesDir, f)}: ${s.run}`).toBeDefined();
      }
    }
  });
});
