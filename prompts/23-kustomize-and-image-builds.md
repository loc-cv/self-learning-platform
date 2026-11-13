# Phase 23 — Kustomize and container image builds

**Milestone** M3 · **Needs** 15 · Follow the session protocol in `CLAUDE.md`.

## Goal

Two CKAD and CKA topics outside the cluster itself: composing manifests with Kustomize, and
defining, building and modifying container images.

## Read first

`PLAN.md` §6.3, §9. The real `kubectl kustomize` runs offline in the client-only oracle (phase 04):
it is the judge for every Kustomize output.

## Build

**Kustomize**
- `kubectl kustomize <dir>`, `kubectl apply -k`, `kubectl get -k`, `kubectl delete -k`, and a
  `kustomize` program (`build`, `edit set image`, `edit add resource` in simple form).
- `kustomization.yaml` features in common use: resources and bases, overlays, `namePrefix`,
  `nameSuffix`, `namespace`, labels and `commonLabels`, `commonAnnotations`, `images`, `replicas`,
  `configMapGenerator` and `secretGenerator` with content hashes and reference rewriting,
  strategic-merge and JSON 6902 patches with targets, `patchesStrategicMerge` with its deprecation
  warning, components if cheap. Output order and formatting equal the real tool's.
- Unsupported fields print a `[sim]` notice naming the field.

**Image builds**
- `docker` and `podman` programs with a shared implementation: `build` (`-t`, `-f`, context
  directory), `images`, `tag`, `rmi`, `save` and `load`, `push` and `pull` against the simulated
  registry, `run` in simple form (`-d`, `-p`, `--name`, `--rm`, `-e`), `ps`, `logs`, `stop`, `rm`,
  `inspect`, `history`, `login` accepted.
- A Dockerfile parser and build model: `FROM` (including multi-stage and `AS`), `RUN`, `COPY`,
  `ADD`, `WORKDIR`, `ENV`, `ARG`, `EXPOSE`, `USER`, `CMD`, `ENTRYPOINT`, `LABEL`. A build produces
  an image in the catalog whose behavior model derives from its base image plus the instructions
  (entrypoint and command, environment, user, exposed ports, copied files). `RUN` lines aren't
  executed: recognized package installs and file operations change the image's file and binary list;
  others are accepted and recorded. Build output resembles the real builder's and is tagged
  `approximate`.
- Images pushed to the registry become pullable by the cluster, so "build, push, deploy" works.
- A scenario option for an in-cluster or local registry address.

Add five items: Kustomize overlays, a generator with a rollout triggered by a hash change, building
and fixing a Dockerfile, running an image as non-root, deploying a locally built image.

## Not in this phase

Helm (phase 24). BuildKit specifics, image layers and digests beyond plausible values.

## Exit criteria

- A Kustomize test corpus of at least twenty-five directories whose output equals the real
  `kubectl kustomize`, byte for byte, generated through the oracle.
- An image built from a modified Dockerfile runs in the cluster with behavior reflecting the
  change (new command, user, port, file).
- The divergence register states exactly what a simulated build does and doesn't model.
- The new items pass `content:check`.
