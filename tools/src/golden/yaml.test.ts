// kubectl's YAML and JSON encoding and its manifest decoding (packages/k8s/src/apimachinery/yaml)
// against the committed golden fixtures, byte for byte:
//  - client/yaml-output: generator output with awkward strings; each -o yaml output parsed and
//    written again must be the same text, each -o json output too (typed objects: struct order);
//  - client/yaml-input: `kubectl label --local -f <file> l=v`, replayed as decode the file's
//    stream, set the label, print every object (or the decoding error kubectl prints);
//  - every other -o yaml / -o json output in the fixtures, parsed and written again, with the
//    normalization tokens swapped for values of the type they replaced.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, test } from 'vitest';
import type { Json } from '@simlab/kernel';
import { decodeManifestStream, marshalYaml, printJson, unmarshalYaml, YamlMarshalError } from '@simlab/k8s';
import { casesDir, fixturesDir } from '../oracle/paths.ts';

type JsonObject = { [key: string]: Json };

interface FixtureStep {
  run?: string;
  stdin?: string;
  exit?: number;
  stdout?: string;
  stderr?: string;
}

function fixture(rel: string): FixtureStep[] {
  return (parseYaml(readFileSync(path.join(fixturesDir, rel), 'utf8')) as { steps: FixtureStep[] }).steps;
}

function caseFiles(rel: string): Record<string, string> {
  return ((parseYaml(readFileSync(path.join(casesDir, rel), 'utf8')) as { files?: Record<string, string> }).files ?? {});
}

function output(run: string): 'yaml' | 'json' | undefined {
  const m = /(?:^|\s)(?:-o\s*|--output[= ])(yaml|json)(?:\s|$)/.exec(run);
  return m?.[1] as 'yaml' | 'json' | undefined;
}

function parseOne(text: string): Json {
  const r = unmarshalYaml(text);
  if (!r.ok) throw new Error('error' in r ? r.error : r.unsupported);
  return r.value;
}

describe('client/yaml-output: written again from what it parses to', () => {
  const steps = fixture('client/yaml-output.yaml');
  for (const [i, s] of steps.entries()) {
    const run = s.run as string;
    const fmt = output(run);
    if (s.exit !== 0 || !fmt) continue;
    test(`step ${i}: ${run.slice(0, 70)}`, () => {
      const stdout = s.stdout as string;
      if (fmt === 'yaml') expect(marshalYaml(parseOne(stdout))).toBe(stdout);
      else expect(printJson(decodeManifestStream(stdout).docs[0] as Json)).toBe(stdout);
    });
  }

  test('a DEL character fails the YAML printer (encoding/json leaves it raw, yaml.v2 rejects it)', () => {
    const s = steps.find((x) => x.run?.includes('configmap del ')) as FixtureStep;
    let message = '';
    try {
      marshalYaml({ apiVersion: 'v1', data: { del: 'a\x7fb' }, kind: 'ConfigMap', metadata: { name: 'del' } });
    } catch (e) {
      if (!(e instanceof YamlMarshalError)) throw e;
      message = e.message;
    }
    expect(`error: ${message}\n`).toBe(s.stderr);
  });

  test('NEL inside a string is folded by the JSON-to-YAML step', () => {
    const s = steps.find((x) => x.run?.includes('configmap nel ')) as FixtureStep;
    expect(marshalYaml({ apiVersion: 'v1', data: { nel: 'a\u0085b' }, kind: 'ConfigMap', metadata: { name: 'nel' } })).toBe(s.stdout);
  });
});

describe('client/yaml-input: kubectl label --local -f replayed', () => {
  const files = caseFiles('client/yaml-input.yaml');
  for (const [i, s] of fixture('client/yaml-input.yaml').entries()) {
    const run = s.run as string;
    const m = /^kubectl label --local -f (\S+) l=v -o (yaml|json)$/.exec(run);
    if (!m) continue;
    const [, file, fmt] = m as unknown as [string, string, 'yaml' | 'json'];
    test(`step ${i}: ${run}`, () => {
      const text = file === '-' ? (s.stdin as string) : (files[file] as string);
      const r = decodeManifestStream(text);
      expect(r.unsupported).toBeUndefined();
      const objects = r.docs.filter((d): d is JsonObject => d !== null && typeof d === 'object' && !Array.isArray(d));
      const printed = objects.map((o) => {
        const meta = (o.metadata ?? {}) as JsonObject;
        const labeled = { ...o, metadata: { ...meta, labels: { ...((meta.labels ?? {}) as JsonObject), l: 'v' } } };
        // label makes a printer per object, so YAMLPrinter's "---" between objects never shows.
        return fmt === 'yaml' ? marshalYaml(labeled) : printJson(labeled, { sortKeys: true });
      });
      expect(printed.join('')).toBe(s.stdout);
      const source = file === '-' ? 'STDIN' : file;
      expect(r.error === undefined ? '' : `error: error parsing ${source}: ${r.error}\n`).toBe(s.stderr);
    });
  }
});

// Values of the right type for each normalization token, so quoting and number formatting come
// out as they did for the real value; swapped back after writing.
const TOKENS: [RegExp, (n: string) => string][] = [
  [/<<time>>/g, () => '2099-01-02T03:04:05Z'],
  [/<<rv>>/g, () => '987654321'],
  [/<<port>>/g, () => '31999'],
  [/<<uid:(\d+)>>/g, (n) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`],
];

function tokensToValues(text: string): string {
  const typed = TOKENS.reduce((t, [re, f]) => t.replace(re, (_m, n: string) => f(n)), text);
  // The rest stand for plain strings (<<ip>>, <<suffix>>, <<hash:1>>…); JSON would escape the brackets.
  return typed.replace(/<<([a-z]+)(?::(\d+))?>>/g, (_m, name: string, n?: string) => `zztoken${name}${n === undefined ? '' : `x${n}`}zz`);
}

function valuesToTokens(text: string): string {
  return text
    .replace(/zztoken([a-z]+?)(?:x(\d+))?zz/g, (_m, name: string, n?: string) => `<<${name}${n === undefined ? '' : `:${n}`}>>`)
    .replace(/2099-01-02T03:04:05Z/g, '<<time>>')
    .replace(/987654321/g, '<<rv>>')
    .replace(/31999/g, '<<port>>')
    .replace(/00000000-0000-4000-8000-0*(\d+)/g, (_m, n: string) => `<<uid:${n}>>`);
}

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? fixtureFiles(p) : n.endsWith('.yaml') ? [p] : [];
    });
}

describe('every -o yaml and -o json output in the fixtures survives a parse and a write', () => {
  for (const file of fixtureFiles(fixturesDir)) {
    const rel = path.relative(fixturesDir, file);
    if (rel.startsWith('client/yaml-')) continue;
    for (const [i, s] of fixture(rel).entries()) {
      const fmt = s.run ? output(s.run) : undefined;
      if (!fmt || s.exit !== 0 || !s.stdout || /[|;&]/.test(s.run as string)) continue;
      test(`${rel} step ${i}: ${(s.run as string).slice(0, 60)}`, () => {
        const stdout = s.stdout as string;
        const text = tokensToValues(stdout);
        if (fmt === 'yaml') {
          // Several objects are separate documents (YAMLPrinter's "---").
          const r = decodeManifestStream(text);
          expect(r.error ?? r.unsupported).toBeUndefined();
          const again = r.docs.map((d, n) => `${n > 0 ? '---\n' : ''}${marshalYaml(d)}`).join('');
          expect(valuesToTokens(again)).toBe(stdout);
        } else {
          const r = decodeManifestStream(text);
          expect(r.error ?? r.unsupported).toBeUndefined();
          // kubectl get prints unstructured objects (sorted keys); generators print typed ones.
          const sortKeys = /^kubectl (get|apply|label|annotate|patch|edit|replace)\b/.test(s.run as string);
          expect(valuesToTokens(r.docs.map((d) => printJson(d, { sortKeys })).join(''))).toBe(stdout);
        }
      });
    }
  }
});

describe('configmaps/list-output: a broken second document', () => {
  test('the first object is printed, then the error of the second, its line counted from its own start', () => {
    const files = caseFiles('configmaps/list-output.yaml');
    const s = fixture('configmaps/list-output.yaml').find((x) => x.run === 'kubectl create -f bad.yaml --dry-run=client -o yaml') as FixtureStep;
    const r = decodeManifestStream(files['bad.yaml'] as string);
    expect(r.docs).toHaveLength(1);
    expect(`error: error parsing bad.yaml: ${r.error}\n`).toBe(s.stderr);
  });
});
