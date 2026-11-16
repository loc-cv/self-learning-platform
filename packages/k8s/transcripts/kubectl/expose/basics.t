# kubectl expose: a Service for a Deployment, ReplicaSet, Pod or Service, its selector, ports and
# protocols read from the object; flags that replace them; dry runs; and the errors for objects
# that cannot be exposed.
# file: local.yaml
# settle: 0
# Texts from the golden fixtures generate/expose and errors/not-found (fixtures/golden/v1.37.2);
# objects from the simulated cluster.
% kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80
% kubectl run solo --image=nginx:1.27 --port=8080 --labels=app=solo
% kubectl create configmap cfg --from-literal=a=b
$ kubectl expose deployment web
service/web exposed
$ kubectl expose deployment web --name=web-np --type=NodePort --port=8080 --target-port=80 --dry-run=client -o yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: web
  name: web-np
spec:
  ports:
  - port: 8080
    protocol: TCP
    targetPort: 80
  selector:
    app: web
  type: NodePort
status:
  loadBalancer: {}
$ kubectl expose pod solo --port=9000 --target-port=8080 --name=solo-svc
service/solo-svc exposed
$ kubectl expose service web --name=web-copy --port=8081 -o name
service/web-copy
$ kubectl expose -f local.yaml --dry-run=client -o yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: local
  name: local
spec:
  ports:
  - name: port-1
    port: 9090
    protocol: TCP
    targetPort: 9090
  - name: port-2
    port: 53
    protocol: UDP
    targetPort: 53
  selector:
    app: local
status:
  loadBalancer: {}
% sleep 20
$ kubectl get services web solo-svc web-copy -o wide
NAME       TYPE        CLUSTER-IP       EXTERNAL-IP   PORT(S)    AGE   SELECTOR
web        ClusterIP   10.103.161.232   <none>        80/TCP     20s   app=web
solo-svc   ClusterIP   10.104.110.120   <none>        9000/TCP   20s   app=solo
web-copy   ClusterIP   10.109.1.115     <none>        8081/TCP   20s   app=web
$ kubectl get endpointslices -l kubernetes.io/service-name=web -o yaml | grep -A3 'ports:'
  ports:
  - name: ""
    port: 80
    protocol: TCP
$ kubectl expose deployment web
Error from server (AlreadyExists): services "web" already exists
[exit 1]
$ kubectl expose deployment missing --port=80
Error from server (NotFound): deployments.apps "missing" not found
[exit 1]
$ kubectl expose configmap cfg --port=80
error: cannot expose a ConfigMap
[exit 1]
$ kubectl expose deployment web --port=http
error: strconv.Atoi: parsing "http": invalid syntax
[exit 1]
$ kubectl expose deployment web --session-affinity=Sticky
error: unknown session affinity: Sticky
[exit 1]
$ kubectl expose deployment
error: resource(s) were provided, but no name was specified
[exit 1]
$ kubectl expose
error: You must provide one or more resources by argument or filename.
Example resource specifications include:
   '-f rsrc.yaml'
   '--filename=rsrc.json'
   '<resource> <name>'
   '<resource>'
[exit 1]
