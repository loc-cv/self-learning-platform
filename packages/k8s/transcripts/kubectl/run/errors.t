# kubectl run: the errors kubectl prints before it sends anything, in the order its Complete and
# Validate check them, and the override errors.
# settle: 0
# Texts from the golden fixtures generate/client and generate/run (fixtures/golden/v1.37.2).
$ kubectl run web
error: required flag(s) "image" not set
[exit 1]
$ kubectl run --image=nginx:1.27
error: NAME is required for run
[exit 1]
$ kubectl run web --image=Nginx
error: invalid image name "Nginx": invalid reference format
[exit 1]
$ kubectl run web --image=nginx:1.27 --restart=Sometimes
error: invalid restart policy: Sometimes, valid values are: Always, OnFailure, Never
[exit 1]
$ kubectl run web --image=nginx:1.27 --image-pull-policy=Maybe
error: invalid image pull policy: Maybe, valid values are: Always, IfNotPresent, Never
[exit 1]
$ kubectl run web --image=nginx:1.27 --env=1A=b
error: invalid env: 1A=b
[exit 1]
$ kubectl run web --image=nginx:1.27 --labels=app
error: unexpected label spec: app
[exit 1]
$ kubectl run web --image=nginx:1.27 --annotations=note
error: invalid annotations format: note
[exit 1]
$ kubectl run web --image=nginx:1.27 --expose
error: --port must be set when exposing a service
[exit 1]
$ kubectl run web --image=nginx:1.27 --port=http
error: --port must be a number
[exit 1]
$ kubectl run web --image=nginx:1.27 -t
error: -i/--stdin is required for containers with -t/--tty=true
[exit 1]
$ kubectl run web --image=nginx:1.27 -i --dry-run=client
error: --dry-run=[server|client] can't be used with attached containers options (--attach, --stdin, or --tty)
[exit 1]
$ kubectl run web --image=nginx:1.27 --rm
error: --rm should only be used for attached containers
[exit 1]
$ kubectl run web --image=nginx:1.27 --dry-run=maybe
error: Invalid dry-run value (maybe). Must be "none", "server", or "client".
[exit 1]
$ kubectl run web --image=nginx:1.27 --overrides='{"spec":{"containers":"x"}}'
error: json: cannot unmarshal string into Go struct field PodSpec.spec.containers of type []v1.Container
[exit 1]
$ kubectl run web --image=nginx:1.27 --overrides='{bad'
error: Invalid JSON Patch
[exit 1]
$ kubectl run web --image=nginx:1.27 --override-type=patch --overrides='{}'
error: invalid override type: patch
[exit 1]
$ kubectl get pods
No resources found in default namespace.
