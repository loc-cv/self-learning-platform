# kubectl create -f: files, several documents, standard input, JSON, directories and output formats.
# file: web.yaml
# file: list.json
# file: conf/app.yaml
# file: conf/notes.txt
# file: conf/extra/flags.json
# settle: 0
# Texts from the golden fixture create/from-files (fixtures/golden/v1.37.2); objects from the
# simulated cluster.
$ kubectl create -f web.yaml
deployment.apps/web created
service/web created
% sleep 20
$ kubectl get deployment,service web
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/web   2/2     2            2           20s

NAME          TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)   AGE
service/web   ClusterIP   10.103.161.232   <none>        80/TCP    20s
$ kubectl create -f - <<EOF
> apiVersion: v1
> kind: ConfigMap
> metadata:
>   name: typed
> data:
>   k: v
> EOF
configmap/typed created
$ kubectl create -f list.json -o name
configmap/one
configmap/two
# A directory: its .json, .yaml and .yml files in name order; -R descends into subdirectories.
$ kubectl create -f conf --dry-run=client
configmap/app created (dry run)
$ kubectl create -f conf -R
configmap/app created
configmap/flags created
$ kubectl create -f web.yaml --dry-run=server -o yaml -l app=nothing
error: no objects passed to create
[exit 1]
$ kubectl create -f - -o yaml --save-config <<EOF
> apiVersion: v1
> kind: ConfigMap
> metadata:
>   name: saved
> EOF
apiVersion: v1
kind: ConfigMap
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"v1","kind":"ConfigMap","metadata":{"annotations":{},"name":"saved","namespace":"default"}}
  creationTimestamp: "2026-11-13T09:00:25Z"
  name: saved
  namespace: default
  resourceVersion: "158"
  uid: bf99aec1-e65b-4990-856b-9987f26eb2ab
