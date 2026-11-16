# kubectl api-resources and api-versions: the API server's discovery, filtered and sorted. Texts:
# fixtures/golden/v1.37.2/info/api-resources.yaml.
$ kubectl api-resources --api-group=apps
NAME                  SHORTNAMES   APIVERSION   NAMESPACED   KIND
controllerrevisions                apps/v1      true         ControllerRevision
daemonsets            ds           apps/v1      true         DaemonSet
deployments           deploy       apps/v1      true         Deployment
replicasets           rs           apps/v1      true         ReplicaSet
statefulsets          sts          apps/v1      true         StatefulSet
# Sorting compares bytes: CSIDriver sorts before CertificateSigningRequest.
$ kubectl api-resources --namespaced=false --sort-by=kind --no-headers | head -4
apiservices                                    apiregistration.k8s.io/v1         false   APIService
csidrivers                                     storage.k8s.io/v1                 false   CSIDriver
csinodes                                       storage.k8s.io/v1                 false   CSINode
certificatesigningrequests          csr        certificates.k8s.io/v1            false   CertificateSigningRequest
$ kubectl api-resources --verbs=list --categories=all -o name
pods
replicationcontrollers
services
daemonsets.apps
deployments.apps
replicasets.apps
statefulsets.apps
horizontalpodautoscalers.autoscaling
cronjobs.batch
jobs.batch
$ kubectl api-resources --api-group=autoscaling -o wide
NAME                       SHORTNAMES   APIVERSION       NAMESPACED   KIND                      VERBS                                                        CATEGORIES
horizontalpodautoscalers   hpa          autoscaling/v2   true         HorizontalPodAutoscaler   create,delete,deletecollection,get,list,patch,update,watch   all
$ kubectl api-resources --sort-by=age
error: --sort-by accepts only name or kind
[exit 1]
$ kubectl api-resources -o kyaml
[sim] kubectl: the output format "kyaml" is not simulated yet
[exit 250]
$ kubectl api-versions | grep -c /
22
$ kubectl api-versions | head -3
admissionregistration.k8s.io/v1
apiextensions.k8s.io/v1
apiregistration.k8s.io/v1
