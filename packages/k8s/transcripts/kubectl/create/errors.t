# kubectl create -f: objects that exist, manifests that cannot be read, and what is not simulated.
# file: web.yaml
# file: mixed.yaml
# file: bad.yaml
# settle: 0
# Texts from the golden fixtures create/from-files and errors/validation (fixtures/golden/v1.37.2);
# the [sim] notices show simulator behavior.
% kubectl create -f web.yaml
# Each object that exists is an error of its own, reported after the others are created.
$ kubectl create -f web.yaml
Error from server (AlreadyExists): error when creating "web.yaml": deployments.apps "web" already exists
Error from server (AlreadyExists): error when creating "web.yaml": services "web" already exists
[exit 1]
# A document of an unknown kind and one without a kind: the others are still created, and the
# errors come at the end.
$ kubectl create -f mixed.yaml
configmap/before created
resource mapping not found for name: "w" namespace: "" from "mixed.yaml": no matches for kind "Widget" in version "example.com/v1"
ensure CRDs are installed first
error validating "mixed.yaml": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false
[exit 1]
$ kubectl create -f mixed.yaml --validate=false
Error from server (AlreadyExists): error when creating "mixed.yaml": configmaps "before" already exists
[resource mapping not found for name: "w" namespace: "" from "mixed.yaml": no matches for kind "Widget" in version "example.com/v1"
ensure CRDs are installed first, unable to decode "mixed.yaml": Object 'Kind' is missing in '{"apiVersion":"v1","metadata":{"name":"nokind"}}']
[exit 1]
$ kubectl create -f bad.yaml
error: error parsing bad.yaml: error converting YAML to JSON: yaml: line 6: did not find expected ',' or ']'
[exit 1]
$ kubectl create -f nothere.yaml
error: the path "nothere.yaml" does not exist
[exit 1]
$ kubectl create -f '*.yml'
error: the path "*.yml" does not exist
[exit 1]
$ kubectl create
error: must specify one of -f and -k
[exit 1]
$ kubectl create web.yaml
error: Unexpected args: [web.yaml]
See 'kubectl create -h' for help and examples
[exit 1]
$ kubectl create -f web.yaml -o wide
error: unable to match a printer suitable for the output format "wide", allowed formats are: go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,kyaml,name,template,templatefile,yaml
[exit 1]
# Not simulated: URLs, kustomize, editing before create.
$ kubectl create -f http://example.com/web.yaml
[sim] kubectl: reading manifests from a URL (http://example.com/web.yaml; the simulated machines have no network) is not simulated yet
[exit 250]
$ kubectl create -k .
[sim] kubectl: kustomize (-k) is not simulated yet
[exit 250]
$ kubectl create -f web.yaml --edit
[sim] kubectl: the flag --edit (kubectl create --edit opens the manifest in an editor before creating it) is not simulated yet
[exit 250]
