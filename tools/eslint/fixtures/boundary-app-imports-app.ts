// lint-as: apps/web/src/main.ts
// expect: simlab/package-boundaries x1
import { packageName } from '@simlab/server';
export const x = packageName;
