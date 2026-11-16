// What the differential runner (runner.ts) may find different without failing.
//
// KNOWN: compared steps whose difference is understood and accepted, each naming its cause — an
// entry of the divergence register (docs/FIDELITY.md §5), an oracle limit (§6.5, §6.9) or a
// temporary shortcut recorded in STATUS.md with the phase that removes it. A KNOWN step that
// passes fails the test, so the register stays honest.
//
// PENDING: differences caused by work in progress in this phase (the simulated kubectl, its
// printers and encoders). Reported, never failing; the entries are removed as the work lands. A
// PENDING step that passes is reported as stale.
//
// A step is named by its case and its index in the case's `steps`, or by its command text when
// that is unique in the case.

export interface Entry {
  case: string;
  step: number | string;
  reason: string;
}

export interface KnownEntry extends Entry {
  /** DIV-0xx, `FIDELITY §6.5` (KWOK), or `STATUS: <shortcut>` with the phase that removes it. */
  cause: string;
}

const ROOT_CA = 'STATUS: No root-ca-certificate-publisher (phase 20a, or 16a)';

export const KNOWN: KnownEntry[] = [
  { case: 'configmaps/create-and-read', step: 0, cause: ROOT_CA, reason: 'the table lacks the kube-root-ca.crt row' },
  { case: 'configmaps/create-and-read', step: 3, cause: ROOT_CA, reason: 'the table lacks the kube-root-ca.crt row' },
  { case: 'configmaps/create-and-read', step: 8, cause: ROOT_CA, reason: 'configmap/kube-root-ca.crt is not found' },
  { case: 'configmaps/list-output', step: 5, cause: 'DIV-015', reason: '--show-managed-fields shows no managedFields' },
  {
    case: 'scheduling/preemption',
    step: 0,
    cause: 'STATUS: Default admission plugins other than NamespaceLifecycle are missing (phase 20b)',
    reason: 'the Priority admission plugin forbids a Pod that sets preemptionPolicy while naming a PriorityClass; without it the Pod is created',
  },
  ...[2, 3, 4].map((step) => ({
    case: 'apply/overwrite',
    step,
    cause: 'DIV-015',
    reason: "the three-way merge conflict prints the live object, whose managedFields are missing here (and whose resourceVersion, inside the JSON, the normalizer leaves as captured); the conflict and the rest of the text are the same",
  })),
  {
    case: 'controllers/gc-orphan-foreground',
    step: 8,
    cause: 'FIDELITY §6.5',
    reason:
      'status.terminatingReplicas of the Deployment and ReplicaSet: 1 on the oracle, 0 here. KWOK never stops a deleted Pod held by a finalizer, so it stays terminating; a kubelet stops its containers and makes it terminal (PodCompleted), and a terminal Pod is not counted (pkg/controller/controller_utils.go FilterTerminatingPods)',
  },
];

export const PENDING: Entry[] = [];

/** The entry for a step of a case, if any. */
export function entryFor<T extends Entry>(list: readonly T[], caseName: string, index: number, label: string): T | undefined {
  return list.find((e) => e.case === caseName && (e.step === index || e.step === label));
}
