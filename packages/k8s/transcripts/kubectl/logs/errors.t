# kubectl logs when there is no log to read yet: the kubelet's answers for a container waiting to
# start (ContainerCreating, a failed pull, the pull back-off), -f retrying them every second until
# the container runs or --pod-running-timeout passes ("context deadline exceeded"), --ignore-errors
# (the error goes to standard output and the command succeeds), --previous with no previous
# instance, and a workload with no Pods (GetPodList's watch times out). Source-derived:
# pkg/kubelet/kubelet_pods.go validateContainerLogStatus; staging/src/k8s.io/kubectl/pkg/cmd/logs/
# logs.go consumeWithRetry (wait.PollUntilContextTimeout, 1 s, immediate);
# staging/src/k8s.io/kubectl/pkg/polymorphichelpers/helpers.go GetPodList; the API server passes the
# kubelet's 400 on as a BadRequest (apiserver/pkg/registry/generic/rest/response_checker.go).
# file: waiting.yaml
# settle: 0
% kubectl create -f waiting.yaml
% sleep 1
$ kubectl logs typo
Error from server (BadRequest): container "app" in pod "typo" is waiting to start: ContainerCreating
[exit 1]
$ kubectl logs typo --ignore-errors
error: container "app" in pod "typo" is waiting to start: ContainerCreating
# -f retries until the container runs, then streams until it exits (restartPolicy: Never).
$ kubectl logs -f once
container "app" in pod "once" is waiting to start: ContainerCreating
container "app" in pod "once" is waiting to start: ContainerCreating
working
finished
$ kubectl logs once --previous
Error from server (BadRequest): previous terminated container "app" in pod "once" not found
[exit 1]
% sleep 35
$ kubectl get pod typo
NAME   READY   STATUS             RESTARTS   AGE
typo   0/1     ImagePullBackOff   0          41s
$ kubectl logs typo
Error from server (BadRequest): container "app" in pod "typo" is waiting to start: trying and failing to pull image
[exit 1]
$ kubectl logs typo -f --pod-running-timeout=3s
container "app" in pod "typo" is waiting to start: trying and failing to pull image
container "app" in pod "typo" is waiting to start: trying and failing to pull image
container "app" in pod "typo" is waiting to start: trying and failing to pull image
error: context deadline exceeded
[exit 1]
$ kubectl logs deploy/idle --pod-running-timeout=2s
error: timed out waiting for the condition
[exit 1]
$ date +%T
09:00:51
