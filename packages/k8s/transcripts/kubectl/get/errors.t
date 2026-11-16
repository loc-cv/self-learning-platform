# kubectl get: what fails, where it is printed, and what the simulator does not simulate.
# file: workloads.yaml
# settle: 0
% kubectl create -f workloads.yaml
% sleep 30
$ kubectl get pod missing
Error from server (NotFound): pods "missing" not found
[exit 1]
$ kubectl get pods missing other
Error from server (NotFound): pods "missing" not found
Error from server (NotFound): pods "other" not found
[exit 1]
$ kubectl get pods web-x probe -n dev
NAME    READY   STATUS    RESTARTS   AGE
probe   1/1     Running   0          30s
Error from server (NotFound): pods "web-x" not found
[exit 1]
$ kubectl get deployment missing -n dev
Error from server (NotFound): deployments.apps "missing" not found
[exit 1]
$ kubectl get pod missing -n nowhere
Error from server (NotFound): namespaces "nowhere" not found
[exit 1]
$ kubectl get pod missing --ignore-not-found
$ kubectl get pdos
error: the server doesn't have a resource type "pdos"
[exit 1]
$ kubectl get pods.v2
error: the server doesn't have a resource type "pods" in group "v2"
[exit 1]
$ kubectl get pod -l 'app in (a,b'
Error from server (BadRequest): Unable to find "/v1, Resource=pods" that match label selector "app in (a,b", field selector "": unable to parse requirement: found '', expected: ',' or ')'
[exit 1]
$ kubectl get pods -o yamll
error: unable to match a printer suitable for the output format "yamll", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,kyaml,name,template,templatefile,wide,yaml
[exit 1]
$ kubectl get pods --nosuchflag
error: unknown flag: --nosuchflag
See 'kubectl get --help' for usage.
[exit 1]
$ kubectl get pods -A web
error: a resource cannot be retrieved by name across all namespaces
[exit 1]
$ kubectl get
You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.

error: Required resource not specified.
Use "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).
See 'kubectl get -h' for help and examples
[exit 1]
# Real kubectl has these; the simulator says so.
$ kubectl get pods --sort-by=.metadata.name
[sim] kubectl: the flag --sort-by is not simulated yet
[exit 250]
$ kubectl get pods -o jsonpath='{.items[0].metadata.name}'
[sim] kubectl: the output format "jsonpath" is not simulated yet
[exit 250]
$ kubectl get pods -o custom-columns=NAME:.metadata.name
[sim] kubectl: the output format "custom-columns" is not simulated yet
[exit 250]
$ kubectl get cronjobs
[sim] kubectl: the resource type "cronjobs.batch" is not simulated yet
[exit 250]
$ kubectl get pods -f pod.yaml
[sim] kubectl: the flag --filename is not simulated yet
[exit 250]
$ kubectl top pods
[sim] kubectl: the command "kubectl top pod" is not simulated yet
[exit 250]
