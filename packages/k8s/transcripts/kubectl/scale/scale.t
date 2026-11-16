# kubectl scale: the scale subresource of Deployments and ReplicaSets, preconditions, several
# objects, selectors and --all, dry runs, waiting with --timeout, and the errors.
# Output lines and errors: fixtures/golden/v1.37.2/change/scale.yaml (the same commands against the
# real kubectl and kube-apiserver); upstream: staging/src/k8s.io/kubectl/pkg/cmd/scale/scale.go
# RunScale, staging/src/k8s.io/kubectl/pkg/scale/scale.go.
% kubectl create deployment web --image=nginx:1.27
% kubectl create deployment api --image=nginx:1.27
% sleep 20
$ kubectl scale deployment web --replicas=3
deployment.apps/web scaled
# The new size goes to the Deployment's spec; the controller creates the Pods.
$ kubectl get deployment web -o yaml | grep '^  replicas'
  replicas: 3
  replicas: 1
$ sleep 10
$ kubectl get deployment web
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    3/3     3            3           30s
# The flag is required, and checked before anything else.
$ kubectl scale deployment web
error: required flag(s) "replicas" not set
[exit 1]
$ kubectl scale deployment web --replicas=-1
error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0
[exit 1]
# Preconditions: the current size (and with --resource-version, the version) must match.
$ kubectl scale deployment/web --replicas=1 --current-replicas=2
error: Expected replicas to be 2, was 3
[exit 1]
$ kubectl scale deployment/web --replicas=1 --current-replicas=3 -o name
deployment.apps/web
$ kubectl scale deploy web api --replicas=2 --resource-version=1
error: cannot use --resource-version with multiple resources
[exit 1]
# Several objects: the ones found are scaled, the missing one is reported at the end.
$ kubectl scale deploy web nope api --replicas=2
deployment.apps/web scaled
deployment.apps/api scaled
Error from server (NotFound): deployments.apps "nope" not found
[exit 1]
$ kubectl scale deploy --all --replicas=1 --dry-run=client
deployment.apps/api scaled (dry run)
deployment.apps/web scaled (dry run)
$ kubectl scale deploy --all --replicas=1 --dry-run=server -o name
deployment.apps/api
deployment.apps/web
$ kubectl scale deploy -l app=none --replicas=1
error: no objects passed to scale
[exit 1]
$ kubectl scale deploy --replicas=1
error: resource(s) were provided, but no name was specified
[exit 1]
# --timeout waits, in virtual time, until the replicas are there.
$ kubectl scale deployment web --replicas=4 --timeout=60s
deployment.apps/web scaled
$ kubectl get deployment web
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    4/4     4            4           31s
# Pods have no scale subresource.
$ kubectl scale pod --all --replicas=1
Error from server (NotFound): the server could not find the requested resource
[exit 1]
