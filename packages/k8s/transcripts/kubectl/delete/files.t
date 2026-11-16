# kubectl delete -f: the objects a manifest names, deleted in file order and waited for; a second
# run reports each one NotFound with the file it came from (AddSourceToErr), unless
# --ignore-not-found. Texts: fixtures/golden/v1.37.2/delete/by-file.yaml.
# file: workloads.yaml
# settle: 0
% kubectl create -f workloads.yaml
% sleep 30
% kubectl get deployment web -o yaml > web.yaml
% kubectl get deployment keep -o json > keep.json
$ kubectl delete -f web.yaml -f keep.json
deployment.apps "web" deleted from default namespace
deployment.apps "keep" deleted from default namespace
$ sleep 2
$ kubectl get deployments,rs,pods -l 'app in (web,keep)'
No resources found in default namespace.
$ kubectl delete -f web.yaml -f keep.json
Error from server (NotFound): error when deleting "web.yaml": deployments.apps "web" not found
Error from server (NotFound): error when deleting "keep.json": deployments.apps "keep" not found
[exit 1]
$ kubectl delete -f web.yaml --ignore-not-found
$ kubectl delete -f web.yaml deployment web
error: when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well
[exit 1]
