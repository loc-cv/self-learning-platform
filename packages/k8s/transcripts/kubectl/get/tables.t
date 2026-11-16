# kubectl get: the table of each kind, plain and with -o wide.
# file: workloads.yaml
# settle: 0
# Server-side Tables (packages/k8s/src/printers) printed by kubectl's table printer; layouts as in
# the golden fixtures (fixtures/golden/v1.37.2), values from the simulated cluster.
% kubectl create -f workloads.yaml
% sleep 30
$ kubectl get pods
NAME                   READY   STATUS    RESTARTS   AGE
web-5d66c95fd4-dm95j   1/1     Running   0          30s
web-5d66c95fd4-gssw6   1/1     Running   0          30s
$ kubectl get pods -o wide
NAME                   READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
web-5d66c95fd4-dm95j   1/1     Running   0          30s   10.244.1.3   node01   <none>           <none>
web-5d66c95fd4-gssw6   1/1     Running   0          30s   10.244.2.3   node02   <none>           <none>
$ kubectl get deployments
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    2/2     2            2           30s
$ kubectl get deploy -o wide
NAME   READY   UP-TO-DATE   AVAILABLE   AGE   CONTAINERS   IMAGES         SELECTOR
web    2/2     2            2           30s   nginx        nginx:1.31.8   app=web
$ kubectl get rs
NAME             DESIRED   CURRENT   READY   AGE
web-5d66c95fd4   2         2         2       30s
$ kubectl get rs -o wide
NAME             DESIRED   CURRENT   READY   AGE   CONTAINERS   IMAGES         SELECTOR
web-5d66c95fd4   2         2         2       30s   nginx        nginx:1.31.8   app=web,pod-template-hash=5d66c95fd4
$ kubectl get services
NAME         TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1        <none>        443/TCP   35s
web          ClusterIP   10.103.161.232   <none>        80/TCP    30s
$ kubectl get svc -o wide
NAME         TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE   SELECTOR
kubernetes   ClusterIP   10.96.0.1        <none>        443/TCP   35s   <none>
web          ClusterIP   10.103.161.232   <none>        80/TCP    30s   app=web
$ kubectl get nodes
NAME           STATUS   ROLES           AGE   VERSION
controlplane   Ready    control-plane   35s   v1.37.2
node01         Ready    <none>          35s   v1.37.2
node02         Ready    <none>          35s   v1.37.2
$ kubectl get nodes -o wide
NAME           STATUS   ROLES           AGE   VERSION   INTERNAL-IP   EXTERNAL-IP   OS-IMAGE             KERNEL-VERSION             CONTAINER-RUNTIME
controlplane   Ready    control-plane   35s   v1.37.2   172.16.0.10   <none>        Ubuntu 24.04.3 LTS   6.8.0-88-generic (amd64)   containerd://1.7.28
node01         Ready    <none>          35s   v1.37.2   172.16.0.11   <none>        Ubuntu 24.04.3 LTS   6.8.0-88-generic (amd64)   containerd://1.7.28
node02         Ready    <none>          35s   v1.37.2   172.16.0.12   <none>        Ubuntu 24.04.3 LTS   6.8.0-88-generic (amd64)   containerd://1.7.28
$ kubectl get namespaces
NAME              STATUS   AGE
default           Active   35s
dev               Active   30s
kube-node-lease   Active   35s
kube-public       Active   35s
kube-system       Active   35s
$ kubectl get configmaps
NAME         DATA   AGE
app-config   2      30s
$ kubectl get secrets
NAME    TYPE     DATA   AGE
creds   Opaque   1      30s
$ kubectl get secrets -o wide
NAME    TYPE     DATA   AGE
creds   Opaque   1      30s
$ kubectl get serviceaccounts
NAME      AGE
default   35s
$ kubectl get endpoints
[33;1mWarning:[0m v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice
NAME         ENDPOINTS                     AGE
kubernetes   172.16.0.10:6443              35s
web          10.244.1.3:80,10.244.2.3:80   30s
$ kubectl get endpointslices
NAME         ADDRESSTYPE   PORTS   ENDPOINTS               AGE
kubernetes   IPv4          6443    172.16.0.10             35s
web-2xwvh    IPv4          80      10.244.2.3,10.244.1.3   30s
$ kubectl get events --field-selector involvedObject.kind=Deployment
LAST SEEN   TYPE     REASON              OBJECT           MESSAGE
30s         Normal   ScalingReplicaSet   deployment/web   Scaled up replica set web-5d66c95fd4 from 0 to 2
$ kubectl get events --field-selector involvedObject.kind=Deployment -o wide
LAST SEEN   TYPE     REASON              OBJECT           SUBOBJECT   SOURCE                  MESSAGE                                            FIRST SEEN   COUNT   NAME
30s         Normal   ScalingReplicaSet   deployment/web               deployment-controller   Scaled up replica set web-5d66c95fd4 from 0 to 2   30s          1       web.18e78f2e2c4ddd40
$ kubectl get daemonsets -n kube-system
NAME         DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR            AGE
kube-proxy   3         3         3       3            3           kubernetes.io/os=linux   35s
