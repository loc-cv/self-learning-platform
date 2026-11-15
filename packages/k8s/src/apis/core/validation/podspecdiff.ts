// The diff that follows "pod updates may not change fields other than …".
// upstream: pkg/apis/core/validation/validation.go ValidatePodUpdate (diff.Diff(oldPod.Spec,
// mungedPodSpec)); staging/src/k8s.io/apimachinery/pkg/util/diff/diff.go Diff (json.MarshalIndent of
// the internal core.PodSpec with a one-space indent, then a go-difflib unified diff with 3 lines of
// context).
//
// Not reproduced yet: it needs the whole internal PodSpec layout (pkg/apis/core/types.go, Go field
// names, embedded structs inlined) and go-difflib's SequenceMatcher. Until then the message ends
// after its first line, a registered divergence.

import type { JsonObject } from '../../../apimachinery/json.ts';

/** The unified diff of two versioned PodSpecs as upstream prints it, or undefined when not simulated. */
export function podSpecDiff(oldSpec: JsonObject, newSpec: JsonObject): string | undefined {
  void oldSpec;
  void newSpec;
  return undefined;
}
