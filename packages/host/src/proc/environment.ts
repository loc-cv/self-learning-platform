// The environment a login starts with on a simulated Ubuntu server (docs/decisions.md D-022):
// what sshd and its PAM stack set before the shell runs. The shell adds PWD, SHLVL and `_`.
//   reference: /etc/pam.d/sshd of openssh-server 1:9.6p1-3ubuntu13.20 on the workstation, captured
//     2026-11-16: `pam_env.so` (reads /etc/environment) and `pam_env.so user_readenv=1
//     envfile=/etc/default/locale`.
//   docs: sshd(8) "LOGIN PROCESS" item 7 and ENVIRONMENT: USER, LOGNAME, HOME, PATH, MAIL, SHELL,
//     TZ (when set), TERM from the client.

import type { Ctx } from '@simlab/kernel';
import { isFsError } from '../vfs/errno.ts';
import { createFs } from '../vfs/fs.ts';
import { ROOT_CRED } from '../vfs/types.ts';
import type { PasswdEntry } from '../users.ts';

/**
 * Parses a pam_env "envfile" (`KEY=value` lines, optional double quotes, `#` comments), as
 * /etc/environment and /etc/default/locale are written. docs: pam_env(8), pam_env.conf(5)
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2] as string;
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

function readEnvFile(ctx: Ctx, machine: string, path: string): Record<string, string> {
  try {
    return parseEnvFile(createFs(ctx, machine, { cred: ROOT_CRED, umask: 0 }).readFile(path));
  } catch (e) {
    if (isFsError(e)) return {};
    throw e;
  }
}

/**
 * sshd's built-in PATH, used when /etc/environment sets none.
 * reference: the only PATH string in /usr/sbin/sshd of openssh-server 1:9.6p1-3ubuntu13.20
 * (`strings`), captured 2026-11-16.
 */
const SSHD_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games';

export function loginEnvironment(ctx: Ctx, machine: string, user: PasswdEntry, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: SSHD_DEFAULT_PATH,
    MAIL: `/var/mail/${user.name}`,
    USER: user.name,
    LOGNAME: user.name,
    HOME: user.home,
    SHELL: user.shell,
    ...extra,
    ...readEnvFile(ctx, machine, '/etc/environment'),
    ...readEnvFile(ctx, machine, '/etc/default/locale'),
  };
}
