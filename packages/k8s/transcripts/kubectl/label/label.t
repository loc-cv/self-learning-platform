# kubectl label: adding, overwriting and removing labels, --list, selectors, a Node label the
# scheduler reads, --local, and the errors.
# Output lines and errors: fixtures/golden/v1.37.2/change/label.yaml (and scheduling/fixed-by-label.yaml);
# upstream: staging/src/k8s.io/kubectl/pkg/cmd/label/label.go. --list prints a Go map: the real
# kubectl's order varies from run to run; the simulator sorts the keys.
# file: local.yaml
% kubectl create configmap a --from-literal=k=v
% kubectl create configmap b --from-literal=k=v
$ kubectl label configmap a tier=web
configmap/a labeled
$ kubectl label configmap a tier=db
error: 'tier' already has a value (web), and --overwrite is false
[exit 1]
$ kubectl label configmap a tier=db --overwrite
configmap/a labeled
$ kubectl label configmap a tier=db
configmap/a not labeled
$ kubectl label configmap a b app=demo
configmap/a labeled
configmap/b labeled
$ kubectl get configmaps -l app=demo --show-labels
NAME   DATA   AGE   LABELS
a      1      0s    app=demo,tier=db
b      1      0s    app=demo
$ kubectl label configmap a --list
app=demo
tier=db
$ kubectl label configmap -l app=demo --list
Listing labels for ConfigMap./a:
 app=demo
 tier=db
Listing labels for ConfigMap./b:
 app=demo
# Removing: KEY-. A key that is not there is reported, and the object is "not labeled".
$ kubectl label configmap a tier-
configmap/a unlabeled
$ kubectl label configmap a tier-
label "tier" not found.
configmap/a not labeled
$ kubectl label configmap a x=1 tier-
label "tier" not found.
configmap/a labeled
$ kubectl label configmap -l app=demo env=prod
configmap/a labeled
configmap/b labeled
$ kubectl label configmap a b env- -o name
configmap/a
configmap/b
$ kubectl label configmap a x=2 --dry-run=client -o yaml
error: 'x' already has a value (1), and --overwrite is false
[exit 1]
# The errors the client finds before it sends anything.
$ kubectl label configmap a 'v=a b'
error: invalid label value: "v=a b": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')
[exit 1]
$ kubectl label configmap a a=b=c
error: invalid label spec: a=b=c
[exit 1]
$ kubectl label configmap a y=1 y-
error: can not both modify and remove a label in the same command
[exit 1]
$ kubectl label configmap a x=1 foo
error: all resources must be specified before label changes: foo
[exit 1]
$ kubectl label configmap a
error: at least one label update is required
[exit 1]
$ kubectl label x=1
error: one or more resources must be specified as <resource> <name> or <resource>/<name>
[exit 1]
# ... and those the server returns.
$ kubectl label configmap a 'bad key=v'
The ConfigMap "a" is invalid: metadata.labels: Invalid value: "bad key": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')
[exit 1]
$ kubectl label configmap a x=3 --resource-version=1 --overwrite
Error from server (Conflict): Operation cannot be fulfilled on configmaps "a": the object has been modified; please apply your changes to the latest version and try again
[exit 1]
$ kubectl label configmap nope a x=4 --overwrite
configmap/a labeled
Error from server (NotFound): configmaps "nope" not found
[exit 1]
# A Node label that a Pod's nodeSelector needs.
$ kubectl label node node02 disktype=ssd
node/node02 labeled
$ kubectl get nodes -l disktype=ssd
NAME     STATUS   ROLES    AGE   VERSION
node02   Ready    <none>   15s   v1.37.2
# --local reads the file and prints what it would be.
$ kubectl label --local -f local.yaml team=core -o yaml
apiVersion: v1
data:
  k: v
kind: ConfigMap
metadata:
  labels:
    keep: "yes"
    team: core
  name: loc
$ kubectl label --local configmap a x=1
error: can only use local files by -f pod.yaml or --filename=pod.json when --local=true is set
[exit 1]
