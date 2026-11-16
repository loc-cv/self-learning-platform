# kubectl get -o yaml, -o json and -o name: one object alone, several in a List.
# objects: workloads.yaml
# settle: 30
$ kubectl get cm app-config -o yaml
apiVersion: v1
data:
  LOG_LEVEL: debug
  mode: "1"
kind: ConfigMap
metadata:
  creationTimestamp: "2026-11-13T09:00:05Z"
  name: app-config
  namespace: default
  resourceVersion: "110"
  uid: 9f11e4b3-dab4-49cd-b435-32ec6d0dfea6
$ kubectl get cm app-config -o json
{
    "apiVersion": "v1",
    "data": {
        "LOG_LEVEL": "debug",
        "mode": "1"
    },
    "kind": "ConfigMap",
    "metadata": {
        "creationTimestamp": "2026-11-13T09:00:05Z",
        "name": "app-config",
        "namespace": "default",
        "resourceVersion": "110",
        "uid": "9f11e4b3-dab4-49cd-b435-32ec6d0dfea6"
    }
}
$ kubectl get secret creds -o yaml
apiVersion: v1
data:
  user: YWRtaW4=
kind: Secret
metadata:
  creationTimestamp: "2026-11-13T09:00:05Z"
  name: creds
  namespace: default
  resourceVersion: "111"
  uid: 42ea6e7e-0567-4902-9302-d8302d1b759a
type: Opaque
$ kubectl get svc web -o yaml
apiVersion: v1
kind: Service
metadata:
  creationTimestamp: "2026-11-13T09:00:05Z"
  name: web
  namespace: default
  resourceVersion: "109"
  uid: e3d19690-7c09-4a3c-bde6-41db6f775cbd
spec:
  clusterIP: 10.103.161.232
  clusterIPs:
  - 10.103.161.232
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ipFamilyPolicy: SingleStack
  ports:
  - port: 80
    protocol: TCP
    targetPort: 80
  selector:
    app: web
  sessionAffinity: None
  type: ClusterIP
status:
  loadBalancer: {}
$ kubectl get ns dev -o json
{
    "apiVersion": "v1",
    "kind": "Namespace",
    "metadata": {
        "creationTimestamp": "2026-11-13T09:00:05Z",
        "labels": {
            "kubernetes.io/metadata.name": "dev"
        },
        "name": "dev",
        "resourceVersion": "112",
        "uid": "a339b3f3-0fb9-45a5-b016-0cb38e4d0f15"
    },
    "spec": {
        "finalizers": [
            "kubernetes"
        ]
    },
    "status": {
        "phase": "Active"
    }
}
$ kubectl get deployment web -o yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    deployment.kubernetes.io/revision: "1"
  creationTimestamp: "2026-11-13T09:00:05Z"
  generation: 1
  labels:
    app: web
  name: web
  namespace: default
  resourceVersion: "159"
  uid: e46ac816-4b06-467c-b0b8-f2e459491af4
spec:
  progressDeadlineSeconds: 600
  replicas: 2
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: web
  strategy:
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: web
        tier: frontend
    spec:
      containers:
      - image: nginx:1.31.8
        imagePullPolicy: IfNotPresent
        name: nginx
        ports:
        - containerPort: 80
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
  availableReplicas: 2
  conditions:
  - lastTransitionTime: "2026-11-13T09:00:09Z"
    lastUpdateTime: "2026-11-13T09:00:09Z"
    message: Deployment has minimum availability.
    reason: MinimumReplicasAvailable
    status: "True"
    type: Available
  - lastTransitionTime: "2026-11-13T09:00:05Z"
    lastUpdateTime: "2026-11-13T09:00:09Z"
    message: ReplicaSet "web-5d66c95fd4" has successfully progressed.
    reason: NewReplicaSetAvailable
    status: "True"
    type: Progressing
  observedGeneration: 1
  readyReplicas: 2
  replicas: 2
  terminatingReplicas: 0
  updatedReplicas: 2
$ kubectl get cm app-config nothing -o yaml
apiVersion: v1
items:
- apiVersion: v1
  data:
    LOG_LEVEL: debug
    mode: "1"
  kind: ConfigMap
  metadata:
    creationTimestamp: "2026-11-13T09:00:05Z"
    name: app-config
    namespace: default
    resourceVersion: "110"
    uid: 9f11e4b3-dab4-49cd-b435-32ec6d0dfea6
kind: List
metadata:
  resourceVersion: ""
Error from server (NotFound): configmaps "nothing" not found
[exit 1]
$ kubectl get sa -n dev -o json
{
    "apiVersion": "v1",
    "items": [
        {
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": {
                "creationTimestamp": "2026-11-13T09:00:05Z",
                "name": "default",
                "namespace": "dev",
                "resourceVersion": "119",
                "uid": "5fe28f44-929c-4908-81ab-88e627f80ad9"
            }
        }
    ],
    "kind": "List",
    "metadata": {
        "resourceVersion": ""
    }
}
$ kubectl get pods -o name
pod/web-5d66c95fd4-dm95j
pod/web-5d66c95fd4-gssw6
$ kubectl get deploy,rs,svc -o name
deployment.apps/web
replicaset.apps/web-5d66c95fd4
service/kubernetes
service/web
$ kubectl get nodes -o name
node/controlplane
node/node01
node/node02
$ kubectl get cm -n nowhere -o yaml
apiVersion: v1
items: []
kind: List
metadata:
  resourceVersion: ""
