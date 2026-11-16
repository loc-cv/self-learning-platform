// The version and discovery documents against the real server's: every GET of
// fixtures/golden/v1.37.2/api/discovery.yaml and GET /version of info/version.yaml.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Json, JsonObject } from '../apimachinery/json.ts';
import { DEFAULT_APISERVER } from './config.ts';
import { getNonResource } from './nonresource.ts';

function fixture(name: string): JsonObject {
  const text = readFileSync(new URL(`../../../../fixtures/golden/v1.37.2/${name}`, import.meta.url), 'utf8');
  // Fixtures are YAML 1.2 (tools/src/golden/capture.ts writes them with the yaml package).
  return parseYaml(text) as JsonObject;
}

function requests(name: string): { request: string; response: Json }[] {
  const steps = fixture(name).steps as JsonObject[];
  return steps.filter((s) => typeof s.request === 'string').map((s) => ({ request: s.request as string, response: s.response as Json }));
}

describe('discovery documents', () => {
  for (const { request, response } of requests('api/discovery.yaml')) {
    test(request, () => {
      const r = getNonResource(DEFAULT_APISERVER, request.slice('GET '.length));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.object).toStrictEqual(response);
    });
  }
});

describe('/version', () => {
  test('equals the server version but for the normalized build date', () => {
    const [step] = requests('info/version.yaml');
    const r = getNonResource(DEFAULT_APISERVER, '/version');
    expect(r.ok).toBe(true);
    if (!r.ok || !step) return;
    expect({ ...(r.object as JsonObject), buildDate: '<<time>>' }).toStrictEqual(step.response);
  });

  test('another path is a notice', () => {
    const r = getNonResource(DEFAULT_APISERVER, '/healthz');
    expect(r.ok).toBe(false);
    expect('notSimulated' in r && r.notSimulated).toBe('the request GET /healthz');
  });
});
