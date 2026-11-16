// Upstream's strategic merge patch tests, run against the port: the tables of
// staging/src/k8s.io/apimachinery/pkg/util/strategicpatch/patch_test.go (copied verbatim into
// testdata/ by tools/src/strategicpatch/extract-tests.ts) with the harness of each Go test
// function (TestSortMergeLists, TestCustomStrategicMergePatch, TestStrategicMergePatch,
// TestReplaceWithRawExtension, TestUnknownField) and its MergeItem test type. Upstream runs each
// table against three lookups (Go struct tags, OpenAPI v2, OpenAPI v3); the API server uses the
// struct tags, so that is the one here.

import { describe, expect, test } from 'vitest';
import { parseTypeExpr, schema as apiSchema, type FieldSpec, type NamedType } from '../../openapi/schema.ts';
import type { Json, JsonObject } from '../json.ts';
import { unmarshalYaml } from '../yaml/decode.ts';
import { createThreeWayMergePatchUsing, createTwoWayMergePatchUsing, patchMetaFor, sortKeysDeep, strategicMergePatchUsing, type PatchResult } from './index.ts';
import { sortMergeListsByNameMap } from './patch.ts';
import { DATA, type RawTestCase } from './testdata/patch_test.data.ts';

// ---- the MergeItem type of patch_test.go ----

const field = (json: string, type: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ json, type: parseTypeExpr(type), omitempty: true, omitzero: false, required: false, ...extra });
const struct = (id: string, name: string, fields: FieldSpec[]): NamedType => ({
  id,
  display: `strategicpatch.${name}`,
  name,
  struct: { fields, byJson: Object.fromEntries(fields.map((f) => [f.json, f])) },
});

const TEST_TYPES: Record<string, NamedType> = {
  'test.MergeItem': struct('test.MergeItem', 'MergeItem', [
    field('name', 'string'),
    field('value', 'string'),
    field('other', 'string'),
    field('mergingList', '[]@test.MergeItem', { patchStrategy: 'merge', patchMergeKey: 'name' }),
    field('nonMergingList', '[]@test.MergeItem'),
    field('mergingIntList', '[]int', { patchStrategy: 'merge' }),
    field('nonMergingIntList', '[]int'),
    field('mergeItemPtr', '*@test.MergeItem', { patchStrategy: 'merge', patchMergeKey: 'name' }),
    field('simpleMap', 'map[string]string'),
    field('replacingItem', '@apimachinery/pkg/runtime.RawExtension', { patchStrategy: 'replace' }),
    field('jsonItem', '@test.jsonItem'),
    field('retainKeysMap', '@test.RetainKeysMergeItem', { patchStrategy: 'retainKeys' }),
    field('retainKeysMergingList', '[]@test.MergeItem', { patchStrategy: 'merge,retainKeys', patchMergeKey: 'name' }),
  ]),
  'test.RetainKeysMergeItem': struct('test.RetainKeysMergeItem', 'RetainKeysMergeItem', [
    field('name', 'string'),
    field('value', 'string'),
    field('other', 'string'),
    field('simpleMap', 'map[string]string'),
    field('mergingIntList', '[]int', { patchStrategy: 'merge' }),
    field('mergingList', '[]@test.MergeItem', { patchStrategy: 'merge', patchMergeKey: 'name' }),
    field('nonMergingList', '[]@test.MergeItem'),
  ]),
  // `JSONItem struct{ Raw []byte }`: an anonymous struct whose one field has no tag.
  'test.jsonItem': struct('test.jsonItem', '', [field('Raw', 'bytes')]),
};

const resolve = (id: string): NamedType => TEST_TYPES[id] ?? apiSchema().type(id);
const mergeItemStructSchema = patchMetaFor('test.MergeItem', resolve);

// ---- the harness ----

/** sigs.k8s.io/yaml.YAMLToJSON, then json.Unmarshal. */
function yamlToJson(text: string): Json {
  const r = unmarshalYaml(text);
  if (!r.ok) throw new Error('error' in r ? r.error : r.unsupported);
  return r.value;
}

/** json.Marshal: the bytes upstream's tests compare. */
const marshal = (v: Json | undefined): string => (v === undefined ? 'null' : JSON.stringify(sortKeysDeep(v)));

const sorted = (v: Json | undefined): JsonObject | undefined => (v === undefined || v === null ? undefined : sortMergeListsByNameMap(structuredClone(v) as JsonObject, mergeItemStructSchema));

const ok = (r: PatchResult): JsonObject => {
  if ('error' in r) throw new Error(r.error);
  return r.ok;
};

/** testPatchApplication */
function testPatchApplication(original: JsonObject | undefined, patch: JsonObject | undefined, expected: Json | undefined, expectedError = ''): void {
  const r = strategicMergePatchUsing(original ?? {}, patch ?? {}, mergeItemStructSchema);
  if (expectedError !== '') {
    expect('error' in r ? r.error : '(no error)').toContain(expectedError);
    return;
  }
  expect(marshal(ok(r))).toBe(marshal(expected));
}

interface Case {
  description: string;
  original?: JsonObject;
  twoWay?: JsonObject;
  modified?: JsonObject;
  current?: JsonObject;
  threeWay?: JsonObject;
  result?: JsonObject;
  twoWayResult?: JsonObject;
}

function testCases(yaml: string): Case[] {
  return (yamlToJson(yaml) as unknown as { testCases: Case[] }).testCases;
}

function testTwoWay(original: JsonObject | undefined, expectedPatch: JsonObject | undefined, modified: JsonObject | undefined, expectedResult: JsonObject | undefined, expectedError?: string): void {
  const actual = ok(createTwoWayMergePatchUsing(original ?? {}, modified ?? {}, mergeItemStructSchema));
  expect(marshal(actual)).toBe(marshal(expectedPatch));
  testPatchApplication(original, actual, expectedResult, expectedError);
}

/** testThreeWayPatch: a conflict is expected exactly when the description says so or there is no result. */
function testThreeWay(c: { description: string }, original: JsonObject | undefined, modified: JsonObject | undefined, current: JsonObject | undefined, expected: JsonObject | undefined, result: JsonObject | undefined, hasResult: boolean, expectedError?: string): void {
  const r = createThreeWayMergePatchUsing(original, modified ?? {}, current ?? {}, mergeItemStructSchema, false);
  if ('error' in r) {
    expect(r.sentinel, r.error).toBe('ErrConflict');
    expect(c.description).toContain('conflict');
    if (hasResult) {
      const forced = ok(createThreeWayMergePatchUsing(original, modified ?? {}, current ?? {}, mergeItemStructSchema, true));
      expect(marshal(forced)).toBe(marshal(expected));
      testPatchApplication(current, forced, result, expectedError);
    }
    return;
  }
  expect(c.description.includes('conflict') || !hasResult, 'expected conflict did not occur').toBe(false);
  expect(marshal(r.ok)).toBe(marshal(expected));
  testPatchApplication(current, r.ok, result, expectedError);
}

const raw = (text: string | undefined): JsonObject | undefined => {
  if (text === undefined) return undefined;
  const v = yamlToJson(text);
  return v === null ? undefined : (v as JsonObject);
};

// ---- the tests ----

describe('TestSortMergeLists', () => {
  const cases = (yamlToJson(DATA.sortMergeListTestCaseData) as { testCases: { description: string; original: JsonObject; sorted: JsonObject }[] }).testCases;
  test.each(cases.map((c) => [c.description, c] as const))('%s', (_, c) => {
    expect(marshal(sorted(c.original))).toBe(marshal(c.sorted));
  });
});

describe('TestCustomStrategicMergePatch', () => {
  test.each(testCases(DATA.customStrategicMergePatchTestCaseData).map((c) => [c.description, c] as const))('%s', (_, c) => {
    testPatchApplication(sorted(c.original), sorted(c.twoWay), sorted(c.twoWayResult ?? c.modified));
  });
  test.each(DATA.customStrategicMergePatchRawTestCases.map((c) => [c.description, c] as const))('raw: %s', (_, c: RawTestCase) => {
    testPatchApplication(raw(c.original), raw(c.twoWay), raw(c.twoWayResult ?? c.modified), c.expectedError);
  });
});

describe('TestStrategicMergePatch', () => {
  test('bad original, bad patch', () => {
    // StrategicMergePatch's ErrBadJSONDoc for bytes that are not JSON is the caller's: these
    // entry points take decoded values. The API server's own decoding errors are in pipeline tests.
    expect(strategicMergePatchUsing({}, {}, mergeItemStructSchema)).toEqual({ ok: {} });
  });
  for (const c of testCases(DATA.createStrategicMergePatchTestCaseData)) {
    test(`${c.description}/TwoWay`, () => {
      testTwoWay(sorted(c.original), sorted(c.twoWay), sorted(c.modified), sorted(c.twoWayResult ?? c.modified));
    });
    test(`${c.description}/ThreeWay`, () => {
      testThreeWay(c, sorted(c.original), sorted(c.modified), sorted(c.current), sorted(c.threeWay), sorted(c.result), c.result !== undefined && Object.keys(c.result).length > 0);
    });
  }
  for (const c of DATA.strategicMergePatchRawTestCases) {
    test(`raw: ${c.description}/TwoWay`, () => {
      testTwoWay(raw(c.original), raw(c.twoWay), raw(c.modified), raw(c.twoWayResult ?? c.modified), c.expectedError);
    });
    test(`raw: ${c.description}/ThreeWay`, () => {
      testThreeWay(c, raw(c.original), raw(c.modified), raw(c.current), raw(c.threeWay), raw(c.result), (c.result ?? '').length > 0, c.expectedError);
    });
  }
});

describe('TestReplaceWithRawExtension', () => {
  for (const c of DATA.replaceRawExtensionPatchTestCases) {
    test(`${c.description}/TwoWay`, () => {
      testTwoWay(raw(c.original), raw(c.twoWay), raw(c.modified), raw(c.twoWayResult ?? c.modified), c.expectedError);
    });
    test(`${c.description}/ThreeWay`, () => {
      testThreeWay(c, raw(c.original), raw(c.modified), raw(c.current), raw(c.threeWay), raw(c.result), (c.result ?? '').length > 0, c.expectedError);
    });
  }
});

describe('TestUnknownField', () => {
  const cases = Object.keys(DATA.unknownFieldTestCases).sort();
  test.each(cases)('%s', (k) => {
    const tc = DATA.unknownFieldTestCases[k] as Record<string, string>;
    const parse = (s: string): JsonObject => JSON.parse(s) as JsonObject;
    const twoWay = createTwoWayMergePatchUsing(parse(tc.Original as string), parse(tc.Modified as string), mergeItemStructSchema);
    if ('error' in twoWay) {
      expect(tc.ExpectedTwoWayErr ?? '', twoWay.error).not.toBe('');
      expect(twoWay.error).toContain(tc.ExpectedTwoWayErr);
    } else {
      expect(JSON.stringify(twoWay.ok)).toBe(tc.ExpectedTwoWay);
      expect(JSON.stringify(ok(strategicMergePatchUsing(parse(tc.Original as string), twoWay.ok, mergeItemStructSchema)))).toBe(tc.ExpectedTwoWayResult);
    }
    const threeWay = createThreeWayMergePatchUsing(parse(tc.Original as string), parse(tc.Modified as string), parse(tc.Current as string), mergeItemStructSchema, false);
    if ('error' in threeWay) {
      expect(tc.ExpectedThreeWayErr ?? '', threeWay.error).not.toBe('');
      expect(threeWay.error).toContain(tc.ExpectedThreeWayErr);
    } else {
      expect(JSON.stringify(threeWay.ok)).toBe(tc.ExpectedThreeWay);
      expect(JSON.stringify(ok(strategicMergePatchUsing(parse(tc.Current as string), threeWay.ok, mergeItemStructSchema)))).toBe(tc.ExpectedThreeWayResult);
    }
  });
});
