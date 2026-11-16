# kubectl config: switching and editing contexts in kubeadm's ~/.kube/config, and what the next
# command reads from it. Texts: fixtures/golden/v1.37.2/config/contexts.yaml.
# file: team.yaml
$ kubectl config get-contexts
CURRENT   NAME                          CLUSTER      AUTHINFO           NAMESPACE
*         kubernetes-admin@kubernetes   kubernetes   kubernetes-admin   
$ kubectl config current-context
kubernetes-admin@kubernetes
$ kubectl config set-context --current --namespace=kube-system
Context "kubernetes-admin@kubernetes" modified.
$ kubectl get services
NAME       TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)                  AGE
kube-dns   ClusterIP   10.96.0.10   <none>        53/UDP,53/TCP,9153/TCP   15s
$ kubectl config set-context dev --cluster=kubernetes --user=kubernetes-admin -n default
Context "dev" created.
$ kubectl config use-context dev
Switched to context "dev".
$ kubectl get services
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   15s
$ cat ~/.kube/config
apiVersion: v1
clusters:
- cluster:
    server: https://172.16.0.10:6443
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    namespace: default
    user: kubernetes-admin
  name: dev
- context:
    cluster: kubernetes
    namespace: kube-system
    user: kubernetes-admin
  name: kubernetes-admin@kubernetes
current-context: dev
kind: Config
users:
- name: kubernetes-admin
  user: {}
$ kubectl config get-contexts
CURRENT   NAME                          CLUSTER      AUTHINFO           NAMESPACE
*         dev                           kubernetes   kubernetes-admin   default
          kubernetes-admin@kubernetes   kubernetes   kubernetes-admin   kube-system
$ kubectl config use-context nope
error: no context exists with the name: "nope"
[exit 1]
# The command's help goes to standard output first.
$ kubectl config set-context dev other >/dev/null
error: Unexpected args: [dev other]
[exit 1]
# Deleting the current context leaves current-context naming it.
$ kubectl config delete-context dev
warning: this removed your active context, use "kubectl config use-context" to select a different one
deleted context dev from /root/.kube/config
$ kubectl get services
Error in configuration: context was not found for specified context: dev
[exit 1]
$ kubectl config use-context kubernetes-admin@kubernetes
Switched to context "kubernetes-admin@kubernetes".
# A second file in KUBECONFIG: a change goes to the file that holds the context, the current
# context to the first file that exists.
$ cp ~/.kube/config ~/.kube/admin.conf
$ export KUBECONFIG=/root/.kube/admin.conf:/root/team.yaml
$ kubectl config get-contexts
CURRENT   NAME                          CLUSTER      AUTHINFO           NAMESPACE
          dev@staging                   staging      dev                team-a
*         kubernetes-admin@kubernetes   kubernetes   kubernetes-admin   kube-system
$ kubectl config set-context dev@staging --namespace=team-b
Context "dev@staging" modified.
$ kubectl config use-context dev@staging
Switched to context "dev@staging".
$ grep current-context ~/.kube/admin.conf team.yaml
/root/.kube/admin.conf:current-context: dev@staging
team.yaml:current-context: ""
$ grep namespace team.yaml
    namespace: team-b
$ unset KUBECONFIG
# A file kubectl creates is private to its owner.
$ kubectl config set-context scratch --kubeconfig new/scratch.conf
Context "scratch" created.
$ ls -l new/scratch.conf | cut -d' ' -f1
-rw-------
$ touch ~/.kube/config.lock
$ kubectl config use-context kubernetes-admin@kubernetes
error: open /root/.kube/config.lock: file exists
[exit 1]
