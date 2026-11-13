// The Kubernetes version pin. This is the only place the version is written in code; everything
// else (upstream fetch, oracle, per-version data directories) derives from it.
// Why this version, when it was checked and against which sources: docs/FIDELITY.md §1.
// Changing it is the procedure in prompts/R5-version-bump.md, never a one-line edit.

export const KUBERNETES_VERSION = '1.37.2';

/** Git tag in kubernetes/kubernetes and the release directory on dl.k8s.io. */
export const KUBERNETES_TAG = `v${KUBERNETES_VERSION}`;

/** `1.37` — the minor the CKA and CKAD exams are based on. */
export const KUBERNETES_MINOR = KUBERNETES_VERSION.split('.').slice(0, 2).join('.');
