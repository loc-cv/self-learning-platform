# kubectl delete --cascade=foreground: the owner gets the foregroundDeletion finalizer and stays
# until the garbage collector has deleted its dependents, so kubectl's wait (the default) lasts as
# long as the Pods' grace period: 30 s here, because `sleep` as PID 1 ignores SIGTERM.
# upstream: staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go DeleteResult;
# staging/src/k8s.io/kubectl/pkg/cmd/wait/delete.go IsDeleted.
# file: workloads.yaml
# settle: 0
% kubectl create -f workloads.yaml
% sleep 30
$ date +%T
09:00:35
$ kubectl delete deployment slow --cascade=foreground
deployment.apps "slow" deleted from default namespace
$ date +%T
09:01:05
$ kubectl get deployments,rs,pods -l app=slow
No resources found in default namespace.
# --wait=false returns at once: the Deployment is still there, being deleted.
$ kubectl delete deployment web --cascade=foreground --wait=false
deployment.apps "web" deleted from default namespace
$ kubectl get deployment web -o yaml | grep -A1 finalizers
  finalizers:
  - foregroundDeletion
$ sleep 2
$ kubectl get deployment web
Error from server (NotFound): deployments.apps "web" not found
[exit 1]
