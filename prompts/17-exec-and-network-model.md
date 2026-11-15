# Phase 17 — Exec and the network model: container shell, DNS, Services, client tools

**Milestone** M3 · **Needs** 16b · Follow the session protocol in `CLAUDE.md`.

## Goal

Let me get inside containers and test connectivity the way I do in real life: exec into a Pod,
`curl` a Service, look up a name. Behind it sits one network model that answers "what would this
client see?", used by tools, probes and checks alike.

## Read first

`PLAN.md` §6.2, §7 (network model), §4.3 (no packets).

## Build

- **Network model**: `connect(source, destination, port, protocol)` returning what the client would
  observe: answered (with the listener's response), name not resolved, connection refused, timed out.
  Resolution steps: DNS with the Pod's `resolv.conf`, search domains and `dnsPolicy`; Service
  ClusterIP to ready endpoints with `targetPort` and named ports; headless Services; Pod IPs
  directly; node addresses; the cluster DNS records for Services and Pods. HTTP responses come from
  the target's behavior model. Emit trace records for each hop.
- **Container as a machine**: a restricted machine view per container with the image's filesystem,
  its mounts, its environment, the binaries its image really has (a `distroless`-like image has no
  shell), and the Pod's network identity.
- **kubectl**: `exec` (with and without `-it`, `-c`, the command after `--`), `run --rm -it`,
  `attach` in simple form, `cp` both directions, `port-forward` (reachable from the workstation's
  localhost while it runs), `debug` with an ephemeral container if cheap, otherwise a notice.
- **Client tools**, in images that have them and on hosts: `curl` and `wget` with the flags used
  for testing (`-s`, `-S`, `-I`, `-o`, `-m`, `--connect-timeout`, `-O-`, `-T`, `-q`), `nslookup`,
  `dig` basics, `nc -zv`, `ping` (answering according to the model, with its limits stated),
  `env`, `printenv`, `cat /etc/resolv.conf`, `hostname -i`. Error texts and exit codes are the real
  tools': get them from the real binaries on this workstation where possible. `curl`, `wget`,
  OpenBSD `nc`, `ping`, and BIND's `nslookup`, `dig` and `host` are installed (`docs/FIDELITY.md`
  §2.1).
- **Checks**: `net.reach` (from a Pod or host to a target, expecting an outcome or status code).
- **Probes** from phase 16b now go through the network model.
- X-ray: show a connection attempt's path and where it stopped. Add five items on Services, DNS and
  debugging connectivity from inside Pods.

## Not in this phase

NetworkPolicy, Ingress, Gateway, NodePort and LoadBalancer (phases 19a, 19b). CoreDNS and kube-proxy
failure modes (phase 30). Until phase 30, cluster DNS and Service routing are assumed healthy.

## Exit criteria

- Transcripts: curl to a Service by short name, by FQDN and by ClusterIP from another namespace;
  a Service with no endpoints; a wrong `targetPort`; a name that doesn't exist. Each shows the real
  client error.
- `kubectl exec -it` gives a usable shell with completion and Ctrl-C, and exits cleanly.
- `kubectl cp` round-trips a file; `port-forward` serves until interrupted.
- A lab graded only by `net.reach` passes via two different fixes.
- The divergence register states the limits of `ping` and anything packet-level.
