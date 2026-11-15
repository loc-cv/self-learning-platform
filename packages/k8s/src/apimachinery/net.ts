// IP address and CIDR parsing as the API server does it, for validation.
// Two parsers, as upstream has two:
// - the "sloppy" one of k8s.io/utils/net (ParseIPSloppy, ParseCIDRSloppy: a fork of Go 1.17's
//   net.ParseIP/ParseCIDR that still accepts leading zeros in IPv4 octets and prefix lengths;
//   k8s.io/utils/internal/third_party/forked/golang/net/ip.go, not in the checkout — its
//   behavior is Go's net/ip.go of that release: dtoi/xtoi, parseIPv4, parseIPv6);
// - the strict one of Go's net/netip (ParseAddr, ParsePrefix; Go src/net/netip/netip.go).
// Only acceptance and the parsed bytes matter here: the messages a learner sees come from
// staging/src/k8s.io/apimachinery/pkg/util/validation/ip.go (validation/ip.ts).
// Formatting follows Go's net.IP.String / netip.Addr.String (RFC 5952 for IPv6).

/** A net.IP: 4 or 16 bytes. */
export type IP = number[];

/** A net.IPNet as ParseCIDR returns it: the masked network address and the prefix length. */
export interface IPNet {
  ip: IP;
  /** Prefix length (the mask's ones). */
  ones: number;
  /** Mask length in bits: 32 or 128. */
  bits: number;
}

const BIG = 0xffffff;
const V4_IN_V6_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Go's dtoi: decimal digits at the start of s, leading zeros allowed. */
function dtoi(s: string): { n: number; i: number; ok: boolean } {
  let n = 0;
  let i = 0;
  for (; i < s.length && isDigit(s[i] as string); i++) {
    n = n * 10 + (s.charCodeAt(i) - 48);
    if (n >= BIG) return { n: BIG, i, ok: false };
  }
  if (i === 0) return { n: 0, i: 0, ok: false };
  return { n, i, ok: true };
}

/** Go's xtoi: hexadecimal digits at the start of s. */
function xtoi(s: string): { n: number; i: number; ok: boolean } {
  let n = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i] as string;
    if (isDigit(c)) n = n * 16 + (c.charCodeAt(0) - 48);
    else if (c >= 'a' && c <= 'f') n = n * 16 + (c.charCodeAt(0) - 87);
    else if (c >= 'A' && c <= 'F') n = n * 16 + (c.charCodeAt(0) - 55);
    else break;
    if (n >= BIG) return { n: 0, i, ok: false };
  }
  if (i === 0) return { n: 0, i, ok: false };
  return { n, i, ok: true };
}

/** The sloppy parseIPv4: 16 bytes (IPv4-mapped), or undefined. */
function sloppyIPv4(str: string): IP | undefined {
  let s = str;
  const p: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (s.length === 0) return undefined;
    if (i > 0) {
      if (s[0] !== '.') return undefined;
      s = s.slice(1);
    }
    const { n, i: c, ok } = dtoi(s);
    if (!ok || n > 0xff) return undefined;
    s = s.slice(c);
    p.push(n);
  }
  if (s.length !== 0) return undefined;
  return [...V4_IN_V6_PREFIX, ...p];
}

/** The sloppy parseIPv6 (no zones). */
function sloppyIPv6(str: string): IP | undefined {
  let s = str;
  const ip: number[] = new Array<number>(16).fill(0);
  let ellipsis = -1;
  if (s.length >= 2 && s[0] === ':' && s[1] === ':') {
    ellipsis = 0;
    s = s.slice(2);
    if (s.length === 0) return ip;
  }
  let i = 0;
  while (i < 16) {
    const { n, i: c, ok } = xtoi(s);
    if (!ok || n > 0xffff) return undefined;
    if (c < s.length && s[c] === '.') {
      if (ellipsis < 0 && i !== 12) return undefined;
      if (i + 4 > 16) return undefined;
      const ip4 = sloppyIPv4(s);
      if (!ip4) return undefined;
      for (let k = 0; k < 4; k++) ip[i + k] = ip4[12 + k] as number;
      s = '';
      i += 4;
      break;
    }
    ip[i] = n >> 8;
    ip[i + 1] = n & 0xff;
    i += 2;
    s = s.slice(c);
    if (s.length === 0) break;
    if (s[0] !== ':' || s.length === 1) return undefined;
    s = s.slice(1);
    if (s[0] === ':') {
      if (ellipsis >= 0) return undefined;
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) break;
    }
  }
  if (s.length !== 0) return undefined;
  if (i < 16) {
    if (ellipsis < 0) return undefined;
    const n = 16 - i;
    for (let j = i - 1; j >= ellipsis; j--) ip[j + n] = ip[j] as number;
    for (let j = ellipsis + n - 1; j >= ellipsis; j--) ip[j] = 0;
  } else if (ellipsis >= 0) {
    return undefined;
  }
  return ip;
}

/** netutils.ParseIPSloppy: 16 bytes, or undefined. */
export function parseIPSloppy(s: string): IP | undefined {
  for (const c of s) {
    if (c === '.') return sloppyIPv4(s);
    if (c === ':') return sloppyIPv6(s);
  }
  return undefined;
}

function cidrMask(ones: number, bits: number): number[] {
  const out: number[] = [];
  let n = ones;
  for (let i = 0; i < bits / 8; i++) {
    if (n >= 8) {
      out.push(0xff);
      n -= 8;
    } else {
      out.push(n <= 0 ? 0 : (0xff << (8 - n)) & 0xff);
      n = 0;
    }
  }
  return out;
}

/** net.IP.Mask. */
function maskIP(ip0: IP, mask0: number[]): IP | undefined {
  let ip = ip0;
  let mask = mask0;
  if (mask.length === 16 && ip.length === 4 && mask.slice(0, 12).every((b) => b === 0xff)) mask = mask.slice(12);
  if (mask.length === 4 && ip.length === 16 && V4_IN_V6_PREFIX.every((b, i) => ip[i] === b)) ip = ip.slice(12);
  if (ip.length !== mask.length) return undefined;
  return ip.map((b, i) => b & (mask[i] as number));
}

/** netutils.ParseCIDRSloppy: the address as written and the masked network, or Go's error. */
export function parseCIDRSloppy(s: string): { ip: IP; net: IPNet } | { error: string } {
  const err = { error: `invalid CIDR address: ${s}` };
  const slash = s.indexOf('/');
  if (slash < 0) return err;
  const addr = s.slice(0, slash);
  const maskStr = s.slice(slash + 1);
  let iplen = 4;
  let ip = sloppyIPv4(addr);
  if (!ip) {
    iplen = 16;
    ip = sloppyIPv6(addr);
  }
  const { n, i, ok } = dtoi(maskStr);
  if (!ip || !ok || i !== maskStr.length || n < 0 || n > 8 * iplen) return err;
  const net = maskIP(ip, cidrMask(n, 8 * iplen)) as IP;
  return { ip, net: { ip: net, ones: n, bits: 8 * iplen } };
}

/** net.IP.To4. */
export function to4(ip: IP): IP | undefined {
  if (ip.length === 4) return ip;
  if (ip.length === 16 && V4_IN_V6_PREFIX.every((b, i) => ip[i] === b)) return ip.slice(12);
  return undefined;
}

/** netutils.IsIPv6. */
export const isIPv6 = (ip: IP): boolean => to4(ip) === undefined;

export const ipEqual = (a: IP, b: IP): boolean => {
  const a16 = a.length === 4 ? [...V4_IN_V6_PREFIX, ...a] : a;
  const b16 = b.length === 4 ? [...V4_IN_V6_PREFIX, ...b] : b;
  return a16.length === b16.length && a16.every((x, i) => x === b16[i]);
};

/** netip appendTo6: RFC 5952, the longest run of two or more zero groups becomes `::`. */
function format6(ip: IP): string {
  const g = (i: number): number => ((ip[2 * i] as number) << 8) | (ip[2 * i + 1] as number);
  let zeroStart = 255;
  let zeroEnd = 255;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && g(j) === 0) j++;
    const l = j - i;
    if (l >= 2 && l > zeroEnd - zeroStart) {
      zeroStart = i;
      zeroEnd = j;
    }
  }
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === zeroStart) {
      out += '::';
      i = zeroEnd;
      if (i >= 8) break;
    } else if (i > 0) {
      out += ':';
    }
    out += g(i).toString(16);
  }
  return out;
}

/** net.IP.String. */
export function ipString(ip: IP): string {
  if (ip.length === 0) return '<nil>';
  const p4 = to4(ip);
  if (p4) return p4.join('.');
  return format6(ip);
}

/** net.IPNet.String for a mask ParseCIDR made (always a simple prefix). */
export function ipnetString(n: IPNet): string {
  const p4 = to4(n.ip);
  const ones = p4 && n.bits === 128 ? n.ones - 96 : n.ones;
  return `${ipString(p4 ?? n.ip)}/${ones}`;
}

// ---- net/netip (strict) ----

/** A netip.Addr: 16 bytes, whether it is an IPv4 address (z4), and the zone. */
export interface Addr {
  bytes: number[];
  is4: boolean;
  zone: string;
}

function strictIPv4Fields(s: string): number[] | undefined {
  const fields: number[] = [];
  let val = 0;
  let digLen = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (isDigit(c)) {
      if (digLen === 1 && val === 0) return undefined;
      val = val * 10 + (c.charCodeAt(0) - 48);
      digLen++;
      if (val > 255) return undefined;
    } else if (c === '.') {
      if (i === 0 || i === s.length - 1 || s[i - 1] === '.') return undefined;
      if (fields.length === 3) return undefined;
      fields.push(val);
      val = 0;
      digLen = 0;
    } else {
      return undefined;
    }
  }
  if (fields.length < 3) return undefined;
  fields.push(val);
  return fields;
}

function strictIPv6(input: string): Addr | undefined {
  let s = input;
  let zone = '';
  const pct = s.indexOf('%');
  if (pct !== -1) {
    zone = s.slice(pct + 1);
    s = s.slice(0, pct);
    if (zone === '') return undefined;
  }
  const ip: number[] = new Array<number>(16).fill(0);
  let ellipsis = -1;
  if (s.length >= 2 && s[0] === ':' && s[1] === ':') {
    ellipsis = 0;
    s = s.slice(2);
    if (s.length === 0) return { bytes: ip, is4: false, zone };
  }
  let i = 0;
  while (i < 16) {
    let off = 0;
    let acc = 0;
    for (; off < s.length; off++) {
      const c = s[off] as string;
      if (isDigit(c)) acc = acc * 16 + (c.charCodeAt(0) - 48);
      else if (c >= 'a' && c <= 'f') acc = acc * 16 + (c.charCodeAt(0) - 87);
      else if (c >= 'A' && c <= 'F') acc = acc * 16 + (c.charCodeAt(0) - 55);
      else break;
      if (off > 3) return undefined;
      if (acc > 0xffff) return undefined;
    }
    if (off === 0) return undefined;
    if (off < s.length && s[off] === '.') {
      if (ellipsis < 0 && i !== 12) return undefined;
      if (i + 4 > 16) return undefined;
      const f = strictIPv4Fields(s);
      if (!f) return undefined;
      for (let k = 0; k < 4; k++) ip[i + k] = f[k] as number;
      s = '';
      i += 4;
      break;
    }
    ip[i] = acc >> 8;
    ip[i + 1] = acc & 0xff;
    i += 2;
    s = s.slice(off);
    if (s.length === 0) break;
    if (s[0] !== ':' || s.length === 1) return undefined;
    s = s.slice(1);
    if (s[0] === ':') {
      if (ellipsis >= 0) return undefined;
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) break;
    }
  }
  if (s.length !== 0) return undefined;
  if (i < 16) {
    if (ellipsis < 0) return undefined;
    const n = 16 - i;
    for (let j = i - 1; j >= ellipsis; j--) ip[j + n] = ip[j] as number;
    for (let j = ellipsis; j < ellipsis + n; j++) ip[j] = 0;
  } else if (ellipsis >= 0) {
    return undefined;
  }
  return { bytes: ip, is4: false, zone };
}

/** netip.ParseAddr. */
export function parseAddr(s: string): Addr | undefined {
  for (const c of s) {
    if (c === '.') {
      const f = strictIPv4Fields(s);
      return f ? { bytes: [...V4_IN_V6_PREFIX, ...f], is4: true, zone: '' } : undefined;
    }
    if (c === ':') return strictIPv6(s);
    if (c === '%') return undefined;
  }
  return undefined;
}

/** netip.Addr.Is4In6. */
export const is4In6 = (a: Addr): boolean => !a.is4 && V4_IN_V6_PREFIX.every((b, i) => a.bytes[i] === b);

/** netip.Addr.String. */
export function addrString(a: Addr): string {
  if (a.is4) return a.bytes.slice(12).join('.');
  const z = a.zone === '' ? '' : `%${a.zone}`;
  if (is4In6(a)) return `::ffff:${a.bytes.slice(12).join('.')}${z}`;
  return `${format6(a.bytes)}${z}`;
}

/** A netip.Prefix. */
export interface Prefix {
  addr: Addr;
  bits: number;
}

/** netip.ParsePrefix. */
export function parsePrefix(s: string): Prefix | undefined {
  const i = s.lastIndexOf('/');
  if (i < 0) return undefined;
  const addr = parseAddr(s.slice(0, i));
  if (!addr) return undefined;
  if (!addr.is4 && addr.zone !== '') return undefined;
  const bitsStr = s.slice(i + 1);
  if (bitsStr.length > 1 && !((bitsStr[0] as string) >= '1' && (bitsStr[0] as string) <= '9')) return undefined;
  if (!/^[0-9]+$/.test(bitsStr)) return undefined;
  const bits = Number(bitsStr);
  if (bits > (addr.is4 ? 32 : 128)) return undefined;
  return { addr, bits };
}

/** netip.Prefix.Masked().Addr() equals Addr(): no bits set beyond the prefix length. */
export function prefixIsMasked(p: Prefix): boolean {
  const offset = p.addr.is4 ? 96 : 0;
  const total = p.bits + offset;
  return p.addr.bytes.every((b, i) => {
    const keep = Math.max(0, Math.min(8, total - i * 8));
    const mask = keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
    return (b & ~mask & 0xff) === 0;
  });
}

/** netip.Prefix.String. */
export const prefixString = (p: Prefix): string => `${addrString(p.addr)}/${p.bits}`;

/** netutils.IsDualStackCIDRStrings: an error when one does not parse. */
export function isDualStackCIDRStrings(cidrs: readonly string[]): { dualStack: boolean } | { error: string } {
  const nets: IPNet[] = [];
  for (const [i, c] of cidrs.entries()) {
    const r = parseCIDRSloppy(c);
    if ('error' in r) return { error: `invalid CIDR[${i}]: <nil> (${r.error})` };
    nets.push(r.net);
  }
  let v4 = false;
  let v6 = false;
  for (const n of nets) {
    if (v4 && v6) continue;
    if (isIPv6(n.ip)) v6 = true;
    else v4 = true;
  }
  return { dualStack: v4 && v6 };
}
