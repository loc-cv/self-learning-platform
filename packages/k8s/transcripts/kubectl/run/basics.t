# kubectl run: a Pod from an image and its flags, a Service with --expose, dry runs, the API
# server's errors, and the notice for attaching (phase 17).
# settle: 0
# Texts from the golden fixtures generate/run and client/generators (fixtures/golden/v1.37.2);
# objects from the simulated cluster.
$ kubectl run web --image=nginx:1.27 --port=80 --labels=app=web,tier=front --env=MODE=prod --annotations=owner=team-a
pod/web created
$ kubectl get pod web -o yaml | grep -A6 'env:'
  - env:
    - name: MODE
      value: prod
    image: nginx:1.27
    imagePullPolicy: IfNotPresent
    name: web
    ports:
# Arguments after `--` are the container's args; with --command they replace its command.
$ kubectl run once --image=busybox:1.37 --restart=Never --command -- sh -c 'echo done'
pod/once created
$ kubectl run sleeper --image=busybox:1.37 --dry-run=client -o yaml -- sleep 3600
apiVersion: v1
kind: Pod
metadata:
  labels:
    run: sleeper
  name: sleeper
spec:
  containers:
  - args:
    - sleep
    - "3600"
    image: busybox:1.37
    name: sleeper
    resources: {}
  dnsPolicy: ClusterFirst
  restartPolicy: Always
status: {}
# --expose creates a ClusterIP Service with the Pod's labels as its selector.
$ kubectl run api --image=nginx:1.27 --port=8080 --expose
pod/api created
service/api created
$ kubectl run api2 --image=nginx:1.27 --port=8080 --expose --dry-run=server
pod/api2 created (server dry run)
service/api2 created (server dry run)
% sleep 20
$ kubectl get pods --show-labels
NAME   READY   STATUS      RESTARTS   AGE   LABELS
api    1/1     Running     0          20s   run=api
once   0/1     Completed   0          20s   run=once
web    1/1     Running     0          20s   app=web,tier=front
$ kubectl get service api -o wide
NAME   TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)    AGE   SELECTOR
api    ClusterIP   10.103.161.232   <none>        8080/TCP   20s   run=api
$ kubectl get endpointslices -l kubernetes.io/service-name=api -o name | cut -c1-35
endpointslice.discovery.k8s.io/api-
$ kubectl run web --image=nginx:1.27
Error from server (AlreadyExists): pods "web" already exists
[exit 1]
$ kubectl run Web --image=nginx:1.27 -o name
The Pod "Web" is invalid: 
* metadata.name: Invalid value: "Web": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')
* spec.containers[0].name: Invalid value: "Web": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')
[exit 1]
$ kubectl run lost --image=nginx:1.27 -n missing
Error from server (NotFound): namespaces "missing" not found
[exit 1]
# --overrides: a JSON merge patch (or strategic merge) over the generated Pod.
$ kubectl run pinned --image=nginx:1.27 --overrides='{"spec":{"nodeName":"node02"}}' -o name
pod/pinned
% sleep 10
$ kubectl get pod pinned -o wide
NAME     READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
pinned   1/1     Running   0          10s   <<ip>>   node02   <none>           <none>
# Attaching is phase 17.
$ kubectl run shell --image=busybox:1.37 -it -- sh
[sim] kubectl: attaching to the Pod (kubectl run -i, -t, --attach, --rm; phase 17) is not simulated yet
[exit 250]
$ kubectl run tmp --image=busybox:1.37 --rm -i --restart=Never -- date
[sim] kubectl: attaching to the Pod (kubectl run -i, -t, --attach, --rm; phase 17) is not simulated yet
[exit 250]
