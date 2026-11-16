// The unstructured converter's errors and unknown fields (runtime/converter.go fromUnstructured),
// which a strategic merge patch shows (`patch: Invalid value: "map[…]": <error>`). The int32 one
// is in fixtures/golden/v1.37.2/api/strategic-patch.yaml (step 10), the unknown-field order in
// step 11; the others follow the converter's code paths.

import { describe, expect, test } from 'vitest';
import { fromUnstructured } from './converter.ts';
import type { JsonObject } from './json.ts';

const DEPLOYMENT = 'apps/v1.Deployment';
const err = (u: JsonObject, type = DEPLOYMENT) => fromUnstructured(u, type, true).error;

describe('fromUnstructured', () => {
  test('type errors', () => {
    expect(err({ spec: { replicas: 'three' } })).toBe('unrecognized type: int32');
    expect(err({ spec: { replicas: 1.5 } })).toBe('cannot convert float64 to int32');
    expect(err({ metadata: { name: 5 } })).toBe('cannot convert int64 to string');
    expect(err({ metadata: { name: true } })).toBe('unrecognized type: string');
    expect(err({ spec: { paused: 'yes' } })).toBe('unrecognized type: bool');
    expect(err({ spec: 'x' })).toBe('cannot restore struct from: string');
    expect(err({ metadata: { labels: [] } })).toBe('cannot restore map from slice');
    expect(err({ metadata: { finalizers: 'x' } })).toBe('cannot restore slice from string');
    // A defined type is named by its own type.
    expect(err({ spec: { template: { spec: { restartPolicy: 5 } } } })).toBe('cannot convert int64 to v1.RestartPolicy');
    // Types with their own UnmarshalJSON give its errors.
    expect(err({ metadata: { creationTimestamp: 5 } })).toBe('json: cannot unmarshal number into Go value of type string');
    expect(err({ data: { a: '!!' } }, 'core/v1.Secret')).toBe('error decoding from json: illegal base64 data at input byte 0');
  });

  test('unknown fields: sorted, indices in brackets, map keys left out of the path', () => {
    const r = fromUnstructured(
      { spec: { replicaz: 2, template: { spec: { containers: [{ name: 'a' }, { name: 'b', imagePullPolice: 'Always' }] } } }, zzz: 1, metadata: { annotations: { a: 'b' } } },
      DEPLOYMENT,
      true,
    );
    expect(r.unknown).toEqual(['unknown field "spec.replicaz"', 'unknown field "spec.template.spec.containers[1].imagePullPolice"', 'unknown field "zzz"']);
    expect(fromUnstructured({ zzz: 1 }, DEPLOYMENT, false).unknown).toEqual([]);
  });

  test('integers convert with Go wrapping; nulls stay zero', () => {
    const r = fromUnstructured({ spec: { replicas: 2 ** 32 + 3, selector: null } }, DEPLOYMENT, true);
    expect(r.value).toEqual({ spec: { replicas: 3, selector: null } });
  });
});
