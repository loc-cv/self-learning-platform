// IP and CIDR validation of API fields.
// upstream: staging/src/k8s.io/apimachinery/pkg/util/validation/ip.go (parseIP, IsValidIP,
// IsValidIPForLegacyField, GetWarningsForIP, parseCIDR, IsValidCIDRForLegacyField, IsValidCIDR,
// GetWarningsForCIDR). The StrictIPCIDRValidation feature gate is on in v1.37.2: checked
// against the v1.37.2 oracle: a Node with podCIDR "10.244.9.1/24" is refused with "must not have
// bits set beyond the prefix length", "010.1.0.0/24" with "must not have leading 0s in IP or
// prefix length".

import { goQuote, invalid, type FieldError, type Path } from '../field.ts';
import { addrString, ipEqual, ipString, ipnetString, is4In6, parseAddr, parseCIDRSloppy, parseIPSloppy, parsePrefix, prefixIsMasked, prefixString, type IP } from '../net.ts';

/** pkg/features StrictIPCIDRValidation, on by default in v1.37. */
export const STRICT_IP_CIDR_VALIDATION = true;

function parseIP(path: Path, value: string, strict: boolean): { ip: IP | undefined; errs: FieldError[] } {
  const ip = parseIPSloppy(value);
  if (!ip) return { ip: undefined, errs: [invalid(path, value, 'must be a valid IP address, (e.g. 10.9.8.7 or 2001:db8::ffff)')] };
  const errs: FieldError[] = [];
  if (strict) {
    const addr = parseAddr(value);
    if (!addr) errs.push(invalid(path, value, 'must not have leading 0s'));
    if (addr && is4In6(addr)) errs.push(invalid(path, value, 'must not be an IPv4-mapped IPv6 address'));
  }
  return { ip, errs };
}

export function isValidIPForLegacyField(path: Path, value: string, validOldIPs: readonly string[] = [], strict = STRICT_IP_CIDR_VALIDATION): FieldError[] {
  if (validOldIPs.includes(value)) return [];
  return parseIP(path, value, strict).errs;
}

export function isValidIP(path: Path, value: string): FieldError[] {
  const { ip, errs } = parseIP(path, value, true);
  if (errs.length > 0 || !ip) return errs;
  const canonical = ipString(ip);
  if (value !== canonical) return [invalid(path, value, `must be in canonical form (${goQuote(canonical)})`)];
  return [];
}

export function getWarningsForIP(path: Path, value: string): string[] {
  const ip = parseIPSloppy(value);
  if (!ip) return [];
  const addr = parseAddr(value);
  if (!addr || is4In6(addr)) return [`${path.toString()}: non-standard IP address ${goQuote(value)} is invalid: use ${goQuote(ipString(ip))}`];
  if (!addr.is4 && addrString(addr) !== value) return [`${path.toString()}: IPv6 address ${goQuote(value)} should be in RFC 5952 canonical format (${goQuote(addrString(addr))})`];
  return [];
}

function parseCIDR(path: Path, value: string, strict: boolean): { ok: boolean; canonical: string; errs: FieldError[] } {
  const r = parseCIDRSloppy(value);
  if ('error' in r) return { ok: false, canonical: '', errs: [invalid(path, value, 'must be a valid CIDR value, (e.g. 10.9.8.0/24 or 2001:db8::/64)')] };
  const errs: FieldError[] = [];
  if (strict) {
    const prefix = parsePrefix(value);
    if (!prefix) errs.push(invalid(path, value, 'must not have leading 0s in IP or prefix length'));
    else if (is4In6(prefix.addr)) errs.push(invalid(path, value, 'must not have an IPv4-mapped IPv6 address'));
    else if (!prefixIsMasked(prefix)) errs.push(invalid(path, value, 'must not have bits set beyond the prefix length'));
  }
  return { ok: true, canonical: ipnetString(r.net), errs };
}

export function isValidCIDRForLegacyField(path: Path, value: string, validOldCIDRs: readonly string[] = [], strict = STRICT_IP_CIDR_VALIDATION): FieldError[] {
  if (validOldCIDRs.includes(value)) return [];
  return parseCIDR(path, value, strict).errs;
}

export function isValidCIDR(path: Path, value: string): FieldError[] {
  const r = parseCIDR(path, value, true);
  if (r.errs.length > 0) return r.errs;
  if (value !== r.canonical) return [invalid(path, value, `must be in canonical form (${goQuote(r.canonical)})`)];
  return [];
}

export function getWarningsForCIDR(path: Path, value: string): string[] {
  const r = parseCIDRSloppy(value);
  if ('error' in r) return [];
  const warnings: string[] = [];
  const p = path.toString();
  if (!ipEqual(r.ip, r.net.ip)) {
    const single = `${ipString(r.ip)}/${r.net.bits}`;
    warnings.push(`${p}: CIDR value ${goQuote(value)} is ambiguous in this context (should be ${goQuote(ipnetString(r.net))} or ${goQuote(single)}?)`);
  }
  const prefix = parsePrefix(value);
  if (!prefix || is4In6(prefix.addr)) warnings.push(`${p}: non-standard CIDR value ${goQuote(value)} is invalid: use ${goQuote(ipnetString(r.net))}`);
  if (warnings.length === 0 && prefix && !prefix.addr.is4 && prefixString(prefix) !== value) {
    warnings.push(`${p}: IPv6 CIDR value ${goQuote(value)} should be in RFC 5952 canonical format (${goQuote(prefixString(prefix))})`);
  }
  return warnings;
}
