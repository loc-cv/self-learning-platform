# kubectl set image: containers by name or all with `*`, a Pod, several workloads, a dry run, the
# local mode, and the errors.
# Output lines and errors: fixtures/golden/v1.37.2/change/set-image.yaml; upstream:
# staging/src/k8s.io/kubectl/pkg/cmd/set/set_image.go, set/helper.go CalculatePatches,
# polymorphichelpers/updatepodspec.go.
# file: local.yaml
% kubectl create deployment web --image=nginx:1.27
% kubectl create deployment api --image=nginx:1.27
% kubectl run solo --image=nginx:1.27
% kubectl create configmap settings --from-literal=a=b
% sleep 20
$ kubectl set image deployment/web nginx=nginx:1.28
deployment.apps/web image updated
$ kubectl get deployment web -o wide
NAME   READY   UP-TO-DATE   AVAILABLE   AGE   CONTAINERS   IMAGES       SELECTOR
web    1/1     1            1           20s   nginx        nginx:1.28   app=web
# The same image again changes nothing, so nothing is printed.
$ kubectl set image deployment/web nginx=nginx:1.28
# A container that is not there: the others are still changed.
$ kubectl set image deployment/web nope=busybox:1.37
error: unable to find container named "nope"
[exit 1]
$ kubectl set image deployment/web nginx=nginx:1.29 nope=busybox:1.37
deployment.apps/web image updated
error: unable to find container named "nope"
[exit 1]
$ kubectl set image deployment web '*=nginx:1.28' nginx=nginx:1.27
error: all containers are already specified by *, but saw more than one container_name=container_image pairs
[exit 1]
$ kubectl set image pod solo solo=nginx:1.28
pod/solo image updated
$ kubectl get pod solo -o yaml | grep 'image:'
  - image: nginx:1.28
    image: docker.io/library/nginx:1.27
$ kubectl set image deploy --all nginx=nginx:1.28 --dry-run=client
deployment.apps/api image updated (dry run)
deployment.apps/web image updated (dry run)
$ kubectl set image deploy -l app=api nginx=nginx:1.28 -o name
deployment.apps/api
$ kubectl set image configmap/settings a=b
error: configmaps/settings the object is not a pod or does not have a pod template: *v1.ConfigMap
[exit 1]
$ kubectl set image deploy/web deploy/nope nginx=nginx:1.27
Error from server (NotFound): deployments.apps "nope" not found
[exit 1]
$ kubectl set image deployment web
error: at least one image update is required
[exit 1]
$ kubectl set image deployment/web nginx=nginx:1.30 api
error: all resources must be specified before image changes: api
[exit 1]
# --local changes the file's objects and prints them; nothing is sent.
$ kubectl set image --local -f local.yaml '*=busybox:1.37' -o yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: loc
spec:
  selector:
    matchLabels:
      app: loc
  strategy: {}
  template:
    metadata:
      labels:
        app: loc
    spec:
      containers:
      - image: busybox:1.37
        name: nginx
        resources: {}
      initContainers:
      - command:
        - "true"
        image: busybox:1.37
        name: init
        resources: {}
status: {}
$ kubectl set image --local deploy/web nginx=nginx:2
error: you must specify resources by --filename when --local is set.
Example resource specifications include:
   '-f rsrc.yaml'
   '--filename=rsrc.json'
[exit 1]
# The other set subcommands come later.
$ kubectl set env deployment/web A=1
[sim] kubectl: the command "kubectl set env" is not simulated yet
[exit 250]
