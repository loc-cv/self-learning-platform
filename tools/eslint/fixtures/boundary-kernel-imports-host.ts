// lint-as: packages/kernel/src/world.ts
// expect: simlab/package-boundaries x1
import { packageName } from '@simlab/host';
export const x = packageName;
