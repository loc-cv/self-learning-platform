# kubectl get: several types and names, categories, namespaces, selectors, label columns.
# objects: workloads.yaml
# settle: 30
$ kubectl get all
NAME                       READY   STATUS    RESTARTS   AGE
pod/web-5d66c95fd4-dm95j   1/1     Running   0          30s
pod/web-5d66c95fd4-gssw6   1/1     Running   0          30s

NAME                 TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
service/kubernetes   ClusterIP   10.96.0.1        <none>        443/TCP   35s
service/web          ClusterIP   10.103.161.232   <none>        80/TCP    30s

NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/web   2/2     2            2           30s

NAME                             DESIRED   CURRENT   READY   AGE
replicaset.apps/web-5d66c95fd4   2         2         2       30s
$ kubectl get all -n dev
NAME        READY   STATUS    RESTARTS   AGE
pod/probe   1/1     Running   0          30s
$ kubectl get deploy,svc
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/web   2/2     2            2           30s

NAME                 TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
service/kubernetes   ClusterIP   10.96.0.1        <none>        443/TCP   35s
service/web          ClusterIP   10.103.161.232   <none>        80/TCP    30s
$ kubectl get svc,cm web
NAME   TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
web    ClusterIP   10.103.161.232   <none>        80/TCP    30s
Error from server (NotFound): configmaps "web" not found
[exit 1]
$ kubectl get svc/web cm/app-config
NAME          TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
service/web   ClusterIP   10.103.161.232   <none>        80/TCP    30s

NAME                   DATA   AGE
configmap/app-config   2      30s
$ kubectl get pods -A
NAMESPACE     NAME                                   READY   STATUS    RESTARTS   AGE
default       web-5d66c95fd4-dm95j                   1/1     Running   0          30s
default       web-5d66c95fd4-gssw6                   1/1     Running   0          30s
dev           probe                                  1/1     Running   0          30s
kube-system   coredns-559f6c778d-vr72g               1/1     Running   0          35s
kube-system   coredns-559f6c778d-wvvt9               1/1     Running   0          35s
kube-system   etcd-controlplane                      1/1     Running   0          35s
kube-system   kube-apiserver-controlplane            1/1     Running   0          35s
kube-system   kube-controller-manager-controlplane   1/1     Running   0          35s
kube-system   kube-proxy-ss2p9                       1/1     Running   0          35s
kube-system   kube-proxy-wk7ld                       1/1     Running   0          35s
kube-system   kube-proxy-zvknx                       1/1     Running   0          35s
kube-system   kube-scheduler-controlplane            1/1     Running   0          35s
$ kubectl get pods --all-namespaces -l k8s-app=kube-dns -o wide
NAMESPACE     NAME                       READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
kube-system   coredns-559f6c778d-vr72g   1/1     Running   0          35s   10.244.2.2   node02   <none>           <none>
kube-system   coredns-559f6c778d-wvvt9   1/1     Running   0          35s   10.244.1.2   node01   <none>           <none>
$ kubectl get pods -n dev
NAME    READY   STATUS    RESTARTS   AGE
probe   1/1     Running   0          30s
$ kubectl get po -l app=web
NAME                   READY   STATUS    RESTARTS   AGE
web-5d66c95fd4-dm95j   1/1     Running   0          30s
web-5d66c95fd4-gssw6   1/1     Running   0          30s
$ kubectl get pods -l 'tier in (frontend,backend)' --show-labels
NAME                   READY   STATUS    RESTARTS   AGE   LABELS
web-5d66c95fd4-dm95j   1/1     Running   0          30s   app=web,pod-template-hash=5d66c95fd4,tier=frontend
web-5d66c95fd4-gssw6   1/1     Running   0          30s   app=web,pod-template-hash=5d66c95fd4,tier=frontend
$ kubectl get pods -L app -L tier
NAME                   READY   STATUS    RESTARTS   AGE   APP   TIER
web-5d66c95fd4-dm95j   1/1     Running   0          30s   web   frontend
web-5d66c95fd4-gssw6   1/1     Running   0          30s   web   frontend
$ kubectl get pods --no-headers
web-5d66c95fd4-dm95j   1/1   Running   0     30s
web-5d66c95fd4-gssw6   1/1   Running   0     30s
$ kubectl get pod -n dev probe --show-kind
NAME        READY   STATUS    RESTARTS   AGE
pod/probe   1/1     Running   0          30s
$ kubectl get nodes --field-selector metadata.name=node01
NAME     STATUS   ROLES    AGE   VERSION
node01   Ready    <none>   35s   v1.37.2
$ kubectl get pods -l app=nothing
No resources found in default namespace.
$ kubectl get deployments -A -l app=nothing
No resources found
$ kubectl get nodes -l nothing=here
No resources found
$ kubectl get cm -n nowhere
No resources found in nowhere namespace.
