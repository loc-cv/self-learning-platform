// The pod-template-hash: the suffix of a Deployment's ReplicaSet names and the
// `pod-template-hash` label its ReplicaSets and Pods carry.
// upstream: pkg/controller/controller_utils.go ComputeHash: fnv.New32a over
// hashutil.DeepHashObject(hasher, *template), then, with a collision count, 8 bytes
// (binary.LittleEndian.PutUint32 into make([]byte, 8): the count, then four zero bytes), and
// rand.SafeEncodeString(fmt.Sprint(hasher.Sum32())). pkg/util/hash/hash.go DeepHashObject:
// fmt.Fprintf(hasher, "%v", dump.ForHash(object)), the formatter of spew.ts.

import type { JsonObject } from '../../apimachinery/json.ts';
import { forHash } from './spew.ts';
import { goValueOf, utf8 } from './govalue.ts';
import { NAME_ALPHABET } from '../../apimachinery/rand.ts';

/** dump.ForHash of a v1.PodTemplateSpec given as its stored JSON. */
export function podTemplateForHash(template: JsonObject): string {
  return forHash(goValueOf('core/v1.PodTemplateSpec', template));
}

/** ComputeHash(template, collisionCount) for a template as the API server stores it (v1 JSON). */
export function computeHash(template: JsonObject, collisionCount?: number): string {
  const bytes = utf8(podTemplateForHash(template));
  if (collisionCount !== undefined) {
    const c = collisionCount >>> 0; // uint32(*collisionCount)
    bytes.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff, 0, 0, 0, 0);
  }
  return safeEncodeString(String(fnv32a(bytes)));
}

// upstream: Go src/hash/fnv/fnv.go: offset32 = 2166136261, prime32 = 16777619; sum32a.Write
// xors each byte in, then multiplies by the prime (mod 2^32).
export function fnv32a(bytes: readonly number[]): number {
  let h = 2166136261;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// upstream: staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go SafeEncodeString: each rune of s
// becomes alphanums[int(rune) % len(alphanums)], alphanums = "bcdfghjklmnpqrstvwxz2456789".
const ALPHANUMS = NAME_ALPHABET;
export function safeEncodeString(s: string): string {
  let out = '';
  for (const ch of s) out += ALPHANUMS[(ch.codePointAt(0) as number) % ALPHANUMS.length];
  return out;
}
