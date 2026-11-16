# kubectl delete of Pods: waiting through the grace period (the default), --grace-period, --now,
# --wait=false, forced deletion and its warning, --timeout, -o name, a client dry run, not found
# and --ignore-not-found, --all. The containers run `sleep` as PID 1, which ignores SIGTERM, so the
# kubelet kills them when the grace period ends. Output lines and errors:
# fixtures/golden/v1.37.2/delete/{options,errors,cascade}.yaml; the warning is yellow on a
# terminal (cli-runtime/pkg/printers/warningprinter.go, terminal.go AllowsColorOutput).
# file: pods.yaml
# settle: 0
% kubectl create -f pods.yaml
% sleep 30
$ date +%T
09:00:35
$ kubectl delete pod a
pod "a" deleted from default namespace
$ date +%T
09:01:05
# --wait=false returns at once; the Pod is Terminating.
$ kubectl delete pod b --wait=false
pod "b" deleted from default namespace
$ kubectl get pod b
NAME   READY   STATUS        RESTARTS   AGE
b      1/1     Terminating   0          60s
$ kubectl delete pod c --grace-period=5
pod "c" deleted from default namespace
$ date +%T
09:01:10
$ kubectl delete pod d --now
pod "d" deleted from default namespace
$ date +%T
09:01:12
# Forced: the Pod is removed from the API at once, without waiting for the kubelet.
$ kubectl delete pod e --force --grace-period=0
[33;1mWarning:[0m Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.
pod "e" force deleted from default namespace
$ kubectl get pod e
Error from server (NotFound): pods "e" not found
[exit 1]
$ kubectl delete pod f --timeout=10s
pod "f" deleted from default namespace
error: timed out waiting for the condition on pods/f
[exit 1]
$ kubectl delete pod f -o name
pod/f
$ kubectl get pod f
Error from server (NotFound): pods "f" not found
[exit 1]
$ kubectl delete pod nope
Error from server (NotFound): pods "nope" not found
[exit 1]
$ kubectl delete pod nope --ignore-not-found
$ kubectl delete pod nope --dry-run=client
pod "nope" deleted from default namespace (dry run)
$ kubectl delete pods --all
pod "g" deleted from default namespace
pod "h" deleted from default namespace
$ date +%T
09:02:12
$ kubectl delete pods --all
No resources found
