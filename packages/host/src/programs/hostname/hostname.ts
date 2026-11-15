// hostname — show or set the system's host name. hostname 3.23 (Debian's, 3.23+nmu2ubuntu2), also
// run as domainname, nisdomainname, ypdomainname and dnsdomainname.
//   docs: hostname(1) of hostname 3.23
//   reference: hostname 3.23 output and errors, captured 2026-11-16 (packages/host/transcripts/hostname/hostname.t)
// The name is the machine's kernel host name (uname -n). The forms that need the resolver (-a,
// -A, -d, -f, -i, -I, dnsdomainname) print the notice: name service lookups are not simulated.
// The simulated kernel has no NIS domain, so the domainname forms report it unset. Setting a name
// needs root, as sethostname(2) does; root gets the notice.

import type { ProcApi, ProgramSpec, Syscall } from '../../proc/program.ts';
import { getMachine } from '../../machine.ts';
import { getopt, type OptionSpec } from '../lib/getopt.ts';
import { isFsError, strerror } from '../../vfs/errno.ts';

/** `hostname --help`. reference: hostname 3.23, captured 2026-11-16 */
const HELP = "Usage: hostname [-b] {hostname|-F file}         set host name (from file)\n       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n       hostname                                 display host name\n\n       {yp,nis,}domainname {nisdomain|-F file}  set NIS domain name (from file)\n       {yp,nis,}domainname                      display NIS domain name\n\n       dnsdomainname                            display dns domain name\n\n       hostname -V|--version|-h|--help          print info and exit\n\nProgram name:\n       {yp,nis,}domainname=hostname -y\n       dnsdomainname=hostname -d\n\nProgram options:\n    -a, --alias            alias names\n    -A, --all-fqdns        all long host names (FQDNs)\n    -b, --boot             set default hostname if none available\n    -d, --domain           DNS domain name\n    -f, --fqdn, --long     long host name (FQDN)\n    -F, --file             read host name or NIS domain name from given file\n    -i, --ip-address       addresses for the host name\n    -I, --all-ip-addresses all addresses for the host\n    -s, --short            short host name\n    -y, --yp, --nis        NIS/YP domain name\n\nDescription:\n   This command can get or set the host name or the NIS domain name. You can\n   also get the DNS domain or the FQDN (fully qualified domain name).\n   Unless you are using bind or NIS for host lookups you can change the\n   FQDN (Fully Qualified Domain Name) and the DNS domain name (which is\n   part of the FQDN) in the /etc/hosts file.\n";

const OPTIONS: OptionSpec[] = [
  { short: 'a', long: 'alias' },
  { short: 'A', long: 'all-fqdns' },
  { short: 'b', long: 'boot' },
  { short: 'd', long: 'domain' },
  { short: 'f', long: 'fqdn' },
  { long: 'long', id: 'fqdn' },
  { short: 'F', long: 'file', arg: 'required' },
  { short: 'i', long: 'ip-address' },
  { short: 'I', long: 'all-ip-addresses' },
  { short: 's', long: 'short' },
  { short: 'y', long: 'yp' },
  { long: 'nis', id: 'yp' },
  { short: 'V', long: 'version' },
  { short: 'h', long: 'help' },
];

/** The domain name a Linux kernel starts with. */
const NO_NIS_DOMAIN = '(none)';

const RESOLVER = new Set(['alias', 'all-fqdns', 'domain', 'fqdn', 'ip-address', 'all-ip-addresses']);

function* main(p: ProcApi): Generator<Syscall, number, unknown> {
  const r = getopt(p.argv.slice(1), { options: OPTIONS });
  if (!r.ok) {
    if ('unsupported' in r) return yield* p.unsupported({ kind: 'flag', what: `the flag ${r.unsupported}` });
    // An unknown option: getopt's message on stderr, the usage on stdout, status 255.
    yield* p.write(2, `${p.name}: ${r.error}\n`);
    yield* p.write(1, HELP);
    return 255;
  }
  const prog = p.name;
  let mode: string | undefined;
  let file: string | undefined;
  for (const o of r.options) {
    if (o.id === 'help') {
      yield* p.write(1, HELP);
      return 255;
    }
    if (o.id === 'version') {
      yield* p.write(1, 'hostname 3.23\n');
      return 0;
    }
    if (o.id === 'file') file = o.value;
    // -b sets a name only when none is set, and the kernel always has one: it only displays.
    else if (o.id === 'boot') continue;
    else mode = o.id;
  }
  if (prog === 'dnsdomainname') mode ??= 'domain';
  const nis = prog === 'domainname' || prog === 'nisdomainname' || prog === 'ypdomainname' || mode === 'yp';
  // A display form takes no operand, and at most one name can be set.
  if (r.operands.length > 1 || (r.operands.length > 0 && mode !== undefined && mode !== 'yp')) {
    yield* p.write(2, HELP);
    return 255;
  }
  let setting = r.operands[0];
  if (file !== undefined) {
    // -F reads the name from a file first (its errors come before the root check).
    try {
      setting = (p.fs().readFile(file).split('\n')[0] ?? '').trim();
    } catch (e) {
      if (!isFsError(e)) throw e;
      yield* p.write(2, `${prog}: ${strerror(e.code)}\n`);
      return 1;
    }
  }
  if (setting !== undefined) {
    if (setting === '') {
      yield* p.write(2, `${prog}: the specified hostname is invalid\n`);
      return 1;
    }
    if (p.cred.uid !== 0) {
      yield* p.write(2, `${prog}: you must be root to change the ${nis ? 'domain' : 'host'} name\n`);
      return 1;
    }
    return yield* p.unsupported({ kind: 'behavior', what: `setting the ${nis ? 'NIS domain' : 'host'} name` });
  }
  if (mode !== undefined && RESOLVER.has(mode)) {
    return yield* p.unsupported({ kind: 'behavior', what: `${prog} -${OPTIONS.find((o) => o.id === mode || o.long === mode)?.short ?? mode}`, hints: ['name service lookups (/etc/hosts, DNS) are not simulated yet; plain `hostname` and `hostname -s` work'] });
  }
  if (nis) {
    // domainname prints the kernel's NIS domain; the nis/yp forms ask for a domain that is set.
    if (prog === 'domainname' && mode === undefined) {
      yield* p.write(1, `${NO_NIS_DOMAIN}\n`);
      return 0;
    }
    yield* p.write(2, `${prog}: Local domain name not set\n`);
    return 1;
  }
  const name = getMachine(p.ctx, p.machine).hostname;
  yield* p.write(1, `${mode === 'short' ? (name.split('.')[0] as string) : name}\n`);
  return 0;
}

export const hostnameProgram: ProgramSpec = { name: 'hostname', main };
