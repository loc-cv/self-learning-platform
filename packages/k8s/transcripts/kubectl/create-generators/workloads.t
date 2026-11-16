# kubectl create deployment and create namespace: generated manifests (--dry-run=client -o yaml)
# written to a file, edited and applied; real creates, server dry runs, -n, --save-config, and the
# API server's errors behind each command's prefix.
# settle: 0
# Texts from the golden fixtures generate/client, generate/create and client/generators
# (fixtures/golden/v1.37.2); objects from the simulated cluster.
$ kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80 --dry-run=client -o yaml > web.yaml
$ cat web.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  strategy: {}
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - image: nginx:1.27
        name: nginx
        ports:
        - containerPort: 80
        resources: {}
status: {}
$ kubectl apply -f web.yaml
deployment.apps/web created
% sleep 20
$ kubectl get deployment web
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    2/2     2            2           20s
# The manifest regenerated with three replicas, applied over the first.
% kubectl create deployment web --image=nginx:1.27 --replicas=3 --port=80 --dry-run=client -o yaml > web.yaml
$ kubectl apply -f web.yaml
deployment.apps/web configured
% sleep 20
$ kubectl get deployment web
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    3/3     3            3           40s
$ kubectl get deployment web -o yaml | grep -c last-applied
1
# A command after `--` goes to every container; several --image make several containers.
$ kubectl create deployment worker --image=busybox:1.37 --dry-run=client -o json -- sleep 3600
{
    "kind": "Deployment",
    "apiVersion": "apps/v1",
    "metadata": {
        "name": "worker",
        "labels": {
            "app": "worker"
        }
    },
    "spec": {
        "replicas": 1,
        "selector": {
            "matchLabels": {
                "app": "worker"
            }
        },
        "template": {
            "metadata": {
                "labels": {
                    "app": "worker"
                }
            },
            "spec": {
                "containers": [
                    {
                        "name": "busybox",
                        "image": "busybox:1.37",
                        "command": [
                            "sleep",
                            "3600"
                        ],
                        "resources": {}
                    }
                ]
            }
        },
        "strategy": {}
    },
    "status": {}
}
$ kubectl create deployment multi --image=nginx:1.27 --image=redis:7.4 -o name
deployment.apps/multi
$ kubectl create deployment multi --image=nginx:1.27 --image=redis:7.4 -- sleep 1
error: cannot specify multiple --image options and command
[exit 1]
$ kubectl create deployment web --image=nginx:1.27
error: failed to create deployment: deployments.apps "web" already exists
[exit 1]
$ kubectl create deployment web --image=nginx:1.27 --dry-run=server
error: failed to create deployment: deployments.apps "web" already exists
[exit 1]
$ kubectl create deployment api --image=nginx:1.27 -n team
error: failed to create deployment: namespaces "team" not found
[exit 1]
$ kubectl create deployment web --image=nginx --replicas=-1 --dry-run=server
error: failed to create deployment: Deployment.apps "web" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0
[exit 1]
$ kubectl create deployment web
error: required flag(s) "image" not set
[exit 1]
# Namespaces
$ kubectl create namespace team
namespace/team created
$ kubectl create namespace team
Error from server (AlreadyExists): namespaces "team" already exists
[exit 1]
$ kubectl create ns Team
The Namespace "Team" is invalid: metadata.name: Invalid value: "Team": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')
[exit 1]
$ kubectl create namespace scratch --dry-run=client -o yaml
apiVersion: v1
kind: Namespace
metadata:
  name: scratch
spec: {}
status: {}
$ kubectl create deployment api --image=nginx:1.27 -n team -o yaml --save-config | grep -A1 last-applied
    kubectl.kubernetes.io/last-applied-configuration: |
      {"kind":"Deployment","apiVersion":"apps/v1","metadata":{"name":"api","namespace":"team","labels":{"app":"api"}},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"api"}},"template":{"metadata":{"labels":{"app":"api"}},"spec":{"containers":[{"name":"nginx","image":"nginx:1.27","resources":{}}]}},"strategy":{}},"status":{}}
$ kubectl get deployments -A -l app
NAMESPACE   NAME    READY   UP-TO-DATE   AVAILABLE   AGE
default     multi   0/1     0            0           0s
default     web     3/3     3            3           40s
team        api     0/1     0            0           0s
