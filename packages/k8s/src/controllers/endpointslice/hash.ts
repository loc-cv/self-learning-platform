// The hashes the EndpointSlice and Endpoints controllers sort by. Only orderings need the exact
// hash (ports of a slice, ports and subsets of an Endpoints object); hashes used only as map keys
// (EndpointSet, RepackSubsets' address sets) are replaced by any injective key.
// upstream: staging/src/k8s.io/endpointslice/util/controller_utils.go deepHashObjectToString
// (fnv.New128a over dump.ForHash(obj), hex of Sum(nil)); Go src/hash/fnv/fnv.go (offset128,
// prime128; sum128a.Write xors each byte in, then multiplies by the prime mod 2^128; Sum appends
// the 16 bytes big-endian).

import type { Json, JsonObject } from '../../apimachinery/json.ts';
import { utf8 } from '../hash/govalue.ts';
import { forHash, type GoValue } from '../hash/spew.ts';

const OFFSET128 = 0x6c62272e07bb014262b821756295c58dn;
const PRIME128 = 0x0000000001000000000000000000013bn;
const MASK128 = (1n << 128n) - 1n;

/** fnv.New128a over `bytes`, Sum(nil) as lowercase hex (32 digits). */
export function fnv128aHex(bytes: readonly number[]): string {
  let h = OFFSET128;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * PRIME128) & MASK128;
  }
  return h.toString(16).padStart(32, '0');
}

/** deepHashObjectToString / hashObject: hex of fnv128a over dump.ForHash(v). */
export function deepHash(v: GoValue): string {
  return fnv128aHex(utf8(forHash(v)));
}

// GoValue builders for the few types hashed here.
export const goString = (v: string, t = 'string'): GoValue => ({ k: 'string', t, v });
export const goInt32 = (v: number): GoValue => ({ k: 'int', t: 'int32', v: BigInt(v) });
export const goPtr = (t: string, elem: GoValue | null): GoValue => ({ k: 'ptr', t, elem });
export const goStruct = (t: string, fields: [string, GoValue][]): GoValue => ({ k: 'struct', t, fields });

const optStr = (v: Json | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A discovery/v1 EndpointPort as stored or as built by the controller: every pointer field is set
 * exactly when the JSON has it (k8s.io/api/discovery/v1/types.go EndpointPort: Name *string,
 * Protocol *v1.Protocol, Port *int32, AppProtocol *string).
 */
export function discoveryEndpointPortValue(p: JsonObject): GoValue {
  const name = optStr(p.name);
  const protocol = optStr(p.protocol);
  const appProtocol = optStr(p.appProtocol);
  return goStruct('v1.EndpointPort', [
    ['Name', goPtr('*string', name === undefined ? null : goString(name))],
    ['Protocol', goPtr('*v1.Protocol', protocol === undefined ? null : goString(protocol, 'v1.Protocol'))],
    ['Port', goPtr('*int32', typeof p.port === 'number' ? goInt32(p.port) : null)],
    ['AppProtocol', goPtr('*string', appProtocol === undefined ? null : goString(appProtocol))],
  ]);
}
