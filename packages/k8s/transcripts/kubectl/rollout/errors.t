# kubectl rollout's errors: no resource, a revision that does not exist, a running revision other
# than the one asked for, kinds without a status viewer, history viewer or rollbacker, objects that
# cannot be paused, a missing object, an empty selection, a Deployment with one revision only.
# Texts from the golden fixtures rollout/history-undo, rollout/pause-restart and
# rollout/status-output (fixtures/golden/v1.37.2).
# file: web-1.yaml
% kubectl apply -f web-1.yaml
% kubectl rollout status deployment/web
$ kubectl rollout status
error: required resource not specified
[exit 1]
$ kubectl rollout history
error: required resource not specified
[exit 1]
$ kubectl rollout status deployment/web --revision=2
error: desired revision (2) is different from the running revision (1)
[exit 1]
$ kubectl rollout status deployment/web --revision=-1
error: revision must be a positive integer: -1
[exit 1]
$ kubectl rollout history deployment/web --revision=2
error: unable to find the specified revision
[exit 1]
$ kubectl rollout undo deployment/web
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
error: no rollout history found for deployment "web"
[exit 1]
$ kubectl rollout undo deployment/web --to-revision=2
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
error: unable to find specified revision 2 in history
[exit 1]
$ kubectl rollout undo deployment/web --to-revision=1
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
deployment.apps/web skipped rollback (current template already matches revision 1)
$ kubectl rollout status service/kubernetes
error: no status viewer has been implemented for Service
[exit 1]
$ kubectl rollout history service/kubernetes
error: error retrieving history for "Service", no visitor method exists for { Service}
[exit 1]
$ kubectl rollout undo rs -l app=web
error: no rollbacker has been implemented for "ReplicaSet.apps"
[exit 1]
$ kubectl rollout pause service/kubernetes
error: services "kubernetes" pausing is not supported
[exit 1]
$ kubectl rollout restart deployment/nope
Error from server (NotFound): deployments.apps "nope" not found
[exit 1]
$ kubectl rollout status deployment/web -n nowhere
Error from server (NotFound): namespaces "nowhere" not found
[exit 1]
$ kubectl rollout resume deployment -l app=nothing
No resources found in default namespace.
$ kubectl rollout history deployment/web -o wide
error: unable to match a printer suitable for the output format "wide", allowed formats are: go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,kyaml,name,template,templatefile,yaml
[exit 1]
$ kubectl rollout undo deployment/web --dry-run=maybe
error: Invalid dry-run value (maybe). Must be "none", "server", or "client".
[exit 1]
