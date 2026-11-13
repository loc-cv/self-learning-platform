# Phase 30 — Cluster networking troubleshooting: CoreDNS, kube-proxy, CNI

**Milestone** M4 · **Needs** 27, 19a · Follow the session protocol in `CLAUDE.md`.

## Goal

Until now cluster DNS and Service routing were assumed healthy. This phase makes them depend on
the components that provide them, so "names don't resolve" and "the Service doesn't answer" can
have causes in CoreDNS, kube-proxy or the CNI, and I can find them. Covers "understand and use
CoreDNS" and "troubleshoot services and networking".

## Read first

`PLAN.md` §7 (network model). The network model from phases 17 and 19a. Official documentation for
CoreDNS in Kubernetes, DNS debugging, kube-proxy modes and Service debugging.

## Build

- **CoreDNS as the source of DNS**: resolution works only through ready CoreDNS Pods behind the
  `kube-dns` Service; the Corefile in its ConfigMap is parsed and matters (`kubernetes` with the
  cluster domain and fallthrough, `forward` to upstream, `hosts`, `rewrite`, `cache`, `log`,
  `errors`, `loop`, `reload` with its delay, stub domains by server block); a Corefile syntax error
  crash-loops CoreDNS with its real log line; upstream names resolve through a small simulated
  external DNS; query logs appear when `log` is enabled.
- **Client side**: each Pod's `/etc/resolv.conf` from the kubelet's cluster DNS setting and the
  Pod's `dnsPolicy` and `dnsConfig`; `ndots` and search-path behavior visible in `nslookup` and
  `dig` output; a kubelet with the wrong cluster DNS address gives new Pods a resolver that doesn't
  answer.
- **Failure modes**: CoreDNS scaled to zero, crash-looping, not ready; the `kube-dns` Service with
  a wrong selector or port; a NetworkPolicy blocking DNS; CoreDNS RBAC removed (the real log lines
  and stale answers); wrong cluster domain; forwarding loop.
- **kube-proxy as the source of Service routing**: per node, ClusterIP and NodePort translation
  work only while that node's kube-proxy Pod runs and has programmed the Service; its ConfigMap
  (mode, cluster CIDR) and kubeconfig matter; a broken kube-proxy leaves Pod IPs working and
  Service IPs dead on that node only; its logs say why. `iptables-save` and `ipvsadm` print a
  `[sim]` notice (rule-level inspection is a non-goal).
- **CNI as the source of Pod networking**: Pod-to-Pod traffic across nodes needs the CNI's
  per-node agent running; a missing or crashed agent, a wrong Pod CIDR and an exhausted address
  range each have their real symptom (new Pods stuck in `ContainerCreating` with the real sandbox
  error, cross-node timeouts).
- **Service debugging signals**: everything the official "Debug Services" walk-through checks
  gives the right answer: endpoints, `targetPort`, readiness, hairpin in simple form, `kubectl
  proxy` and `port-forward` as side doors.
- **Faults and checks** for each failure mode; extend X-ray: the DNS path and the Service path
  with the component each hop depends on.
- Add six items: a CoreDNS lesson with guided Corefile changes (a custom hosts entry, a stub
  domain); two DNS incidents with different root causes; a kube-proxy incident limited to one
  node; a CNI incident; a chained real-world incident ("the app can't reach its database") whose
  cause is drawn from all networking phases.

## Not in this phase

Packet capture, iptables and IPVS rule inspection, eBPF data planes, IPv6 and dual stack: non-goals
recorded in the divergence register.

## Exit criteria

- For each failure mode, a simulation test asserts the client-visible symptom from inside a Pod
  (`nslookup`, `curl`), the component's status and log line, and recovery after the fix.
- Corefile changes take effect after the reload delay; a syntax error produces the crash loop.
- A node-local kube-proxy failure affects only clients on that node.
- The healthy default topology behaves exactly as before this phase (existing transcripts unchanged).
- The items pass `content:check`, each incident solvable from the terminal with X-ray off.
