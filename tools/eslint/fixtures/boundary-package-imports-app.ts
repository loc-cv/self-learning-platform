// lint-as: packages/k8s/src/kubectl/main.ts
// expect: simlab/package-boundaries x2
import { packageName } from '@simlab/cli';
import { packageName as t } from '@simlab/tools';
export const x = [packageName, t];
