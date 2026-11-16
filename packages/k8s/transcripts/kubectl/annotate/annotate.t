# kubectl annotate: adding, overwriting and removing annotations, values with spaces and JSON,
# --list, selectors, --local, and the errors.
# Output lines and errors: fixtures/golden/v1.37.2/change/annotate.yaml; upstream:
# staging/src/k8s.io/kubectl/pkg/cmd/annotate/annotate.go.
% kubectl create configmap a --from-literal=k=v
% kubectl create configmap b --from-literal=k=v
% kubectl label configmap a b app=demo
$ kubectl annotate configmap a owner=team-a
configmap/a annotated
$ kubectl annotate configmap a owner=team-b
error: --overwrite is false but found the following declared annotation(s): 'owner' already has a value (team-a)
[exit 1]
$ kubectl annotate configmap a owner=team-b --overwrite
configmap/a annotated
# The change cause may always be replaced.
$ kubectl annotate configmap a kubernetes.io/change-cause='first change'
configmap/a annotated
$ kubectl annotate configmap a kubernetes.io/change-cause='second change'
configmap/a annotated
$ kubectl annotate configmap a 'desc=my frontend' 'json={"a": 1}'
configmap/a annotated
$ kubectl annotate configmap a --list
desc=my frontend
json={"a": 1}
kubernetes.io/change-cause=second change
owner=team-b
$ kubectl annotate configmap a desc- json-
configmap/a annotated
$ kubectl annotate configmap -l app=demo reviewed=yes
configmap/a annotated
configmap/b annotated
$ kubectl annotate configmap a b reviewed- -o name
configmap/a
configmap/b
$ kubectl get configmap a -o yaml | grep -A3 annotations
  annotations:
    kubernetes.io/change-cause: second change
    owner: team-b
  creationTimestamp: "2026-11-13T09:00:15Z"
# Errors.
$ kubectl annotate configmap a x=1 x-
error: can not both modify and remove the following annotation(s) in the same command: x
[exit 1]
$ kubectl annotate configmap a =x
error: at least one annotation update is required
[exit 1]
$ kubectl annotate configmap a
error: at least one annotation update is required
[exit 1]
$ kubectl annotate configmap a 'bad key=v'
The ConfigMap "a" is invalid: metadata.annotations: Invalid value: "bad key": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')
[exit 1]
$ kubectl annotate configmap a b x=1 --resource-version=1
error: --resource-version may only be used with a single resource
[exit 1]
$ kubectl annotate --local configmap a x=1
error: can only use local files by -f rsrc.yaml or --filename=rsrc.json when --local=true is set
[exit 1]
