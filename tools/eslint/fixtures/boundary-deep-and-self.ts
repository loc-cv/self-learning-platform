// lint-as: packages/k8s/src/store/store.ts
// expect: simlab/package-boundaries x2
import { packageName } from '@simlab/kernel/src/index.ts';
import { KUBERNETES_VERSION } from '@simlab/k8s';
export const x = [packageName, KUBERNETES_VERSION];
