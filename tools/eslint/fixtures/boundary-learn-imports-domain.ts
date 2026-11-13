// lint-as: packages/learn/src/checks.ts
// expect: simlab/package-boundaries x3
import { packageName } from '@simlab/k8s';
import type { packageName as H } from '@simlab/host';
export type T = typeof H;
export const load = () => import('@simlab/k8s');
export const x = packageName;
