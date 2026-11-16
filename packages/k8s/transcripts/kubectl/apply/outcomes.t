# kubectl apply's three outcomes, the three-way merge, the warning for an object kubectl create made.
# file: app.yaml
# file: app-v2.yaml
# file: settings.yaml
# file: more.yaml
# settle: 0
# Texts from the golden fixtures apply/created-configured-unchanged, apply/three-way and
# apply/overwrite (fixtures/golden/v1.37.2); objects and values from the simulated cluster.
# The first apply creates the Deployment with the last-applied-configuration annotation.
$ kubectl apply -f app.yaml
deployment.apps/app created
$ kubectl apply -f app.yaml
deployment.apps/app unchanged
% sleep 5
# app-v2.yaml drops the owner label, the DEBUG variable and the https port: the three-way merge
# removes from the object what the last applied configuration had and the manifest no longer has.
$ kubectl apply -f app-v2.yaml
deployment.apps/app configured
% sleep 10
$ kubectl get deployment app -o yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    deployment.kubernetes.io/revision: "2"
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"apps/v1","kind":"Deployment","metadata":{"annotations":{},"labels":{"app":"app"},"name":"app","namespace":"default"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"app"}},"template":{"metadata":{"labels":{"app":"app"}},"spec":{"containers":[{"env":[{"name":"MODE","value":"staging"}],"image":"nginx:1.31.8","name":"web","ports":[{"containerPort":80,"name":"http"}]}]}}}}
  creationTimestamp: "2026-11-13T09:00:05Z"
  generation: 2
  labels:
    app: app
  name: app
  namespace: default
  resourceVersion: "163"
  uid: e46ac816-4b06-467c-b0b8-f2e459491af4
spec:
  progressDeadlineSeconds: 600
  replicas: 1
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: app
  strategy:
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
      - env:
        - name: MODE
          value: staging
        image: nginx:1.31.8
        imagePullPolicy: IfNotPresent
        name: web
        ports:
        - containerPort: 80
          name: http
          protocol: TCP
        resources: {}
        terminationMessagePath: /dev/termination-log
        terminationMessagePolicy: File
      dnsPolicy: ClusterFirst
      restartPolicy: Always
      schedulerName: default-scheduler
      securityContext: {}
      terminationGracePeriodSeconds: 30
status:
  availableReplicas: 1
  conditions:
  - lastTransitionTime: "2026-11-13T09:00:08Z"
    lastUpdateTime: "2026-11-13T09:00:08Z"
    message: Deployment has minimum availability.
    reason: MinimumReplicasAvailable
    status: "True"
    type: Available
  - lastTransitionTime: "2026-11-13T09:00:05Z"
    lastUpdateTime: "2026-11-13T09:00:14Z"
    message: ReplicaSet "app-794db6857" has successfully progressed.
    reason: NewReplicaSetAvailable
    status: "True"
    type: Progressing
  observedGeneration: 2
  readyReplicas: 1
  replicas: 1
  terminatingReplicas: 0
  updatedReplicas: 1
# An object kubectl create made has no annotation: apply warns, then records it.
% kubectl create -f settings.yaml
$ kubectl apply -f settings.yaml
Warning: resource configmaps/settings is missing the kubectl.kubernetes.io/last-applied-configuration annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.
configmap/settings configured
$ kubectl apply -f settings.yaml
configmap/settings unchanged
# Dry runs: computed locally (client) or by the server without persisting (server).
$ kubectl apply -f app.yaml --dry-run=client
deployment.apps/app configured (dry run)
$ kubectl apply -f app.yaml --dry-run=server -o name
deployment.apps/app
$ kubectl apply -f app-v2.yaml
deployment.apps/app unchanged
# -o prints the objects at the end; several are one List.
$ kubectl apply -f settings.yaml -f more.yaml -o json
{
    "kind": "List",
    "apiVersion": "v1",
    "metadata": {},
    "items": [
        {
            "apiVersion": "v1",
            "data": {
                "LOG_LEVEL": "info"
            },
            "kind": "ConfigMap",
            "metadata": {
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"v1\",\"data\":{\"LOG_LEVEL\":\"info\"},\"kind\":\"ConfigMap\",\"metadata\":{\"annotations\":{},\"name\":\"settings\",\"namespace\":\"default\"}}\n"
                },
                "creationTimestamp": "2026-11-13T09:00:20Z",
                "name": "settings",
                "namespace": "default",
                "resourceVersion": "165",
                "uid": "065e574b-b2ba-4bce-bab1-d9b8103e8c39"
            }
        },
        {
            "apiVersion": "v1",
            "data": {
                "a": "1"
            },
            "kind": "ConfigMap",
            "metadata": {
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"v1\",\"data\":{\"a\":\"1\"},\"kind\":\"ConfigMap\",\"metadata\":{\"annotations\":{},\"name\":\"more\",\"namespace\":\"default\"}}\n"
                },
                "creationTimestamp": "2026-11-13T09:00:20Z",
                "name": "more",
                "namespace": "default",
                "resourceVersion": "166",
                "uid": "d370249b-5f73-41a2-9ddc-0a79c09fe07f"
            }
        }
    ]
}
$ kubectl apply -f more.yaml -o name
configmap/more
