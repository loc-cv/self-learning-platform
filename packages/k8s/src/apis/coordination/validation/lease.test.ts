// Lease validation. Messages checked against the v1.37.2 oracle: `Lease.coordination.k8s.io
// "misc-l1" is invalid: [spec.leaseDurationSeconds: Invalid value: 0: must be greater than 0,
// spec.leaseTransitions: Invalid value: -1: must be greater than or equal to 0]`.

import { expect, test } from 'vitest';
import { aggregate } from '../../../apimachinery/field.ts';
import { validateLease, validateLeaseUpdate } from './lease.ts';

const lease = (spec: Record<string, number | string>) => ({ metadata: { name: 'l', namespace: 'default', resourceVersion: '1' }, spec });

test('duration must be positive, transitions non-negative', () => {
  expect(aggregate(validateLease(lease({ leaseDurationSeconds: 0, leaseTransitions: -1 })))).toBe(
    '[spec.leaseDurationSeconds: Invalid value: 0: must be greater than 0, spec.leaseTransitions: Invalid value: -1: must be greater than or equal to 0]',
  );
  expect(validateLease(lease({ holderIdentity: 'me', leaseDurationSeconds: 15, leaseTransitions: 0 }))).toEqual([]);
  expect(aggregate(validateLeaseUpdate(lease({ leaseDurationSeconds: -5 }), lease({})))).toBe('spec.leaseDurationSeconds: Invalid value: -5: must be greater than 0');
});
