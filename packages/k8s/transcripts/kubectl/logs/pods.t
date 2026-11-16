# kubectl logs of Pods as the behavior models write their output: nginx's startup lines, a script
# that crash-loops (the current and the --previous instance), tail, the byte limit, timestamps
# (RFC3339NanoFixed: nine fractional digits, cut out here), since and since-time; a multi-container
# Pod (the defaulted container and its message, -c, the inline container argument,
# --all-containers with --prefix); a Deployment (the first Pod in kubectl's logging order and
# "Found N pods"), a selector (its default tail of 10, --prefix, --all-pods, --max-log-requests);
# and the kubelet's errors for a container that is not running yet. Source-derived:
# staging/src/k8s.io/kubectl/pkg/cmd/logs/logs.go, polymorphichelpers/logsforobject.go,
# pkg/kubelet/kubelet_pods.go validateContainerLogStatus, staging/src/k8s.io/cri-client/pkg/logs;
# the client-side errors and messages are compared with the oracle in
# fixtures/golden/v1.37.2/logs/before-the-kubelet.yaml. The order of several requests is a Go
# map's (kubectl ranges over a map): the simulator draws it from a named PRNG stream.
# file: pods.yaml
# file: workloads.yaml
# settle: 0
% kubectl create -f pods.yaml
% kubectl create -f workloads.yaml
% sleep 2
# Scheduled, not started: the kubelet says why there is no log yet.
$ kubectl logs crash
Error from server (BadRequest): container "app" in pod "crash" is waiting to start: ContainerCreating
[exit 1]
% sleep 58
$ kubectl logs web
/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration
/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/
/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh
10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf
10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf
/docker-entrypoint.sh: Sourcing /docker-entrypoint.d/15-local-resolvers.envsh
/docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh
/docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh
/docker-entrypoint.sh: Configuration complete; ready for start up
2026/11/13 09:00:09 [notice] 1#1: using the "epoll" event method
2026/11/13 09:00:09 [notice] 1#1: nginx/1.31.8
2026/11/13 09:00:09 [notice] 1#1: built by gcc 14.2.0 (Debian 14.2.0-19) 
2026/11/13 09:00:09 [notice] 1#1: OS: Linux 6.8.0-88-generic
2026/11/13 09:00:09 [notice] 1#1: getrlimit(RLIMIT_NOFILE): 1048576:1048576
2026/11/13 09:00:09 [notice] 1#1: start worker processes
2026/11/13 09:00:09 [notice] 1#1: start worker process 24
2026/11/13 09:00:09 [notice] 1#1: start worker process 25
$ kubectl logs web --tail=3
2026/11/13 09:00:09 [notice] 1#1: start worker processes
2026/11/13 09:00:09 [notice] 1#1: start worker process 24
2026/11/13 09:00:09 [notice] 1#1: start worker process 25
$ kubectl logs clock --timestamps --tail=2 | cut -c1-19,30-
2026-11-13T09:00:46Z tick 5
2026-11-13T09:00:56Z tick 6
$ kubectl logs web --limit-bytes=40
/docker-entrypoint.sh: /docker-entrypoin (no-eol)
$ kubectl logs web --since=10s
$ kubectl logs clock --since=25s
tick 5
tick 6
$ kubectl logs clock --since-time=2026-11-13T09:00:30Z
tick 4
tick 5
tick 6
$ kubectl logs crash
starting
cannot open /etc/app.conf
$ kubectl logs crash --previous
starting
cannot open /etc/app.conf
$ kubectl logs -f crash
starting
cannot open /etc/app.conf
$ kubectl logs web --previous
Error from server (BadRequest): previous terminated container "nginx" in pod "web" not found
[exit 1]
$ kubectl logs typo
Error from server (BadRequest): container "app" in pod "typo" is waiting to start: image can't be pulled
[exit 1]
$ kubectl logs pair
Defaulted container "main" out of: main, helper
main up
$ kubectl logs pair -c helper
helper up
$ kubectl logs pair helper
helper up
$ kubectl logs pair --all-containers --prefix
[pod/pair/main] main up
[pod/pair/helper] helper up
$ kubectl logs pair -c nope
error: container nope is not valid for pod pair out of: main, helper
[exit 1]
$ kubectl logs deploy/api
Found 3 pods, using pod/api-866b49bb86-gssw6
serving on api-866b49bb86-gssw6
$ kubectl logs -l app=api --prefix
[pod/api-866b49bb86-2xwvh/api] serving on api-866b49bb86-2xwvh
[pod/api-866b49bb86-dm95j/api] serving on api-866b49bb86-dm95j
[pod/api-866b49bb86-gssw6/api] serving on api-866b49bb86-gssw6
$ kubectl logs deploy/api --all-pods
[pod/api-866b49bb86-gssw6/api] serving on api-866b49bb86-gssw6
[pod/api-866b49bb86-2xwvh/api] serving on api-866b49bb86-2xwvh
[pod/api-866b49bb86-dm95j/api] serving on api-866b49bb86-dm95j
$ kubectl logs -l app=api -f --max-log-requests=2
error: you are attempting to follow 3 log streams, but maximum allowed concurrency is 2, use --max-log-requests to increase the limit
[exit 1]
