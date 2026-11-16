# kubectl describe of a Deployment with its ReplicaSet and events, a Service with its endpoints,
# a Node with its Pods and allocated resources, a Pod that is terminating, a Pod found by name
# prefix; the kinds and flags the simulator does not describe yet print a notice. Source-derived:
# staging/src/k8s.io/kubectl/pkg/describe/describe.go describeDeployment, describeService,
# describeNode, describePod; cmd/describe/describe.go Run, DescribeMatchingResources.
# file: workloads.yaml
% kubectl create -f workloads.yaml
% sleep 30
$ kubectl describe deployment web
Name:                   web
Namespace:              default
CreationTimestamp:      Fri, 13 Nov 2026 09:00:15 +0000
Labels:                 app=web
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=web
Replicas:               2 desired | 2 updated | 2 total | 2 available | 0 unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
  Labels:  app=web
  Containers:
   nginx:
    Image:      nginx:1.31.8
    Port:       80/TCP (http)
    Host Port:  0/TCP (http)
    Limits:
      memory:   256Mi
    Readiness:  http-get http://:http/ delay=0s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Environment:
      POD_NAME:       (v1:metadata.name)
      POD_IP:         (v1:status.podIP)
      MEMORY_LIMIT:  256 (limits.memory)
    Mounts:          <none>
  Volumes:           <none>
  Node-Selectors:    <none>
  Tolerations:       <none>
Conditions:
  Type           Status  Reason
  ----           ------  ------
  Available      True    MinimumReplicasAvailable
  Progressing    True    NewReplicaSetAvailable
OldReplicaSets:  <none>
NewReplicaSet:   web-74cb6dcf87 (2/2 replicas created)
Events:
  Type    Reason             Age   From                   Message
  ----    ------             ----  ----                   -------
  Normal  ScalingReplicaSet  30s   deployment-controller  Scaled up replica set web-74cb6dcf87 from 0 to 2
$ kubectl describe svc web
Name:                     web
Namespace:                default
Labels:                   <none>
Annotations:              <none>
Selector:                 app=web
Type:                     ClusterIP
IP Family Policy:         SingleStack
IP Families:              IPv4
IP:                       10.103.161.232
IPs:                      10.103.161.232
Port:                     http  80/TCP
TargetPort:               http/TCP
Endpoints:                10.244.2.3:80,10.244.1.3:80
Session Affinity:         None
Internal Traffic Policy:  Cluster
Events:                   <none>
$ kubectl describe pod web-
Name:         web-74cb6dcf87-dm95j
Namespace:    default
Node:         node01/172.16.0.11
Start Time:   Fri, 13 Nov 2026 09:00:15 +0000
Labels:       app=web
              pod-template-hash=74cb6dcf87
Annotations:  <none>
Status:       Running
IP:           10.244.1.3
IPs:
  IP:           10.244.1.3
Controlled By:  ReplicaSet/web-74cb6dcf87
Containers:
  nginx:
    Container ID:   containerd://fd9283ff9e6b3468f27432db8ed9d42f770ced207918d375ed940707276cfdf3
    Image:          nginx:1.31.8
    Image ID:       docker.io/library/nginx@sha256:165ddde8751e75a1c907d24ef10d9f6deb08b57e0fe56caf67512486aff76d82
    Port:           80/TCP (http)
    Host Port:      0/TCP (http)
    State:          Running
      Started:      Fri, 13 Nov 2026 09:00:19 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      memory:  256Mi
    Requests:
      memory:   256Mi
    Readiness:  http-get http://:http/ delay=0s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Environment:
      POD_NAME:      web-74cb6dcf87-dm95j (v1:metadata.name)
      POD_IP:         (v1:status.podIP)
      MEMORY_LIMIT:  256 (limits.memory)
    Mounts:          <none>
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       True 
  ContainersReady             True 
  PodScheduled                True 
Volumes:                      <none>
QoS Class:                    Burstable
Node-Selectors:               <none>
Tolerations:                  <none>

Name:         web-74cb6dcf87-gssw6
Namespace:    default
Node:         node02/172.16.0.12
Start Time:   Fri, 13 Nov 2026 09:00:15 +0000
Labels:       app=web
              pod-template-hash=74cb6dcf87
Annotations:  <none>
Status:       Running
IP:           10.244.2.3
IPs:
  IP:           10.244.2.3
Controlled By:  ReplicaSet/web-74cb6dcf87
Containers:
  nginx:
    Container ID:   containerd://8ca68044b4c46d081773329f2cab82719558953c42b36bfb1f4afad3f2752712
    Image:          nginx:1.31.8
    Image ID:       docker.io/library/nginx@sha256:165ddde8751e75a1c907d24ef10d9f6deb08b57e0fe56caf67512486aff76d82
    Port:           80/TCP (http)
    Host Port:      0/TCP (http)
    State:          Running
      Started:      Fri, 13 Nov 2026 09:00:18 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      memory:  256Mi
    Requests:
      memory:   256Mi
    Readiness:  http-get http://:http/ delay=0s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Environment:
      POD_NAME:      web-74cb6dcf87-gssw6 (v1:metadata.name)
      POD_IP:         (v1:status.podIP)
      MEMORY_LIMIT:  256 (limits.memory)
    Mounts:          <none>
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       True 
  ContainersReady             True 
  PodScheduled                True 
Volumes:                      <none>
QoS Class:                    Burstable
Node-Selectors:               <none>
Tolerations:                  <none>

$ kubectl describe node node01
Name:               node01
Roles:              <none>
Labels:             beta.kubernetes.io/arch=amd64
                    beta.kubernetes.io/os=linux
                    kubernetes.io/arch=amd64
                    kubernetes.io/hostname=node01
                    kubernetes.io/os=linux
Annotations:        node.alpha.kubernetes.io/ttl: 0
                    volumes.kubernetes.io/controller-managed-attach-detach: true
CreationTimestamp:  Fri, 13 Nov 2026 09:00:00 +0000
Taints:             <none>
Unschedulable:      false
Lease:
  HolderIdentity:  node01
  AcquireTime:     <unset>
  RenewTime:       Fri, 13 Nov 2026 09:00:40 +0000
Conditions:
  Type             Status  LastHeartbeatTime                 LastTransitionTime                Reason                       Message
  ----             ------  -----------------                 ------------------                ------                       -------
  MemoryPressure   False   Fri, 13 Nov 2026 09:00:30 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasSufficientMemory   kubelet has sufficient memory available
  DiskPressure     False   Fri, 13 Nov 2026 09:00:30 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasNoDiskPressure     kubelet has no disk pressure
  PIDPressure      False   Fri, 13 Nov 2026 09:00:30 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasSufficientPID      kubelet has sufficient PID available
  Ready            True    Fri, 13 Nov 2026 09:00:30 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletReady                 kubelet is posting ready status
Addresses:
  InternalIP:  172.16.0.11
  Hostname:    node01
Capacity:
  cpu:                2
  ephemeral-storage:  20134592Ki
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             4010284Ki
  pods:               110
Allocatable:
  cpu:                2
  ephemeral-storage:  18556039957
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             3907884Ki
  pods:               110
System Info:
  Machine ID:                 5b0d6c4ee0a94fa8b1c3e2d7f9a10c02
  System UUID:                4c4c4544-0000-1010-8010-b2c04f000002
  Boot ID:                    1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b02
  Kernel Version:             6.8.0-88-generic
  OS Image:                   Ubuntu 24.04.3 LTS
  Operating System:           linux
  Architecture:               amd64
  Container Runtime Version:  containerd://1.7.28
  Kubelet Version:            v1.37.2
PodCIDR:                      10.244.1.0/24
PodCIDRs:                     10.244.1.0/24
Non-terminated Pods:          (3 in total)
  Namespace                   Name                        CPU Requests  CPU Limits  Memory Requests  Memory Limits  Age
  ---------                   ----                        ------------  ----------  ---------------  -------------  ---
  default                     web-74cb6dcf87-dm95j        0 (0%)        0 (0%)      256Mi (6%)       256Mi (6%)     30s
  kube-system                 coredns-559f6c778d-wvvt9    100m (5%)     0 (0%)      70Mi (1%)        170Mi (4%)     45s
  kube-system                 kube-proxy-wk7ld            0 (0%)        0 (0%)      0 (0%)           0 (0%)         45s
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests    Limits
  --------           --------    ------
  cpu                100m (5%)   0 (0%)
  memory             326Mi (8%)  426Mi (11%)
  ephemeral-storage  0 (0%)      0 (0%)
  hugepages-1Gi      0 (0%)      0 (0%)
  hugepages-2Mi      0 (0%)      0 (0%)
Events:
  Type    Reason                   Age   From             Message
  ----    ------                   ----  ----             -------
  Normal  Starting                 45s   kubelet          Starting kubelet.
  Normal  NodeHasSufficientMemory  45s   kubelet          Node node01 status is now: NodeHasSufficientMemory
  Normal  NodeHasNoDiskPressure    45s   kubelet          Node node01 status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientPID     45s   kubelet          Node node01 status is now: NodeHasSufficientPID
  Normal  RegisteredNode           45s   node-controller  Node node01 event: Registered Node node01 in Controller
% kubectl delete pod held --wait=false
$ kubectl describe pod held
Name:                      held
Namespace:                 default
Node:                      node02/172.16.0.12
Start Time:                Fri, 13 Nov 2026 09:00:15 +0000
Labels:                    <none>
Annotations:               <none>
Status:                    Terminating (lasts <invalid>)
Termination Grace Period:  30s
IP:                        10.244.2.4
IPs:
  IP:  10.244.2.4
Containers:
  app:
    Container ID:  containerd://7f15b7222007e776e116ff25cbee816ac2c9d7ffd1955a798064f3c661f9b160
    Image:         busybox:1.36
    Image ID:      docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
    Port:          <none>
    Host Port:     <none>
    Command:
      sleep
      3600
    State:          Running
      Started:      Fri, 13 Nov 2026 09:00:18 +0000
    Ready:          True
    Restart Count:  0
    Environment:    <none>
    Mounts:         <none>
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       True 
  ContainersReady             True 
  PodScheduled                True 
Volumes:                      <none>
QoS Class:                    BestEffort
Node-Selectors:               <none>
Tolerations:                  <none>
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  29s   default-scheduler  Successfully assigned default/held to node02
  Normal  Pulling    30s   kubelet            spec.containers{app}: Pulling image "busybox:1.36"
  Normal  Pulled     27s   kubelet            spec.containers{app}: Successfully pulled image "busybox:1.36" in 544ms (2.698s including waiting). Image size: 2217006 bytes.
  Normal  Created    27s   kubelet            spec.containers{app}: Container created
  Normal  Started    27s   kubelet            spec.containers{app}: Container started
$ kubectl describe configmap app-config
[sim] kubectl: describe for the resource type "configmaps" is not simulated yet
[exit 250]
$ kubectl describe cm missing
Error from server (NotFound): configmaps "missing" not found
[exit 1]
# -f: the objects of a manifest, described as they are on the server (without events: several)
$ kubectl describe -f workloads.yaml -l app=web
Name:                   web
Namespace:              default
CreationTimestamp:      Fri, 13 Nov 2026 09:00:15 +0000
Labels:                 app=web
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=web
Replicas:               2 desired | 2 updated | 2 total | 2 available | 0 unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
  Labels:  app=web
  Containers:
   nginx:
    Image:      nginx:1.31.8
    Port:       80/TCP (http)
    Host Port:  0/TCP (http)
    Limits:
      memory:   256Mi
    Readiness:  http-get http://:http/ delay=0s timeout=1s period=10s successThreshold=1 failureThreshold=3
    Environment:
      POD_NAME:       (v1:metadata.name)
      POD_IP:         (v1:status.podIP)
      MEMORY_LIMIT:  256 (limits.memory)
    Mounts:          <none>
  Volumes:           <none>
  Node-Selectors:    <none>
  Tolerations:       <none>
Conditions:
  Type           Status  Reason
  ----           ------  ------
  Available      True    MinimumReplicasAvailable
  Progressing    True    NewReplicaSetAvailable
OldReplicaSets:  <none>
NewReplicaSet:   web-74cb6dcf87 (2/2 replicas created)
Events:
  Type    Reason             Age   From                   Message
  ----    ------             ----  ----                   -------
  Normal  ScalingReplicaSet  30s   deployment-controller  Scaled up replica set web-74cb6dcf87 from 0 to 2
$ kubectl describe -f workloads.yaml
[sim] kubectl: describe for the resource type "configmaps" is not simulated yet
[exit 250]
$ kubectl describe -f workloads.yaml pods
error: when paths, URLs, or stdin is provided as input, you may not specify resource arguments as well
[exit 1]
$ kubectl describe -f nothere.yaml
error: the path "nothere.yaml" does not exist
[exit 1]
$ kubectl describe nodes --chunk-size=10 controlplane
Name:               controlplane
Roles:              control-plane
Labels:             beta.kubernetes.io/arch=amd64
                    beta.kubernetes.io/os=linux
                    kubernetes.io/arch=amd64
                    kubernetes.io/hostname=controlplane
                    kubernetes.io/os=linux
                    node-role.kubernetes.io/control-plane=
                    node.kubernetes.io/exclude-from-external-load-balancers=
Annotations:        node.alpha.kubernetes.io/ttl: 0
                    volumes.kubernetes.io/controller-managed-attach-detach: true
CreationTimestamp:  Fri, 13 Nov 2026 09:00:00 +0000
Taints:             node-role.kubernetes.io/control-plane:NoSchedule
Unschedulable:      false
Lease:
  HolderIdentity:  controlplane
  AcquireTime:     <unset>
  RenewTime:       Fri, 13 Nov 2026 09:00:40 +0000
Conditions:
  Type             Status  LastHeartbeatTime                 LastTransitionTime                Reason                       Message
  ----             ------  -----------------                 ------------------                ------                       -------
  MemoryPressure   False   Fri, 13 Nov 2026 09:00:00 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasSufficientMemory   kubelet has sufficient memory available
  DiskPressure     False   Fri, 13 Nov 2026 09:00:00 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasNoDiskPressure     kubelet has no disk pressure
  PIDPressure      False   Fri, 13 Nov 2026 09:00:00 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletHasSufficientPID      kubelet has sufficient PID available
  Ready            True    Fri, 13 Nov 2026 09:00:00 +0000   Fri, 13 Nov 2026 09:00:00 +0000   KubeletReady                 kubelet is posting ready status
Addresses:
  InternalIP:  172.16.0.10
  Hostname:    controlplane
Capacity:
  cpu:                2
  ephemeral-storage:  20134592Ki
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             4010284Ki
  pods:               110
Allocatable:
  cpu:                2
  ephemeral-storage:  18556039957
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             3907884Ki
  pods:               110
System Info:
  Machine ID:                 5b0d6c4ee0a94fa8b1c3e2d7f9a10c01
  System UUID:                4c4c4544-0000-1010-8010-b2c04f000001
  Boot ID:                    1f7c2a9e-6b0d-4e51-9a3c-0d2e5f7a1b01
  Kernel Version:             6.8.0-88-generic
  OS Image:                   Ubuntu 24.04.3 LTS
  Operating System:           linux
  Architecture:               amd64
  Container Runtime Version:  containerd://1.7.28
  Kubelet Version:            v1.37.2
PodCIDR:                      10.244.0.0/24
PodCIDRs:                     10.244.0.0/24
Non-terminated Pods:          (5 in total)
  Namespace                   Name                                    CPU Requests  CPU Limits  Memory Requests  Memory Limits  Age
  ---------                   ----                                    ------------  ----------  ---------------  -------------  ---
  kube-system                 etcd-controlplane                       100m (5%)     0 (0%)      100Mi (2%)       0 (0%)         45s
  kube-system                 kube-apiserver-controlplane             250m (12%)    0 (0%)      0 (0%)           0 (0%)         45s
  kube-system                 kube-controller-manager-controlplane    200m (10%)    0 (0%)      0 (0%)           0 (0%)         45s
  kube-system                 kube-proxy-ss2p9                        0 (0%)        0 (0%)      0 (0%)           0 (0%)         45s
  kube-system                 kube-scheduler-controlplane             100m (5%)     0 (0%)      0 (0%)           0 (0%)         45s
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests    Limits
  --------           --------    ------
  cpu                650m (32%)  0 (0%)
  memory             100Mi (2%)  0 (0%)
  ephemeral-storage  0 (0%)      0 (0%)
  hugepages-1Gi      0 (0%)      0 (0%)
  hugepages-2Mi      0 (0%)      0 (0%)
Events:
  Type    Reason                   Age   From             Message
  ----    ------                   ----  ----             -------
  Normal  Starting                 45s   kubelet          Starting kubelet.
  Normal  NodeHasSufficientMemory  45s   kubelet          Node controlplane status is now: NodeHasSufficientMemory
  Normal  NodeHasNoDiskPressure    45s   kubelet          Node controlplane status is now: NodeHasNoDiskPressure
  Normal  NodeHasSufficientPID     45s   kubelet          Node controlplane status is now: NodeHasSufficientPID
  Normal  RegisteredNode           45s   node-controller  Node controlplane event: Registered Node controlplane in Controller
# kubectl prints times in the local zone (time.Local); the machines run in UTC
$ TZ=Etc/UTC kubectl describe pod held --show-events=false | grep 'Start Time'
Start Time:                Fri, 13 Nov 2026 09:00:15 +0000
$ TZ=Asia/Ho_Chi_Minh kubectl describe node node01
[sim] kubectl: the time zone TZ=Asia/Ho_Chi_Minh is not simulated yet
[sim] the simulated machines run in UTC; TZ=UTC or an unset TZ works
[exit 250]
