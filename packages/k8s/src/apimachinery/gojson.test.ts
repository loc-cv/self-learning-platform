import { describe, expect, test } from 'vitest';
import { base64Error, canonical, decode } from './gojson.ts';
import { parseTime, formatTime, formatMicroTime } from './time.ts';

describe('decode: type errors as encoding/json reports them', () => {
  // Messages from fixtures/golden/v1.37.2/api/validation.yaml.
  test.each([
    ['apps/v1.Deployment', { spec: { replicas: 'three' } }, 'json: cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of type int32'],
    ['apps/v1.Deployment', { spec: { replicas: 1.5 } }, 'json: cannot unmarshal number 1.5 into Go struct field DeploymentSpec.spec.replicas of type int32'],
    ['core/v1.Pod', { spec: { containers: [{ name: 'a', ports: [{ containerPort: '80' }] }] } }, 'json: cannot unmarshal string into Go struct field ContainerPort.spec.containers.ports.containerPort of type int32'],
    ['core/v1.Pod', { spec: { containers: [{ image: { repo: 'x' } }] } }, 'json: cannot unmarshal object into Go struct field Container.spec.containers.image of type string'],
    ['core/v1.Pod', { spec: { containers: {} } }, 'json: cannot unmarshal object into Go struct field PodSpec.spec.containers of type []v1.Container'],
    ['core/v1.Pod', { metadata: { labels: { a: 1 } } }, 'json: cannot unmarshal number into Go struct field ObjectMeta.metadata.labels of type string'],
    ['core/v1.Pod', { spec: { containers: [{ tty: 'yes' }] } }, 'json: cannot unmarshal string into Go struct field Container.spec.containers.tty of type bool'],
    ['core/v1.Pod', { spec: 'none' }, 'json: cannot unmarshal string into Go struct field Pod.spec of type v1.PodSpec'],
    ['core/v1.Pod', { spec: { containers: [{ ports: [{ containerPort: 99999999999 }] }] } }, 'json: cannot unmarshal number 99999999999 into Go struct field ContainerPort.spec.containers.ports.containerPort of type int32'],
    ['core/v1.Pod', { spec: { restartPolicy: 5 } }, 'json: cannot unmarshal number into Go struct field PodSpec.spec.restartPolicy of type v1.RestartPolicy'],
  ])('%s %j', (type, body, error) => {
    expect(decode(body, type).error).toBe(error);
  });

  test('the first type error wins and decoding goes on; unknown fields are not reported then', () => {
    const r = decode({ spec: { replicas: 'x', minReadySeconds: 'y', bogus: 1 } }, 'apps/v1.Deployment');
    expect(r.error).toContain('DeploymentSpec.spec.replicas');
    expect(r.unknown).toEqual([]);
  });

  test('a custom unmarshaller error aborts with its own message', () => {
    expect(decode({ spec: { containers: [{ resources: { limits: { cpu: 'lots' } } }] } }, 'core/v1.Pod').error).toBe(
      "quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'",
    );
    expect(decode({ spec: { ports: [{ targetPort: true }] } }, 'core/v1.Service').error).toBe('json: cannot unmarshal bool into Go value of type int32');
  });

  test('unknown fields in document order, with indices; field names are case-sensitive', () => {
    const r = decode({ spec: { containers: [{ name: 'a', imagePullPolice: 'Always', Image: 'x' }], restartPolicyy: 'Never' }, Spec: {} }, 'core/v1.Pod');
    expect(r.unknown).toEqual(['spec.containers[0].imagePullPolice', 'spec.containers[0].Image', 'spec.restartPolicyy', 'Spec']);
  });

  test('base64 in []byte fields is checked like Go\'s StdEncoding', () => {
    expect(decode({ data: { a: 'YWRtaW4' } }, 'core/v1.Secret').error).toBe('illegal base64 data at input byte 4');
    expect(base64Error('YWRtaW4=')).toBeUndefined();
    expect(base64Error('YW*t')).toBe('illegal base64 data at input byte 2');
    expect(base64Error('YQ==YQ==')).toBe('illegal base64 data at input byte 4');
  });
});

describe('encode: what encoding/json writes back', () => {
  test('non-omitempty fields appear with zero values; omitempty zero values do not', () => {
    const out = canonical({ spec: { containers: [{ name: 'app', image: 'x', stdin: false }] } }, 'core/v1.Pod') as Record<string, unknown>;
    expect(out).toEqual({ metadata: {}, spec: { containers: [{ name: 'app', image: 'x', resources: {} }] }, status: {} });
  });

  test('a nil slice without omitempty is null; a non-pointer metav1.Time is null when zero', () => {
    expect(canonical({ addressType: 'IPv4' }, 'discovery/v1.EndpointSlice')).toEqual({ metadata: {}, addressType: 'IPv4', endpoints: null, ports: null });
    expect(canonical({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }, 'core/v1.Pod')).toMatchObject({
      status: { conditions: [{ type: 'Ready', status: 'True', lastProbeTime: null, lastTransitionTime: null }] },
    });
  });

  test('struct fields in Go order, map keys sorted', () => {
    const out = canonical({ data: { b: '2', a: '1' }, metadata: { name: 'x' }, kind: 'ConfigMap', apiVersion: 'v1' }, 'core/v1.ConfigMap') as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['kind', 'apiVersion', 'metadata', 'data']);
    expect(Object.keys(out.data as object)).toEqual(['a', 'b']);
  });

  test('omitzero drops a zero creationTimestamp', () => {
    expect(canonical({ metadata: { name: 'x', creationTimestamp: null } }, 'core/v1.ConfigMap')).toEqual({ metadata: { name: 'x' } });
  });

  test('times are re-encoded in UTC at second precision; microtimes keep six digits', () => {
    expect(decode({ metadata: { creationTimestamp: '2026-11-13T16:00:00.123+07:00' } }, 'core/v1.ConfigMap').value).toEqual({ metadata: { creationTimestamp: '2026-11-13T09:00:00Z' } });
    const t = parseTime('2026-11-13T09:00:00.5Z', false);
    expect('micros' in t && formatMicroTime(t.micros)).toBe('2026-11-13T09:00:00.500000Z');
    expect('micros' in t && formatTime(t.micros)).toBe('2026-11-13T09:00:00Z');
    expect(parseTime('yesterday', false)).toEqual({ error: 'parsing time "yesterday" as "2006-01-02T15:04:05Z07:00": cannot parse "yesterday" as "2006"' });
    expect(parseTime('2026-13-01T00:00:00Z', false)).toEqual({ error: 'parsing time "2026-13-01T00:00:00Z": month out of range' });
  });

  test('quantities are canonicalized', () => {
    expect(canonical(decode({ spec: { containers: [{ name: 'a', resources: { limits: { cpu: '0.5', memory: '1024Mi' } } }] } }, 'core/v1.Pod').value ?? null, 'core/v1.Pod')).toMatchObject({
      spec: { containers: [{ resources: { limits: { cpu: '500m', memory: '1Gi' } } }] },
    });
  });
});
