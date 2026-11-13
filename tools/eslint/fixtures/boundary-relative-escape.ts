// lint-as: packages/k8s/src/kubelet/kubelet.ts
// expect: simlab/package-boundaries x2
import { packageName } from '../../../host/src/index.ts';
export * from '../../../../apps/cli/src/index.ts';
export const x = packageName;
