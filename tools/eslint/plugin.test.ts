import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

// Each fixture is linted with the repository's real eslint.config.js, as if it lived at the
// path its `// lint-as:` header names. `// expect:` lists `<rule> x<count>` or `none`.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

interface Fixture {
  file: string;
  code: string;
  lintAs: string;
  expected: Record<string, number>;
}

function loadFixture(file: string): Fixture {
  const code = readFileSync(path.join(fixturesDir, file), 'utf8');
  const lintAs = /^\/\/ lint-as: (.+)$/m.exec(code)?.[1];
  const expectLine = /^\/\/ expect: (.+)$/m.exec(code)?.[1];
  if (lintAs === undefined || expectLine === undefined) {
    throw new Error(`${file}: missing "// lint-as:" or "// expect:" header`);
  }
  const expected: Record<string, number> = {};
  if (expectLine.trim() !== 'none') {
    for (const part of expectLine.split(',')) {
      const m = /^\s*(\S+) x(\d+)\s*$/.exec(part);
      if (m === null) throw new Error(`${file}: cannot parse expectation "${part}"`);
      expected[m[1] as string] = Number(m[2]);
    }
  }
  return { file, code, lintAs, expected };
}

const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map(loadFixture);

async function simlabFindings(f: Fixture): Promise<Record<string, number>> {
  const [result] = await eslint.lintText(f.code, { filePath: path.join(repoRoot, f.lintAs) });
  const counts: Record<string, number> = {};
  for (const m of result?.messages ?? []) {
    if (m.fatal === true) throw new Error(`${f.file}: ${m.message}`);
    if (m.ruleId?.startsWith('simlab/') === true) counts[m.ruleId] = (counts[m.ruleId] ?? 0) + 1;
  }
  return counts;
}

describe('lint guarantees fire on violating fixtures and stay quiet on clean ones', () => {
  test.each(fixtures.map((f) => [f.file, f] as const))('%s', async (_name, f) => {
    expect(await simlabFindings(f)).toEqual(f.expected);
  });

  test('both guarantees have violating and clean fixtures', () => {
    for (const rule of ['simlab/package-boundaries', 'simlab/engine-determinism']) {
      expect(fixtures.some((f) => (f.expected[rule] ?? 0) > 0)).toBe(true);
    }
    expect(fixtures.some((f) => Object.keys(f.expected).length === 0)).toBe(true);
  });
});
