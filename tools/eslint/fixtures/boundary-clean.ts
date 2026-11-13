// lint-as: packages/k8s/src/kubectl/get.ts
// expect: none
import { packageName as kernel } from '@simlab/kernel';
import { packageName as host } from '@simlab/host';
import { KUBERNETES_VERSION } from '../version.ts';
export const x = [kernel, host, KUBERNETES_VERSION];
