# kubectl delete of objects with dependents, with the simulated kubelet stopping containers and
# honoring grace periods. Background (the default): the Deployment goes at once and kubectl returns;
# the garbage collector then deletes the ReplicaSet and its Pods, which take their grace period
# (nginx stops on SIGTERM, `sleep` as PID 1 ignores it and is killed after 30 s). Orphan: the
# ReplicaSet and Pods stay and lose their owner reference. Foreground: the owner stays until its
# dependents are gone, and kubectl waits for it.
# Output lines: fixtures/golden/v1.37.2/delete/cascade.yaml; upstream:
# staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go PrintObj, DeleteResult (the wait).
# file: workloads.yaml
# settle: 0
% kubectl create -f workloads.yaml
% sleep 30
$ kubectl get deployments,rs -l app
NAME                   READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/keep   1/1     1            1           30s
deployment.apps/slow   2/2     2            2           30s
deployment.apps/web    2/2     2            2           30s

NAME                              DESIRED   CURRENT   READY   AGE
replicaset.apps/keep-547744bfb6   1         1         1       30s
replicaset.apps/slow-78b9f5bb7d   2         2         2       30s
replicaset.apps/web-74478f6647    2         2         2       30s
# Background: kubectl waits only for the Deployment itself.
$ kubectl delete deployment web
deployment.apps "web" deleted from default namespace
$ date +%T
09:00:35
$ sleep 1
$ kubectl get rs,pods -l app=web
No resources found in default namespace.
# Pods that ignore SIGTERM stay Terminating for their grace period.
$ kubectl delete deployment slow
deployment.apps "slow" deleted from default namespace
$ sleep 1
$ kubectl get rs,pods -l app=slow
NAME                        READY   STATUS        RESTARTS   AGE
pod/slow-78b9f5bb7d-2fgwm   1/1     Terminating   0          32s
pod/slow-78b9f5bb7d-gssw6   1/1     Terminating   0          32s
$ sleep 30
$ kubectl get rs,pods -l app=slow
No resources found in default namespace.
# Orphan: the dependents stay, without their owner reference.
$ kubectl delete deployment keep --cascade=orphan
deployment.apps "keep" deleted from default namespace
$ kubectl get deployments,rs,pods -l app=keep
NAME                              DESIRED   CURRENT   READY   AGE
replicaset.apps/keep-547744bfb6   1         1         1       62s

NAME                        READY   STATUS    RESTARTS   AGE
pod/keep-547744bfb6-j4cbs   1/1     Running   0          62s
$ kubectl get rs -l app=keep -o yaml | grep -c ownerReferences
0
[exit 1]
