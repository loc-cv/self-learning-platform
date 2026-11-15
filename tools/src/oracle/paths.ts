// Locations shared by the oracle and golden capture tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KUBERNETES_TAG } from '@simlab/k8s';

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Where `npm run oracle -- up` records the running control plane (git-ignored). */
export const oracleStateFile = path.join(repoRoot, '.upstream', 'oracle', 'state.json');

/** Golden cases (inputs, version-independent) and fixtures (outputs, one directory per version). */
export const casesDir = path.join(repoRoot, 'fixtures', 'golden', 'cases');
export const fixturesDir = path.join(repoRoot, 'fixtures', 'golden', KUBERNETES_TAG);
