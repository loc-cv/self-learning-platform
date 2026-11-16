# kubectl apply: manifests the API server or kubectl refuses, and what the simulator does not do.
# file: app.yaml
# file: typo.yaml
# file: broken.yaml
# file: immutable.yaml
# file: elsewhere.yaml
# settle: 0
# Texts from the golden fixtures errors/validation, apply/three-way and create/from-files
# (fixtures/golden/v1.37.2); the [sim] notices show simulator behavior.
% kubectl apply -f app.yaml
# An unknown field: strict field validation (the default) refuses it; warn creates the object with
# the server's warning (in color on a terminal) and drops the field.
$ kubectl apply -f typo.yaml
Error from server (BadRequest): error when creating "typo.yaml": Pod in version "v1" cannot be handled as a Pod: strict decoding error: unknown field "spec.containers[0].imagePullPolice"
[exit 1]
$ kubectl apply -f typo.yaml --validate=warn
[33;1mWarning:[0m unknown field "spec.containers[0].imagePullPolice"
pod/typo created
$ kubectl get pod typo -o name
pod/typo
# A YAML syntax error names the line; a missing file is reported before anything is read.
$ kubectl apply -f broken.yaml
error: error parsing broken.yaml: error converting YAML to JSON: yaml: line 4: did not find expected key
[exit 1]
$ kubectl apply -f missing.yaml
error: the path "missing.yaml" does not exist
[exit 1]
# A Deployment's selector cannot change.
$ kubectl apply -f immutable.yaml
The Deployment "app" is invalid: spec.selector: Invalid value: {"matchLabels":{"app":"other"}}: field is immutable
[exit 1]
# A namespace in the manifest must match -n.
$ kubectl apply -f elsewhere.yaml -n default
error: the namespace from the provided object "kube-public" does not match the namespace "default". You must pass '--namespace=kube-public' to perform this operation.
[exit 1]
$ kubectl apply -f elsewhere.yaml -n kube-public -o name
configmap/elsewhere
$ kubectl apply
error: must specify one of -f and -k
[exit 1]
$ kubectl apply app.yaml
error: Unexpected args: [app.yaml]
See 'kubectl apply -h' for help and examples
[exit 1]
$ kubectl apply -f app.yaml --force-conflicts
error: --force-conflicts only works with --server-side
[exit 1]
# Not simulated: server-side apply, pruning, URLs, kustomize.
$ kubectl apply -f app.yaml --server-side
[sim] kubectl: the flag --server-side (server-side apply) is not simulated yet
[exit 250]
$ kubectl apply -f app.yaml --prune --all
[sim] kubectl: the flag --prune is not simulated yet
[exit 250]
$ kubectl apply -f https://example.com/app.yaml
[sim] kubectl: reading manifests from a URL (https://example.com/app.yaml; the simulated machines have no network) is not simulated yet
[exit 250]
$ kubectl apply -k .
[sim] kubectl: kustomize (-k) is not simulated yet
[exit 250]
