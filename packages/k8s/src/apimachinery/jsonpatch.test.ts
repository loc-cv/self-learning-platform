import { describe, expect, test } from 'vitest';
import { goJson, type Json } from './json.ts';
import { applyJsonPatch, decodeJsonPatch } from './jsonpatch.ts';

type Want = { ok: string } | { error: string } | { decodeError: string } | { panic: string };

/** DecodePatch then Apply, shaped like the Go harness's answer; `ok` is Go's json.Marshal text, so key order counts. */
function run(doc: Json, body: Json): Want {
  const d = decodeJsonPatch(body);
  if ('error' in d) return { decodeError: d.error };
  const r = applyJsonPatch(doc, d.ops);
  return 'ok' in r ? { ok: goJson(r.ok) } : r;
}

// Every expectation here is the real library's answer: gopkg.in/evanphx/json-patch.v4 v4.13.0's
// patch.go and errors.go, copied from .upstream/kubernetes/vendor and run with go1.27.4 built with
// GOEXPERIMENT=nojsonv2, i.e. encoding/json v1 as in the pin's go1.26.10 (the kube-apiserver
// binary links encoding/json/decode.go, not v2). Each row went through DecodePatch, then Apply,
// with panics recovered and printed. upstream's patch_test.go is not in the checkout.
const cases: [string, Json, Json, Want][] = [
  ['decode object', {}, { op: 'add' }, { decodeError: 'json: cannot unmarshal object into Go value of type jsonpatch.Patch' }],
  ['decode string', {}, 'x', { decodeError: 'json: cannot unmarshal string into Go value of type jsonpatch.Patch' }],
  ['decode number', {}, 5, { decodeError: 'json: cannot unmarshal number into Go value of type jsonpatch.Patch' }],
  ['decode bool', {}, true, { decodeError: 'json: cannot unmarshal bool into Go value of type jsonpatch.Patch' }],
  ['decode null', { b: 1, a: 2 }, null, { ok: '{"a":2,"b":1}' }],
  ['decode elem array', {}, [['x']], { decodeError: 'json: cannot unmarshal array into Go value of type jsonpatch.Operation' }],
  ['decode elem string then number', {}, [{ op: 'add' }, 's', 5], { decodeError: 'json: cannot unmarshal string into Go value of type jsonpatch.Operation' }],
  ['decode elem number', {}, [1.5], { decodeError: 'json: cannot unmarshal number into Go value of type jsonpatch.Operation' }],
  ['null op', {}, [null], { error: 'Unexpected kind: unknown' }],
  ['empty', { b: { z: 1, y: 2 }, a: 2 }, [], { ok: '{"a":2,"b":{"z":1,"y":2}}' }],
  ['unknown op', {}, [{ op: 'frob', path: '/a' }], { error: 'Unexpected kind: frob' }],
  ['op number', {}, [{ op: 5, path: '/a' }], { error: 'Unexpected kind: unknown' }],
  ['op missing', {}, [{ path: '/a' }], { error: 'Unexpected kind: unknown' }],
  ['add', { b: { z: 1, y: 2 }, a: 2 }, [{ op: 'add', path: '/c', value: { q: 1, p: 2 } }], { ok: '{"a":2,"b":{"z":1,"y":2},"c":{"q":1,"p":2}}' }],
  ['add nested parses', { b: { z: 1, y: { k: 1, j: 2 } }, a: 2 }, [{ op: 'add', path: '/b/x', value: 1 }], { ok: '{"a":2,"b":{"x":1,"y":{"k":1,"j":2},"z":1}}' }],
  ['add no path', {}, [{ op: 'add', value: 1 }], { error: 'add operation failed to decode path: missing value' }],
  ['add path number', {}, [{ op: 'add', path: 5, value: 1 }], { error: 'add operation failed to decode path: missing value' }],
  ['add path empty', {}, [{ op: 'add', path: '', value: 1 }], { error: 'add operation does not apply: doc is missing path: "": missing value' }],
  ['add path no slash', {}, [{ op: 'add', path: 'a', value: 1 }], { error: 'add operation does not apply: doc is missing path: "a": missing value' }],
  ['add path x/b', {}, [{ op: 'add', path: 'x/b', value: 1 }], { ok: '{"b":1}' }],
  ['add missing parent', {}, [{ op: 'add', path: '/a/b', value: 1 }], { error: 'add operation does not apply: doc is missing path: "/a/b": missing value' }],
  ['add through null', { a: null }, [{ op: 'add', path: '/a/b', value: 1 }], { error: 'add operation does not apply: doc is missing path: "/a/b": missing value' }],
  ['add through scalar', { a: 's' }, [{ op: 'add', path: '/a/b', value: 1 }], { error: 'add operation does not apply: doc is missing path: "/a/b": missing value' }],
  ['add no value', {}, [{ op: 'add', path: '/a' }], { ok: '{"a":null}' }],
  ['add null value', {}, [{ op: 'add', path: '/a', value: null }], { ok: '{"a":null}' }],
  ['add array idx', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/1', value: 9 }], { ok: '{"a":[1,9,2,3]}' }],
  ['add array len', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/3', value: 9 }], { ok: '{"a":[1,2,3,9]}' }],
  ['add array len+1', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/4', value: 9 }], { error: 'error in add for path: \'/a/4\': Unable to access invalid index: 4: invalid index referenced' }],
  ['add array dash', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/-', value: 9 }], { ok: '{"a":[1,2,3,9]}' }],
  ['add array -1', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/-1', value: 9 }], { ok: '{"a":[1,2,3,9]}' }],
  ['add array -4', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/-4', value: 9 }], { ok: '{"a":[9,1,2,3]}' }],
  ['add array -5', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/-5', value: 9 }], { error: 'error in add for path: \'/a/-5\': Unable to access invalid index: -5: invalid index referenced' }],
  ['add array x', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/x', value: 9 }], { error: 'error in add for path: \'/a/x\': value was not a proper array index: \'x\': strconv.Atoi: parsing "x": invalid syntax' }],
  ['add array +1 007', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/+1', value: 8 }, { op: 'add', path: '/a/007', value: 9 }], { error: 'error in add for path: \'/a/007\': Unable to access invalid index: 7: invalid index referenced' }],
  ['add array huge', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/99999999999999999999', value: 9 }], { error: 'error in add for path: \'/a/99999999999999999999\': value was not a proper array index: \'99999999999999999999\': strconv.Atoi: parsing "99999999999999999999": value out of range' }],
  ['add array huge x', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/99999999999999999999x', value: 9 }], { error: 'error in add for path: \'/a/99999999999999999999x\': value was not a proper array index: \'99999999999999999999x\': strconv.Atoi: parsing "99999999999999999999x": value out of range' }],
  ['add array int64 over', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/9223372036854775808', value: 9 }], { error: 'error in add for path: \'/a/9223372036854775808\': value was not a proper array index: \'9223372036854775808\': strconv.Atoi: parsing "9223372036854775808": value out of range' }],
  ['add array int64 max', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/9223372036854775807', value: 9 }], { error: 'error in add for path: \'/a/9223372036854775807\': Unable to access invalid index: 9223372036854775807: invalid index referenced' }],
  ['add array quote', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/a"b\n', value: 9 }], { error: 'error in add for path: \'/a/a"b\n\': value was not a proper array index: \'a"b\n\': strconv.Atoi: parsing "a\\"b\\n": invalid syntax' }],
  ['add array empty key', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/', value: 9 }], { error: 'error in add for path: \'/a/\': value was not a proper array index: \'\': strconv.Atoi: parsing "": invalid syntax' }],
  ['add array minus', { a: [1, 2, 3] }, [{ op: 'add', path: '/a/--1', value: 9 }], { error: 'error in add for path: \'/a/--1\': value was not a proper array index: \'--1\': strconv.Atoi: parsing "--1": invalid syntax' }],
  ['add escape', { 'a/b': {}, 'm~n': 1 }, [{ op: 'add', path: '/a~1b/c~0d', value: 1 }, { op: 'add', path: '/~01', value: 2 }], { ok: '{"a/b":{"c~d":1},"m~n":1,"~1":2}' }],
  ['add root array', [1, 2], [{ op: 'add', path: '/0', value: { b: 1, a: 2 } }], { ok: '[{"b":1,"a":2},1,2]' }],
  ['add into array elem obj', { a: [{ z: 1, y: 2 }, { z: 1, y: 2 }] }, [{ op: 'add', path: '/a/0/x', value: 1 }], { ok: '{"a":[{"x":1,"y":2,"z":1},{"z":1,"y":2}]}' }],
  ['add through array -1', { a: [{ z: 1 }, { y: 2 }] }, [{ op: 'add', path: '/a/-1/x', value: 1 }], { ok: '{"a":[{"z":1},{"x":1,"y":2}]}' }],
  ['add through array dash', { a: [{ z: 1 }, { y: 2 }] }, [{ op: 'add', path: '/a/-/x', value: 1 }], { error: 'add operation does not apply: doc is missing path: "/a/-/x": missing value' }],
  ['add slash key', { a: 1 }, [{ op: 'add', path: '/', value: 2 }], { ok: '{"":2,"a":1}' }],
  ['remove', { b: { z: 1, y: 2 }, a: 2 }, [{ op: 'remove', path: '/a' }], { ok: '{"b":{"z":1,"y":2}}' }],
  ['remove missing', { a: 2 }, [{ op: 'remove', path: '/x' }], { error: 'error in remove for path: \'/x\': Unable to remove nonexistent key: x: missing value' }],
  ['remove missing parent', { a: 2 }, [{ op: 'remove', path: '/x/y' }], { error: 'remove operation does not apply: doc is missing path: "/x/y": missing value' }],
  ['remove null key', { a: null, b: 1 }, [{ op: 'remove', path: '/a' }], { ok: '{"b":1}' }],
  ['remove no path', { a: 2 }, [{ op: 'remove' }], { error: 'remove operation failed to decode path: missing value' }],
  ['remove root', { a: 2 }, [{ op: 'remove', path: '' }], { error: 'remove operation does not apply: doc is missing path: "": missing value' }],
  ['remove arr', { a: [1, 2, 3] }, [{ op: 'remove', path: '/a/1' }], { ok: '{"a":[1,3]}' }],
  ['remove arr -1', { a: [1, 2, 3] }, [{ op: 'remove', path: '/a/-1' }], { ok: '{"a":[1,2]}' }],
  ['remove arr 3', { a: [1, 2, 3] }, [{ op: 'remove', path: '/a/3' }], { error: 'error in remove for path: \'/a/3\': Unable to access invalid index: 3: invalid index referenced' }],
  ['remove arr -4', { a: [1, 2, 3] }, [{ op: 'remove', path: '/a/-4' }], { error: 'error in remove for path: \'/a/-4\': Unable to access invalid index: -4: invalid index referenced' }],
  ['remove arr dash', { a: [1, 2, 3] }, [{ op: 'remove', path: '/a/-' }], { error: 'error in remove for path: \'/a/-\': strconv.Atoi: parsing "-": invalid syntax' }],
  ['replace', { b: { z: 1, y: 2 }, a: 2 }, [{ op: 'replace', path: '/a', value: { z: 1, y: 2 } }], { ok: '{"a":{"z":1,"y":2},"b":{"z":1,"y":2}}' }],
  ['replace missing key', { a: 2 }, [{ op: 'replace', path: '/x', value: 1 }], { ok: '{"a":2,"x":1}' }],
  ['replace missing parent', { a: 2 }, [{ op: 'replace', path: '/x/y', value: 1 }], { error: 'replace operation does not apply: doc is missing path: /x/y: missing value' }],
  ['replace no path', { a: 2 }, [{ op: 'replace', value: 1 }], { error: 'replace operation failed to decode path: operation missing path field: missing value' }],
  ['replace path number', { a: 2 }, [{ op: 'replace', path: [1], value: 1 }], { error: 'replace operation failed to decode path: json: cannot unmarshal array into Go value of type string' }],
  ['replace no value', { a: 2 }, [{ op: 'replace', path: '/a' }], { ok: '{"a":null}' }],
  ['replace root obj', { a: 2 }, [{ op: 'replace', path: '', value: { z: { k: 1, j: 2 }, y: 2 } }], { ok: '{"y":2,"z":{"k":1,"j":2}}' }],
  ['replace root arr', { a: 2 }, [{ op: 'replace', path: '', value: [{ k: 1, j: 2 }] }], { ok: '[{"k":1,"j":2}]' }],
  ['replace root scalar', { a: 2 }, [{ op: 'replace', path: '', value: 5 }], { error: 'replace operation value must be object or array: %!w(<nil>)' }],
  ['replace root null', { a: 2 }, [{ op: 'replace', path: '', value: null }], { error: 'replace operation value must be object or array: %!w(<nil>)' }],
  ['replace root novalue', { a: 2 }, [{ op: 'replace', path: '' }], { panic: 'runtime error: invalid memory address or nil pointer dereference' }],
  ['replace arr', { a: [1, 2, 3] }, [{ op: 'replace', path: '/a/-1', value: 9 }], { ok: '{"a":[1,2,9]}' }],
  ['replace arr 3', { a: [1, 2, 3] }, [{ op: 'replace', path: '/a/3', value: 9 }], { error: 'replace operation does not apply: doc is missing key: /a/3: missing value' }],
  ['replace arr -4', { a: [1, 2, 3] }, [{ op: 'replace', path: '/a/-4', value: 9 }], { error: 'replace operation does not apply: doc is missing key: /a/-4: missing value' }],
  ['replace arr dash', { a: [1, 2, 3] }, [{ op: 'replace', path: '/a/-', value: 9 }], { error: 'replace operation does not apply: doc is missing key: /a/-: missing value' }],
  ['move', { b: { z: 1, y: 2 }, a: { k: 1, j: 2 } }, [{ op: 'move', from: '/a', path: '/b/a' }], { ok: '{"b":{"a":{"k":1,"j":2},"y":2,"z":1}}' }],
  ['move no from', { a: 1 }, [{ op: 'move', path: '/b' }], { error: 'move operation failed to decode from: operation, missing from field: missing value' }],
  ['move from number', { a: 1 }, [{ op: 'move', from: true, path: '/b' }], { error: 'move operation failed to decode from: json: cannot unmarshal bool into Go value of type string' }],
  ['move missing from parent', { a: 1 }, [{ op: 'move', from: '/x/y', path: '/b' }], { error: 'move operation does not apply: doc is missing from path: /x/y: missing value' }],
  ['move missing from key', { a: 1 }, [{ op: 'move', from: '/x~1y', path: '/b' }], { error: 'error in move for path: \'x/y\': Unable to remove nonexistent key: x/y: missing value' }],
  ['move from null', { a: null }, [{ op: 'move', from: '/a', path: '/b' }], { ok: '{"b":null}' }],
  ['move no path', { a: 1 }, [{ op: 'move', from: '/a' }], { error: 'move operation failed to decode path: operation missing path field: missing value' }],
  ['move to child', { a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/c' }], { error: 'move operation does not apply: doc is missing destination path: /a/c: missing value' }],
  ['move missing dest', { a: 1 }, [{ op: 'move', from: '/a', path: '/x/y' }], { error: 'move operation does not apply: doc is missing destination path: /x/y: missing value' }],
  ['move arr bad idx', { a: [1] }, [{ op: 'move', from: '/a/5', path: '/b' }], { error: 'error in move for path: \'5\': Unable to access invalid index: 5: invalid index referenced' }],
  ['move arr x', { a: [1] }, [{ op: 'move', from: '/a/x', path: '/b' }], { error: 'error in move for path: \'x\': strconv.Atoi: parsing "x": invalid syntax' }],
  ['move dest bad idx', { a: [1], b: 1 }, [{ op: 'move', from: '/b', path: '/a/5' }], { error: 'error in move for path: \'/a/5\': Unable to access invalid index: 5: invalid index referenced' }],
  ['move within arr', { a: [1, 2, 3] }, [{ op: 'move', from: '/a/0', path: '/a/-' }], { ok: '{"a":[2,3,1]}' }],
  ['copy', { b: { z: 1, y: 2 }, a: { k: 1, j: { q: 1, p: 2 } } }, [{ op: 'copy', from: '/a', path: '/c' }], { ok: '{"a":{"k":1,"j":{"q":1,"p":2}},"b":{"z":1,"y":2},"c":{"k":1,"j":{"q":1,"p":2}}}' }],
  ['copy deep', { a: { k: 1 } }, [{ op: 'copy', from: '/a', path: '/c' }, { op: 'add', path: '/c/x', value: 1 }], { ok: '{"a":{"k":1},"c":{"k":1,"x":1}}' }],
  ['copy parsed', { a: { k: 1, j: { q: 1, p: 2 } } }, [{ op: 'add', path: '/a/x', value: { n: 1, m: 2 } }, { op: 'copy', from: '/a', path: '/c' }], { ok: '{"a":{"j":{"q":1,"p":2},"k":1,"x":{"n":1,"m":2}},"c":{"j":{"q":1,"p":2},"k":1,"x":{"n":1,"m":2}}}' }],
  ['copy missing from', { a: 1 }, [{ op: 'copy', from: '/x', path: '/c' }], { ok: '{"a":1,"c":null}' }],
  ['copy missing from parent', { a: 1 }, [{ op: 'copy', from: '/x/y', path: '/c' }], { error: 'copy operation does not apply: doc is missing from path: /x/y: missing value' }],
  ['copy no from', { a: 1 }, [{ op: 'copy', path: '/c' }], { error: 'copy operation failed to decode from: operation, missing from field: missing value' }],
  ['copy no path', { a: 1 }, [{ op: 'copy', from: '/a' }], { error: 'copy operation failed to decode path: missing value' }],
  ['copy path number', { a: 1 }, [{ op: 'copy', from: '/a', path: 1 }], { error: 'copy operation failed to decode path: missing value' }],
  ['copy missing dest', { a: 1 }, [{ op: 'copy', from: '/a', path: '/x/y' }], { error: 'copy operation does not apply: doc is missing destination path: /x/y: missing value' }],
  ['copy arr from bad', { a: [1] }, [{ op: 'copy', from: '/a/3', path: '/b' }], { error: 'error in copy for from: \'/a/3\': Unable to access invalid index: 3: invalid index referenced' }],
  ['copy dest bad', { a: [1] }, [{ op: 'copy', from: '/a/0', path: '/a/3' }], { error: 'error while adding value during copy: Unable to access invalid index: 3: invalid index referenced' }],
  ['copy added null then add', {}, [{ op: 'add', path: '/a', value: null }, { op: 'copy', from: '/a', path: '/c' }, { op: 'add', path: '/c/x', value: 1 }], { panic: 'assignment to entry in nil map' }],
  ['copy added null then test obj', {}, [{ op: 'add', path: '/a', value: null }, { op: 'copy', from: '/a', path: '/c' }, { op: 'test', path: '/c', value: {} }], { ok: '{"a":null,"c":null}' }],
  ['copy added null then test null', {}, [{ op: 'add', path: '/a', value: null }, { op: 'copy', from: '/a', path: '/c' }, { op: 'test', path: '/c', value: null }], { error: 'testing value /c failed: test failed' }],
  ['test ok', { b: { z: 1, y: { k: 1, j: 2 } }, a: [{ n: 1, m: 2 }] }, [{ op: 'test', path: '/b', value: { y: { j: 2, k: 1 }, z: 1 } }, { op: 'test', path: '/a', value: [{ m: 2, n: 1 }] }], { ok: '{"a":[{"m":2,"n":1}],"b":{"y":{"j":2,"k":1},"z":1}}' }],
  ['test fail', { a: 1 }, [{ op: 'test', path: '/a', value: 2 }], { error: 'testing value /a failed: test failed' }],
  ['test str', { a: 'x' }, [{ op: 'test', path: '/a', value: 'x' }], { ok: '{"a":"x"}' }],
  ['test missing key null', { a: 1 }, [{ op: 'test', path: '/x', value: null }], { ok: '{"a":1}' }],
  ['test missing key novalue', { a: 1 }, [{ op: 'test', path: '/x' }], { ok: '{"a":1}' }],
  ['test missing key value', { a: 1 }, [{ op: 'test', path: '/x', value: 1 }], { error: 'testing value /x failed: test failed' }],
  ['test null null', { a: null }, [{ op: 'test', path: '/a', value: null }], { ok: '{"a":null}' }],
  ['test val novalue', { a: 1 }, [{ op: 'test', path: '/a' }], { error: 'testing value /a failed: test failed' }],
  ['test val null', { a: 1 }, [{ op: 'test', path: '/a', value: null }], { error: 'testing value /a failed: test failed' }],
  ['test obj null', { a: {} }, [{ op: 'test', path: '/a', value: null }], { error: 'testing value /a failed: test failed' }],
  ['test added null novalue', {}, [{ op: 'add', path: '/a', value: null }, { op: 'test', path: '/a' }], { error: 'testing value /a failed: test failed' }],
  ['test added null null', {}, [{ op: 'add', path: '/a', value: null }, { op: 'test', path: '/a', value: null }], { ok: '{"a":null}' }],
  ['test missing parent', { a: 1 }, [{ op: 'test', path: '/x/y', value: 1 }], { error: 'test operation does not apply: is missing path: /x/y: missing value' }],
  ['test arr bad', { a: [1] }, [{ op: 'test', path: '/a/4', value: 1 }], { error: 'error in test for path: \'/a/4\': Unable to access invalid index: 4: invalid index referenced' }],
  ['test no path', { a: 1 }, [{ op: 'test', value: 1 }], { error: 'test operation failed to decode path: operation missing path field: missing value' }],
  ['test root ok', { b: { z: 1 }, a: 1 }, [{ op: 'test', path: '', value: { a: 1, b: { z: 1 } } }], { ok: '{"a":1,"b":{"z":1}}' }],
  ['test root fail', { a: 1 }, [{ op: 'test', path: '', value: { a: 2 } }], { error: 'testing value  failed: test failed' }],
  ['test root null', { a: 1 }, [{ op: 'test', path: '', value: null }], { error: 'testing value  failed: test failed' }],
  ['test root novalue', { a: 1 }, [{ op: 'test', path: '' }], { panic: 'runtime error: invalid memory address or nil pointer dereference' }],
  ['test arr with null', { a: [1, null] }, [{ op: 'test', path: '/a', value: [1, null] }], { panic: 'runtime error: invalid memory address or nil pointer dereference' }],
  ['test arr null mismatch first', { a: [1, null] }, [{ op: 'test', path: '/a', value: [2, null] }], { error: 'testing value /a failed: test failed' }],
  ['test arr val null', { a: [1, 2] }, [{ op: 'test', path: '/a', value: [1, null] }], { panic: 'runtime error: invalid memory address or nil pointer dereference' }],
  ['test obj nested null', { a: { x: null } }, [{ op: 'test', path: '/a', value: { x: null } }], { ok: '{"a":{"x":null}}' }],
  ['test obj nested null vs val', { a: { x: null } }, [{ op: 'test', path: '/a', value: { x: 1 } }], { error: 'testing value /a failed: test failed' }],
  ['test obj vs arr', { a: {} }, [{ op: 'test', path: '/a', value: [] }], { error: 'testing value /a failed: test failed' }],
  ['test arr vs obj', { a: [] }, [{ op: 'test', path: '/a', value: {} }], { error: 'testing value /a failed: test failed' }],
  ['test scalar vs obj', { a: 1 }, [{ op: 'test', path: '/a', value: {} }], { error: 'testing value /a failed: test failed' }],
  ['test obj sorts', { a: { z: { k: 1, j: 2 }, y: [{ q: 1, p: 2 }] }, b: { z: 1, y: 2 } }, [{ op: 'test', path: '/a', value: { y: [{ q: 1, p: 2 }], z: { k: 1, j: 2 } } }], { ok: '{"a":{"y":[{"p":2,"q":1}],"z":{"j":2,"k":1}},"b":{"z":1,"y":2}}' }],
  ['test root sorts', { a: { z: { k: 1, j: 2 } }, b: { z: 1, y: 2 } }, [{ op: 'test', path: '', value: { a: { z: { k: 1, j: 2 } }, b: { z: 1, y: 2 } } }], { ok: '{"a":{"z":{"j":2,"k":1}},"b":{"y":2,"z":1}}' }],
  ['doc null', null, [{ op: 'remove', path: '/a' }], { error: 'error in remove for path: \'/a\': Unable to remove nonexistent key: a: missing value' }],
  ['doc null add', null, [{ op: 'add', path: '/a', value: 1 }], { panic: 'assignment to entry in nil map' }],
  ['doc null empty', null, [], { ok: 'null' }],
  ['doc string', 's', [], { error: 'json: cannot unmarshal string into Go value of type jsonpatch.partialDoc' }],
  ['doc number', 5, [], { error: 'json: cannot unmarshal number into Go value of type jsonpatch.partialDoc' }],
  ['multi stop', { a: 1 }, [{ op: 'add', path: '/b', value: 1 }, { op: 'frob' }, { op: 'add', path: '/c', value: 1 }], { error: 'Unexpected kind: frob' }],
  ['inserted raw kept', { a: 1 }, [{ op: 'add', path: '/c', value: { z: { k: 1, j: 2 }, y: 2 } }, { op: 'add', path: '/c/z/x', value: 1 }], { ok: '{"a":1,"c":{"y":2,"z":{"j":2,"k":1,"x":1}}}' }],
  ['array elems raw', { a: [{ z: 1, y: 2 }] }, [{ op: 'add', path: '/a/-', value: { z: 1, y: 2 } }], { ok: '{"a":[{"z":1,"y":2},{"z":1,"y":2}]}' }],
  ['root arr raw', [{ z: 1, y: 2 }], [], { ok: '[{"z":1,"y":2}]' }],
  ['add root array nil slice', {}, [{ op: 'add', path: '/a', value: null }, { op: 'copy', from: '/a', path: '/c' }, { op: 'remove', path: '/c/x' }], { error: 'error in remove for path: \'/c/x\': Unable to remove nonexistent key: x: missing value' }],
  ['test missing via arr', { a: [1] }, [{ op: 'test', path: '/a/x', value: 1 }], { error: 'error in test for path: \'/a/x\': strconv.Atoi: parsing "x": invalid syntax' }],
  ['replace through nil map', {}, [{ op: 'add', path: '/a', value: null }, { op: 'copy', from: '/a', path: '/c' }, { op: 'replace', path: '/c/x', value: 1 }], { panic: 'assignment to entry in nil map' }],
  ['html chars', { a: '<&>' }, [{ op: 'add', path: '/b', value: '<x>' }], { ok: '{"a":"\\u003c\\u0026\\u003e","b":"\\u003cx\\u003e"}' }],
];

describe('json-patch v4 against the real library', () => {
  test.each(cases)('%s', (_name, doc, body, want) => {
    expect(run(doc, body)).toEqual(want);
  });
});

describe('semantics', () => {
  test('pointer escaping: ~1 is /, ~0 is ~, in one pass', () => {
    expect(run({ 'a/b': {}, 'm~n': 1 }, [{ op: 'add', path: '/a~1b/c~0d', value: 1 }, { op: 'add', path: '/~01', value: 2 }])).toEqual({
      ok: '{"a/b":{"c~d":1},"m~n":1,"~1":2}',
    });
  });

  test('negative indices count from the end; for add, -1 appends', () => {
    expect(run({ a: [1, 2, 3] }, [{ op: 'add', path: '/a/-1', value: 9 }])).toEqual({ ok: '{"a":[1,2,3,9]}' });
    expect(run({ a: [1, 2, 3] }, [{ op: 'remove', path: '/a/-1' }])).toEqual({ ok: '{"a":[1,2]}' });
    expect(run({ a: [1, 2, 3] }, [{ op: 'replace', path: '/a/-3', value: 0 }])).toEqual({ ok: '{"a":[0,2,3]}' });
  });

  test('copy is deep: changing the copy leaves the source alone', () => {
    expect(run({ a: { k: [1] } }, [{ op: 'copy', from: '/a', path: '/c' }, { op: 'add', path: '/c/k/-', value: 2 }])).toEqual({
      ok: '{"a":{"k":[1]},"c":{"k":[1,2]}}',
    });
  });

  test('the inputs are not modified', () => {
    const doc = Object.freeze({ a: Object.freeze([1, 2]), b: Object.freeze({ z: 1, y: 2 }) }) as unknown as Json;
    const body: Json = [{ op: 'remove', path: '/a/0' }, { op: 'add', path: '/b/x', value: 0 }, { op: 'move', from: '/b', path: '/c' }];
    const d = decodeJsonPatch(body);
    if ('error' in d) throw new Error(d.error);
    expect(applyJsonPatch(doc, d.ops)).toEqual({ ok: { a: [2], c: { x: 0, y: 2, z: 1 } } });
    expect(doc).toEqual({ a: [1, 2], b: { z: 1, y: 2 } });
  });

  test('a null body is a nil Patch, a null element a nil Operation', () => {
    expect(decodeJsonPatch(null)).toEqual({ ops: [] });
    expect(decodeJsonPatch([null])).toEqual({ ops: [{}] });
  });

  test('scalars compare by value, not by their spelling (Go compares bytes: 1.0 is not 1)', () => {
    // Go: "testing value /a failed: test failed" for a body spelled `"value":1.0`. The body
    // reaches the port parsed, so the spelling is gone; see Numbers in jsonpatch.ts.
    expect(run({ a: 1 }, JSON.parse('[{"op":"test","path":"/a","value":1.0}]') as Json)).toEqual({ ok: '{"a":1}' });
  });
});

describe('key order', () => {
  test('the root object is sorted; untouched subtrees and inserted values keep their order', () => {
    expect(run({ b: { z: 1, y: 2 }, a: 2 }, [{ op: 'add', path: '/c', value: { q: 1, p: 2 } }])).toEqual({ ok: '{"a":2,"b":{"z":1,"y":2},"c":{"q":1,"p":2}}' });
  });

  test('an empty patch still re-marshals the root', () => {
    expect(run({ b: { z: 1, y: 2 }, a: 2 }, [])).toEqual({ ok: '{"a":2,"b":{"z":1,"y":2}}' });
  });

  test('objects a pointer passes through come out sorted, their untouched children do not', () => {
    expect(run({ b: { z: 1, y: { k: 1, j: 2 } }, a: 2 }, [{ op: 'add', path: '/b/x', value: 1 }])).toEqual({ ok: '{"a":2,"b":{"x":1,"y":{"k":1,"j":2},"z":1}}' });
  });

  test('a passing test sorts every object it compared on the document side', () => {
    expect(run({ a: { z: { k: 1, j: 2 }, y: [{ q: 1, p: 2 }] }, b: { z: 1, y: 2 } }, [{ op: 'test', path: '/a', value: { y: [{ q: 1, p: 2 }], z: { k: 1, j: 2 } } }])).toEqual({
      ok: '{"a":{"y":[{"p":2,"q":1}],"z":{"j":2,"k":1}},"b":{"z":1,"y":2}}',
    });
  });

  test('a copy keeps the source as it serializes at that moment', () => {
    expect(run({ a: { k: 1, j: { q: 1, p: 2 } } }, [{ op: 'add', path: '/a/x', value: { n: 1, m: 2 } }, { op: 'copy', from: '/a', path: '/c' }])).toEqual({
      ok: '{"a":{"j":{"q":1,"p":2},"k":1,"x":{"n":1,"m":2}},"c":{"j":{"q":1,"p":2},"k":1,"x":{"n":1,"m":2}}}',
    });
  });

  test('a whole-document replace sorts the new top level only; a root array keeps its elements', () => {
    expect(run({ a: 2 }, [{ op: 'replace', path: '', value: { z: { k: 1, j: 2 }, y: 2 } }])).toEqual({ ok: '{"y":2,"z":{"k":1,"j":2}}' });
    expect(run([{ z: 1, y: 2 }], [])).toEqual({ ok: '[{"z":1,"y":2}]' });
  });
});
