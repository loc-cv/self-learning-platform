# kubectl describe pod for a Pending, a Running and a crash-looping Pod, as the simulated
# scheduler and kubelet leave them: container IDs, image IDs, states with their times, the last
# state of a container that exited, restart counts, conditions, and the events table with its
# ages and the kubelet's aggregated events (xN over T). Source-derived: the layout is
# staging/src/k8s.io/kubectl/pkg/describe/describe.go describePod, describeContainers,
# describeStatus and DescribeEvents (tabbedString's tab writer), compared with the oracle where
# it can show it (fixtures/golden/v1.37.2/describe/, pods/, scheduling/); what a real kubelet
# writes (IDs, states, its events) is the simulated kubelet's (docs/FIDELITY.md §6.5).
# file: pods.yaml
% kubectl create -f pods.yaml
% sleep 30
$ kubectl get pods
NAME      READY   STATUS    RESTARTS      AGE
crash     0/1     Error     2 (28s ago)   30s
waiting   0/1     Pending   0             30s
web       1/1     Running   0             30s
$ kubectl describe pod waiting
Name:         waiting
Namespace:    default
Node:         <none>
Labels:       <none>
Annotations:  <none>
Status:       Pending
IP:           
IPs:          <none>
Containers:
  app:
    Image:        nginx:1.31.8
    Port:         <none>
    Host Port:    <none>
    Environment:  <none>
    Mounts:       <none>
Conditions:
  Type           Status
  PodScheduled   False 
Volumes:         <none>
QoS Class:       BestEffort
Node-Selectors:  disktype=nvme
Tolerations:     <none>
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  29s   default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.
$ kubectl describe pod web
Name:         web
Namespace:    default
Node:         node02/172.16.0.12
Start Time:   Fri, 13 Nov 2026 09:00:15 +0000
Labels:       app=web
Annotations:  <none>
Status:       Running
IP:           10.244.2.3
IPs:
  IP:  10.244.2.3
Containers:
  nginx:
    Container ID:   containerd://7f15b7222007e776e116ff25cbee816ac2c9d7ffd1955a798064f3c661f9b160
    Image:          nginx:1.31.8
    Image ID:       docker.io/library/nginx@sha256:165ddde8751e75a1c907d24ef10d9f6deb08b57e0fe56caf67512486aff76d82
    Port:           80/TCP (http)
    Host Port:      0/TCP (http)
    State:          Running
      Started:      Fri, 13 Nov 2026 09:00:18 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      memory:  128Mi
    Requests:
      cpu:        100m
      memory:     64Mi
    Environment:  <none>
    Mounts:       <none>
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
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  29s   default-scheduler  Successfully assigned default/web to node02
  Normal  Pulling    30s   kubelet            spec.containers{nginx}: Pulling image "nginx:1.31.8"
  Normal  Pulled     27s   kubelet            spec.containers{nginx}: Successfully pulled image "nginx:1.31.8" in 2.335s (2.335s including waiting). Image size: 63933865 bytes.
  Normal  Created    27s   kubelet            spec.containers{nginx}: Container created
  Normal  Started    27s   kubelet            spec.containers{nginx}: Container started
# The crash loop: the back-off doubles from 10 s, so after five minutes the container has been
# restarted five times and waits in CrashLoopBackOff.
$ sleep 300
$ kubectl describe pod crash
Name:         crash
Namespace:    default
Node:         node01/172.16.0.11
Start Time:   Fri, 13 Nov 2026 09:00:15 +0000
Labels:       app=crash
Annotations:  <none>
Status:       Running
IP:           10.244.1.3
IPs:
  IP:  10.244.1.3
Containers:
  app:
    Container ID:  containerd://7c33ac7de9cfdd27a07b20e52f85a2c17c8a359f199085ec6b9c3cf4beafe306
    Image:         busybox:1.36
    Image ID:      docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
    Port:          <none>
    Host Port:     <none>
    Command:
      sh
      -c
      echo starting; exit 1
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
      Started:      Fri, 13 Nov 2026 09:03:07 +0000
      Finished:     Fri, 13 Nov 2026 09:03:07 +0000
    Ready:          False
    Restart Count:  5
    Environment:    <none>
    Mounts:         <none>
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       False 
  ContainersReady             False 
  PodScheduled                True 
Volumes:                      <none>
QoS Class:                    BestEffort
Node-Selectors:               <none>
Tolerations:                  <none>
Events:
  Type     Reason     Age                    From               Message
  ----     ------     ----                   ----               -------
  Normal   Scheduled  5m29s                  default-scheduler  Successfully assigned default/crash to node01
  Normal   Pulling    5m29s                  kubelet            spec.containers{app}: Pulling image "busybox:1.36"
  Normal   Pulled     5m28s                  kubelet            spec.containers{app}: Successfully pulled image "busybox:1.36" in 977ms (977ms including waiting). Image size: 2217006 bytes.
  Normal   Created    2m38s (x6 over 5m28s)  kubelet            spec.containers{app}: Container created
  Normal   Started    2m38s (x6 over 5m28s)  kubelet            spec.containers{app}: Container started
  Normal   Pulled     2m38s (x5 over 5m28s)  kubelet            spec.containers{app}: Container image "busybox:1.36" already present on machine and can be accessed by the pod
  Warning  BackOff    83s (x6 over 5m28s)    kubelet            spec.containers{app}: Back-off restarting failed container app in pod crash_default(e3d19690-7c09-4a3c-bde6-41db6f775cbd)
$ kubectl get pod crash
NAME    READY   STATUS             RESTARTS        AGE
crash   0/1     CrashLoopBackOff   5 (2m38s ago)   5m30s
