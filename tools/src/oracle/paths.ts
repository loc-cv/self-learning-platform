// Locations shared by the oracle and golden capture tools.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KUBERNETES_TAG } from '@simlab/k8s';

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Where running control planes are recorded (git-ignored): one `<oracle directory name>.json` per
 * oracle, so concurrent oracles (other sessions, golden capture's jobs) never share a file.
 */
export const oracleStateDir = path.join(repoRoot, '.upstream', 'oracle');

/** Golden cases (inputs, version-independent) and fixtures (outputs, one directory per version). */
export const casesDir = path.join(repoRoot, 'fixtures', 'golden', 'cases');
export const fixturesDir = path.join(repoRoot, 'fixtures', 'golden', KUBERNETES_TAG);
