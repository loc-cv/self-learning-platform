# kubectl's configuration and connection: a worker has no kubeconfig, so kubectl tries
# localhost:8080; a server nothing listens on is refused; bad names in the kubeconfig.
# machine: node01
# user: root
$ kubectl get pods
E1113 09:00:15.000000    1001 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connect: connection refused"
E1113 09:00:15.000000    1001 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connect: connection refused"
E1113 09:00:15.000000    1001 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connect: connection refused"
E1113 09:00:15.000000    1001 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connect: connection refused"
E1113 09:00:15.000000    1001 memcache.go:381] "Couldn't get current server API group list" err="Get \"http://localhost:8080/api?timeout=32s\": dial tcp [::1]:8080: connect: connection refused"
The connection to the server localhost:8080 was refused - did you specify the right host or port?
[exit 1]
$ kubectl get nodes --server https://172.16.0.10:6443
NAME           STATUS   ROLES           AGE   VERSION
controlplane   Ready    control-plane   15s   v1.37.2
node01         Ready    <none>          15s   v1.37.2
node02         Ready    <none>          15s   v1.37.2
$ kubectl get nodes --kubeconfig /etc/kubernetes/kubelet.conf
NAME           STATUS   ROLES           AGE   VERSION
controlplane   Ready    control-plane   15s   v1.37.2
node01         Ready    <none>          15s   v1.37.2
node02         Ready    <none>          15s   v1.37.2
$ kubectl get nodes --server https://172.16.0.11:6443
E1113 09:00:15.000000    1004 memcache.go:381] "Couldn't get current server API group list" err="Get \"https://172.16.0.11:6443/api?timeout=32s\": dial tcp 172.16.0.11:6443: connect: connection refused"
E1113 09:00:15.000000    1004 memcache.go:381] "Couldn't get current server API group list" err="Get \"https://172.16.0.11:6443/api?timeout=32s\": dial tcp 172.16.0.11:6443: connect: connection refused"
E1113 09:00:15.000000    1004 memcache.go:381] "Couldn't get current server API group list" err="Get \"https://172.16.0.11:6443/api?timeout=32s\": dial tcp 172.16.0.11:6443: connect: connection refused"
E1113 09:00:15.000000    1004 memcache.go:381] "Couldn't get current server API group list" err="Get \"https://172.16.0.11:6443/api?timeout=32s\": dial tcp 172.16.0.11:6443: connect: connection refused"
E1113 09:00:15.000000    1004 memcache.go:381] "Couldn't get current server API group list" err="Get \"https://172.16.0.11:6443/api?timeout=32s\": dial tcp 172.16.0.11:6443: connect: connection refused"
The connection to the server 172.16.0.11:6443 was refused - did you specify the right host or port?
[exit 1]
$ kubectl get nodes --kubeconfig /etc/kubernetes/kubelet.conf --context nosuch
Error in configuration: context was not found for specified context: nosuch
[exit 1]
$ kubectl get nodes --kubeconfig /nonexistent
error: stat /nonexistent: no such file or directory
[exit 1]
$ kubectl get nodes --server https://10.1.2.3:6443
[sim] kubectl: connecting to 10.1.2.3 is not simulated yet
[exit 250]
