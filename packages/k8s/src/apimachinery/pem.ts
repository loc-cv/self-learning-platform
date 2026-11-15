// PEM blocks and the PEM stage of tls.X509KeyPair, for the warnings on kubernetes.io/tls Secrets.
// upstream: Go src/encoding/pem/pem.go Decode (getLine, removeSpacesAndTabs);
// src/crypto/tls/tls.go X509KeyPair (the block scanning and its error messages). Bytes are
// binary strings (one char per byte), as in base64.ts.

import { decodeBase64 } from './base64.ts';

export interface PemBlock {
  type: string;
  bytes: string;
}

/** getLine: the line without its \n (and \r), right-trimmed of spaces and tabs. */
function getLine(data: string): { line: string; rest: string; consumed: number } {
  let i = data.indexOf('\n');
  let j: number;
  if (i < 0) {
    i = data.length;
    j = i;
  } else {
    j = i + 1;
    if (i > 0 && data[i - 1] === '\r') i--;
  }
  return { line: data.slice(0, i).replace(/[ \t]+$/, ''), rest: data.slice(j), consumed: j };
}

const PEM_START = '\n-----BEGIN ';
const PEM_END = '\n-----END ';
const PEM_EOL = '-----';

/** pem.Decode: the next block and the rest, or undefined. */
export function pemDecode(data: string): { block: PemBlock; rest: string } | undefined {
  let rest = data;
  let endTrailerIndex = 0;
  for (;;) {
    if (endTrailerIndex < 0 || endTrailerIndex > rest.length) return undefined;
    rest = rest.slice(endTrailerIndex);
    let endIndex = rest.indexOf(PEM_END);
    if (endIndex < 0) return undefined;
    endTrailerIndex = endIndex + PEM_END.length;
    const beginIndex = rest.slice(0, endIndex).lastIndexOf(PEM_START.slice(1));
    if (beginIndex < 0 || (beginIndex > 0 && rest[beginIndex - 1] !== '\n')) continue;
    const skip = beginIndex + PEM_START.length - 1;
    rest = rest.slice(skip);
    endIndex -= skip;
    endTrailerIndex -= skip;
    const t = getLine(rest);
    let typeLine = t.line;
    rest = t.rest;
    endIndex -= t.consumed;
    endTrailerIndex -= t.consumed;
    if (!typeLine.endsWith(PEM_EOL)) continue;
    typeLine = typeLine.slice(0, typeLine.length - PEM_EOL.length);
    let headers = 0;
    let truncated = false;
    for (;;) {
      if (rest.length === 0) {
        truncated = true;
        break;
      }
      const l = getLine(rest);
      const colon = l.line.indexOf(':');
      if (colon < 0) break;
      headers++;
      rest = l.rest;
      endIndex -= l.consumed;
      endTrailerIndex -= l.consumed;
    }
    if (truncated) return undefined;
    if (headers > 0 && endIndex < 0) continue;
    let endTrailer = rest.slice(endTrailerIndex);
    const endTrailerLen = typeLine.length + PEM_EOL.length;
    if (endTrailer.length < endTrailerLen) continue;
    const restOfEndLine = endTrailer.slice(endTrailerLen);
    endTrailer = endTrailer.slice(0, endTrailerLen);
    if (!endTrailer.startsWith(typeLine) || !endTrailer.endsWith(PEM_EOL)) continue;
    if (getLine(restOfEndLine).line.length !== 0) continue;
    let bytes = '';
    if (endIndex > 0) {
      const decoded = decodeBase64(rest.slice(0, endIndex).replace(/[ \t]/g, ''));
      if (decoded === undefined) continue;
      bytes = decoded;
    }
    return { block: { type: typeLine, bytes }, rest: getLine(rest.slice(endIndex + PEM_END.length - 1)).rest };
  }
}

/** Go's %v of a []string: `[a b]`. */
const goList = (xs: readonly string[]): string => `[${xs.join(' ')}]`;

/**
 * The PEM stage of tls.X509KeyPair: its error, or `{ cert, key }` with the DER of the first
 * certificate and of the key when both inputs hold the blocks it looks for.
 */
export function x509KeyPairPem(certPEM: string, keyPEM: string): { error: string } | { cert: string; key: string } {
  const certs: string[] = [];
  let skipped: string[] = [];
  let rest = certPEM;
  for (;;) {
    const d = pemDecode(rest);
    if (!d) break;
    rest = d.rest;
    if (d.block.type === 'CERTIFICATE') certs.push(d.block.bytes);
    else skipped.push(d.block.type);
  }
  if (certs.length === 0) {
    if (skipped.length === 0) return { error: 'tls: failed to find any PEM data in certificate input' };
    if (skipped.length === 1 && (skipped[0] as string).endsWith('PRIVATE KEY')) {
      return { error: 'tls: failed to find certificate PEM data in certificate input, but did find a private key; PEM inputs may have been switched' };
    }
    return { error: `tls: failed to find "CERTIFICATE" PEM block in certificate input after skipping PEM blocks of the following types: ${goList(skipped)}` };
  }
  skipped = [];
  rest = keyPEM;
  for (;;) {
    const d = pemDecode(rest);
    if (!d) {
      if (skipped.length === 0) return { error: 'tls: failed to find any PEM data in key input' };
      if (skipped.length === 1 && skipped[0] === 'CERTIFICATE') return { error: 'tls: found a certificate rather than a key in the PEM for the private key' };
      return { error: `tls: failed to find PEM block with type ending in "PRIVATE KEY" in key input after skipping PEM blocks of the following types: ${goList(skipped)}` };
    }
    rest = d.rest;
    if (d.block.type === 'PRIVATE KEY' || d.block.type.endsWith(' PRIVATE KEY')) return { cert: certs[0] as string, key: d.block.bytes };
    skipped.push(d.block.type);
  }
}
