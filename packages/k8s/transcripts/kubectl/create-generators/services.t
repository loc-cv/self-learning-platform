# kubectl create service clusterip|nodeport|loadbalancer|externalname: ports from --tcp
# (`port[:targetPort]`, a target by number or name), a headless Service, a fixed node port, and
# the errors of port parsing, validation and the API server.
# settle: 0
# Texts from the golden fixtures generate/client, generate/create and client/generators
# (fixtures/golden/v1.37.2); objects from the simulated cluster.
$ kubectl create service clusterip web --tcp=80:8080 --tcp=443 --tcp=53:dns --dry-run=client -o yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: web
  name: web
spec:
  ports:
  - name: 80-8080
    port: 80
    protocol: TCP
    targetPort: 8080
  - name: "443"
    port: 443
    protocol: TCP
    targetPort: 443
  - name: 53-dns
    port: 53
    protocol: TCP
    targetPort: dns
  selector:
    app: web
  type: ClusterIP
status:
  loadBalancer: {}
$ kubectl create service clusterip web --tcp=80:8080
service/web created
$ kubectl create service clusterip headless --clusterip=None
service/headless created
$ kubectl create service nodeport np --tcp=80:8080 --node-port=30080
service/np created
$ kubectl create service nodeport np2 --tcp=80 --node-port=30080
error: failed to create NodePort service: Service "np2" is invalid: spec.ports[0].nodePort: Invalid value: 30080: provided port is already allocated
[exit 1]
$ kubectl create svc loadbalancer lb --tcp=80:8080
service/lb created
$ kubectl create service externalname db --external-name=db.example.com
service/db created
$ kubectl get services web headless np lb db -o wide
NAME       TYPE           CLUSTER-IP       EXTERNAL-IP      PORT(S)        AGE   SELECTOR
web        ClusterIP      10.103.161.232   <none>           80/TCP         0s    app=web
headless   ClusterIP      None             <none>           <none>         0s    app=headless
np         NodePort       10.104.110.120   <none>           80:30080/TCP   0s    app=np
lb         LoadBalancer   10.100.66.103    <pending>        80:30859/TCP   0s    app=lb
db         ExternalName   <none>           db.example.com   <none>         0s    app=db
$ kubectl create service clusterip web --tcp=80
error: failed to create ClusterIP service: services "web" already exists
[exit 1]
$ kubectl create service clusterip x --tcp=http
error: strconv.ParseUint: parsing "http": invalid syntax
[exit 1]
$ kubectl create service clusterip x --tcp=70000
error: strconv.ParseUint: parsing "70000": value out of range
[exit 1]
$ kubectl create service clusterip x --tcp=80:my_port
error: must contain only alpha-numeric characters (a-z, 0-9), and hyphens (-)
[exit 1]
$ kubectl create service clusterip x --tcp=80:0
error: must be between 1 and 65535, inclusive
[exit 1]
$ kubectl create service clusterip x
error: at least one tcp port specifier must be provided
[exit 1]
$ kubectl create service externalname x --external-name=Not_A_Name
error: invalid service external name Not_A_Name
[exit 1]
$ kubectl create service externalname x
error: required flag(s) "external-name" not set
[exit 1]
$ kubectl create service nodeport x --tcp=80 --node-port=80
error: failed to create NodePort service: Service "x" is invalid: spec.ports[0].nodePort: Invalid value: 80: provided port is not in the valid range. The range of valid ports is 30000-32767
[exit 1]
