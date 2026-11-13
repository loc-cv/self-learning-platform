# Phase 27 — Control plane as static Pods, failure modes, certificate expiry

**Milestone** M4 · **Needs** 26b · Follow the session protocol in `CLAUDE.md`.

## Goal

The control plane stops being magic. The API server, etcd, scheduler and controller manager run
as static Pods defined by manifests on the control-plane node, and the cluster works only as far
as those manifests, their flags and their certificates are right. Breaking and repairing them is
"troubleshoot cluster components", and it must emerge from the model, not from scripted cases.

## Read first

`PLAN.md` §7. The component start and stop switches added in phases 05b, 06a and the connection
abstraction from 07a. Upstream kubeadm sources for the manifests, PKI layout and kubeconfig files
it generates; upstream component sources for startup log lines and fatal errors (search; don't read
whole files). The real binaries in `.upstream/bin/` print their real errors for bad flags: use them.

## Build

- **kubeadm layout on the control-plane node**: the four manifests in
  `/etc/kubernetes/manifests` as kubeadm writes them for the pinned version; `/etc/kubernetes/pki`
  with the full certificate tree in the PKI stand-in format (cluster CA, API server serving and
  client certificates, front-proxy, etcd CA and its certificates, the ServiceAccount key pair);
  `admin.conf`, `super-admin.conf`, `controller-manager.conf`, `scheduler.conf`; the etcd data
  directory; the `kubeadm-config` and `kubelet-config` ConfigMaps and the other objects kubeadm creates.
- **Component behavior models** that parse their own command lines and files:
  - *kube-apiserver*: etcd endpoints and client certificates, serving certificate and key, client
    CA, ServiceAccount keys and issuer, authorization modes, enabled and disabled admission
    plugins, service cluster IP range, advertise address and secure port, the kubelet client
    credentials (which `logs` and `exec` need). Its liveness and readiness follow from these.
  - *etcd*: data directory, listen and advertise URLs, certificates, with the store attached to
    the data directory it points at.
  - *kube-scheduler* and *kube-controller-manager*: kubeconfig and credentials, leader election,
    and for the controller manager the cluster CIDR, signing certificates, ServiceAccount key and
    the enabled controllers.
  - Each wrong input produces the component's real fatal log line and exit, a crash loop visible
    through `crictl` and `/var/log/pods`, and the real downstream effect.
- **Coupling**, replacing the shortcuts from phase 06a:
  - kubectl and every other client reach the API only when the API server container is running and
    ready at the address their kubeconfig names, with certificates that verify. Otherwise they get
    the real client error for that case (connection refused, certificate signed by unknown
    authority, certificate has expired, Unauthorized, timeouts).
  - API server down: controllers, scheduler and kubelets can't read or write; running containers
    keep running.
  - Scheduler down: Pods stay Pending. Controller manager down: nothing reconciles. Admission
    plugins and authorization modes follow the API server's flags.
  - Volumes and host paths in the manifests matter: a wrong mount hides the file from the component.
- **Certificate expiry**: all validity is checked against the virtual clock, so advancing time by a
  year breaks a cluster the real way; kubelet client certificate rotation behaves as configured.
- **Probes and restarts** for the static Pods as defined in the real manifests.
- **Faults and checks**: one fault per input above; component healthy; API reachable. Extend the
  X-ray view provider: component health and what each one is waiting for.
- Add six incidents: API server won't start (three different root causes), Pods Pending with a
  broken scheduler, scaling does nothing with a broken controller manager, kubectl fails after
  certificates expired.

## Not in this phase

etcd backup and restore and `kubeadm certs` (phase 28). `kubeadm init`, `join`, `upgrade` (29a).
HA control planes (29c).

## Exit criteria

- For each component input, a simulation test breaks it and asserts the container state, the log
  line, the client-visible error and the downstream effect; repairing the manifest recovers the
  cluster with no other intervention.
- With the API server down, `kubectl` prints the real connection error, `crictl ps -a` shows the
  crash loop, and its log is readable on the node.
- No seeded control-plane shortcut remains; `STATUS.md` reflects that.
- Advancing the clock past certificate expiry produces the real failures in the real order.
- The default topology still boots to a healthy cluster from files alone, deterministically, and
  boot time in tests stays acceptable (measure it; cache a booted snapshot if needed).
- The incidents pass `content:check` with several fault variants each.
