// /docker-entrypoint.sh of the official nginx images (Debian and Alpine have the same script and
// the same /docker-entrypoint.d/ scripts): what it prints before it execs nginx.
//
// reference: fixtures/reference/images/scripts/nginx/ and nginx-alpine/ (docker-entrypoint.sh and
// docker-entrypoint.d/*), verbatim from the nginx:1.31.8 and nginx:alpine layers, captured
// 2026-11-16. Every line below is an `entrypoint_log`/`echo` of those scripts, which goes to
// stdout. Older tags with an entrypoint (1.19–1.30) share the representative's files
// (catalog.data.ts filesFrom), so the same scripts are modeled for them.
//
// Branches taken under default conditions, decided from the scripts and the image files:
// - /docker-entrypoint.d/ holds four regular files, all executable (files/nginx.json), so the
//   configuration runs; `find | sort -V` orders them 10-, 15-, 20-, 30-.
// - 10-listen-on-ipv6-by-default.sh: /proc/net/if_inet6 exists (the Pod's network namespace has
//   IPv6 enabled, the kernel default); /etc/nginx/conf.d/default.conf is the packaged file (a new
//   container starts from the image layers, so a restart does not see the earlier edit); the
//   checksum check passes (dpkg-query on Debian; `apk manifest` on Alpine, apk-tools 3.0.9 in the
//   image, assumed to print the sha1 the script expects); so IPv6 listen is enabled.
// - 15-local-resolvers.envsh: NGINX_ENTRYPOINT_LOCAL_RESOLVERS unset → return 0, nothing printed.
// - 20-envsubst-on-templates.sh: /etc/nginx/templates does not exist in the image → return 0.
// - 30-tune-worker-processes.sh: NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE unset → exit 0.
// Environment that changes a branch the model cannot follow (templates, autotune, local
// resolvers: they read files and cgroups the model cannot see) is reported as a gap.

import type { Json } from '@simlab/kernel';
import type { ModelGap, ModelStep, Output, ProcessInput, ProgramModel } from '../types.ts';
import { getenv, line, scriptExec, scriptShell } from './common.ts';

const ME = '10-listen-on-ipv6-by-default.sh';
const CONF = '/etc/nginx/conf.d/default.conf';
const D = '/docker-entrypoint.d';

/** Line of `exec "$@"` in docker-entrypoint.sh. */
const EXEC_LINE = 47;

/**
 * Process IDs the entrypoint's children use before it execs nginx, in a new PID namespace where
 * IDs are handed out in order from 2. Counted from the scripts under the default branches, one
 * per fork: the two pipelines of docker-entrypoint.sh (2 + 3), one per launched script, and in
 * them each command substitution and external command (10-listen: basename, touch, grep, the
 * checksum pipeline in its substitution (4 on Debian: subshell, dpkg-query, grep, cut; 5 on
 * Alpine: subshell, apk, grep, cut, cut), the md5sum/sha1sum pipeline 2, sed; 20-envsubst:
 * basename and the nested awk substitution 2; 30-tune: basename). It cannot be exact (the
 * shells' fork-saving differs in detail), but it puts nginx's workers where the real ones land:
 * after the entrypoint's processes, not at 2.
 */
export const ENTRYPOINT_PIDS_USED: Readonly<Record<'dash' | 'busybox' | 'bash', number>> = { dash: 22, busybox: 23, bash: 22 };

function gapsFor(p: ProcessInput): ModelGap[] {
  const gaps: ModelGap[] = [];
  const set = (n: string): boolean => (getenv(p, n) ?? '') !== '';
  if (set('NGINX_ENTRYPOINT_LOCAL_RESOLVERS')) gaps.push({ what: 'nginx entrypoint: NGINX_ENTRYPOINT_LOCAL_RESOLVERS', detail: '15-local-resolvers.envsh reads /etc/resolv.conf; NGINX_LOCAL_RESOLVERS is not exported' });
  if (set('NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE')) gaps.push({ what: 'nginx entrypoint: NGINX_ENTRYPOINT_WORKER_PROCESSES_AUTOTUNE', detail: '30-tune-worker-processes.sh reads cgroup limits; worker_processes is left at auto' });
  if (getenv(p, 'NGINX_ENVSUBST_TEMPLATE_DIR') !== undefined) gaps.push({ what: 'nginx entrypoint: NGINX_ENVSUBST_TEMPLATE_DIR', detail: '20-envsubst-on-templates.sh: templates are not rendered' });
  return gaps;
}

function start(p: ProcessInput): ModelStep {
  const arg0 = p.exe.path;
  const args = p.argv.slice(1);
  const shell = scriptShell(p);
  // `if [ "$1" = "nginx" ] || [ "$1" = "nginx-debug" ]`: anything else is exec'd without configuration.
  if (args[0] !== 'nginx' && args[0] !== 'nginx-debug') return scriptExec(p, shell, EXEC_LINE, args);

  const quiet = (getenv(p, 'NGINX_ENTRYPOINT_QUIET_LOGS') ?? '') !== '';
  const lines: string[] = [
    `${arg0}: /docker-entrypoint.d/ is not empty, will attempt to perform configuration`,
    `${arg0}: Looking for shell scripts in /docker-entrypoint.d/`,
    `${arg0}: Launching ${D}/10-listen-on-ipv6-by-default.sh`,
    `${ME}: info: Getting the checksum of ${CONF}`,
    `${ME}: info: Enabled listen on IPv6 in ${CONF}`,
    `${arg0}: Sourcing ${D}/15-local-resolvers.envsh`,
    `${arg0}: Launching ${D}/20-envsubst-on-templates.sh`,
    `${arg0}: Launching ${D}/30-tune-worker-processes.sh`,
    `${arg0}: Configuration complete; ready for start up`,
  ];
  // A few milliseconds per script: forks and execs of small tools. A model choice; nothing
  // depends on it beyond the log timestamps.
  const output: Output[] = quiet ? [] : lines.map((t, i) => line('stdout', t, i * 2));
  const gaps = gapsFor(p);
  const step = scriptExec(p, shell, EXEC_LINE, args, output, lines.length * 2);
  return gaps.length ? { ...step, gaps } : step;
}

export const nginxEntrypointModel: ProgramModel = {
  name: 'nginx-entrypoint',
  start,
  // The script never waits: start ends in exec or exit.
  resume: (_p, _state: Json) => ({ next: { exit: 0 } }),
};
