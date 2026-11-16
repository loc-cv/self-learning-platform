// The last-applied-configuration annotation as kubectl writes it.
//   fixtures/golden/v1.37.2/apply/three-way.yaml (the nulls manifest), create/from-files.yaml (--save-config)

import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../../apimachinery/json.ts';
import { createApplyAnnotation, createOrUpdateAnnotation, LAST_APPLIED, modifiedConfiguration, pruneNulls } from './apply.ts';

const nulls = (): JsonObject => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nulls', namespace: 'default', labels: { a: null } }, data: { x: '1', true: null } });

describe('last-applied-configuration', () => {
  test('the create path: annotation with the nulls, then the nulls pruned (three-way.yaml step 19)', () => {
    const obj = nulls();
    createApplyAnnotation(obj);
    pruneNulls(obj);
    expect(obj).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'nulls',
        namespace: 'default',
        labels: {},
        annotations: {
          [LAST_APPLIED]: '{"apiVersion":"v1","data":{"true":null,"x":"1"},"kind":"ConfigMap","metadata":{"annotations":{},"labels":{"a":null},"name":"nulls","namespace":"default"}}\n',
        },
      },
      data: { x: '1' },
    });
  });

  test('GetModifiedConfiguration embeds the first encoding and leaves an empty annotation behind', () => {
    const obj: JsonObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a' } };
    const modified = modifiedConfiguration(obj, true);
    expect(modified).toBe(
      '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\\"apiVersion\\":\\"v1\\",\\"kind\\":\\"ConfigMap\\",\\"metadata\\":{\\"annotations\\":{},\\"name\\":\\"a\\"}}\\n"},"name":"a"}}\n',
    );
    expect(obj.metadata).toEqual({ name: 'a', annotations: { [LAST_APPLIED]: '' } });
  });

  test('create without --save-config refreshes an annotation the manifest carries, and adds none', () => {
    const plain: JsonObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a' } };
    createOrUpdateAnnotation(false, plain);
    expect(plain.metadata).toEqual({ name: 'a' });
    const carried: JsonObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'a', annotations: { [LAST_APPLIED]: 'stale' } } };
    createOrUpdateAnnotation(false, carried);
    expect(carried.metadata).toEqual({ name: 'a', annotations: { [LAST_APPLIED]: '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"annotations":{},"name":"a"}}\n' } });
  });
});
