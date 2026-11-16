# A rollout story with kubectl apply: a Deployment rolls out, a second manifest changes the image,
# a third names a tag the registry does not have and the rollout stalls until its progress deadline;
# rollout history shows the change-cause each manifest set, undo goes back, restart rolls the same
# template again. The progress lines while a rollout runs are printed once per watch event, as
# upstream does; they depend on timing and come from upstream source
# (staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollout_status.go
# DeploymentStatusViewer.Status); the rest from the golden fixtures rollout/history-undo,
# rollout/pause-restart and controllers/rollout-stuck (fixtures/golden/v1.37.2).
# file: web-1.yaml
# file: web-2.yaml
# file: web-bad.yaml
# settle: 10
$ kubectl apply -f web-1.yaml
deployment.apps/web created
$ kubectl rollout status deployment/web
Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "web" rollout to finish: 0 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 0 of 3 updated replicas are available...
Waiting for deployment "web" rollout to finish: 1 of 3 updated replicas are available...
Waiting for deployment "web" rollout to finish: 2 of 3 updated replicas are available...
deployment "web" successfully rolled out
$ kubectl get rs
NAME             DESIRED   CURRENT   READY   AGE
web-69c6f74b8b   3         3         3       4s
# The second manifest changes the image: a rolling update, 25% surge and unavailability of 3.
$ kubectl apply -f web-2.yaml
deployment.apps/web configured
$ kubectl rollout status deploy/web
Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "web" rollout to finish: 0 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
deployment "web" successfully rolled out
$ kubectl rollout history deployment/web
deployment.apps/web 
REVISION  CHANGE-CAUSE
1         deploy nginx 1.27
2         upgrade to nginx 1.28

# A tag that does not exist: one new Pod cannot pull its image, the rollout makes no progress, and
# after progressDeadlineSeconds (120 here) the controller marks it ProgressDeadlineExceeded.
$ kubectl apply -f web-bad.yaml
deployment.apps/web configured
$ kubectl rollout status deployment/web
Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "web" rollout to finish: 0 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
error: deployment "web" exceeded its progress deadline
[exit 1]
$ kubectl get pods
NAME                   READY   STATUS             RESTARTS   AGE
web-6f9bcdc979-2fgwm   1/1     Running            0          2m9s
web-6f9bcdc979-j4cbs   1/1     Running            0          2m5s
web-6f9bcdc979-mlk2t   1/1     Running            0          2m2s
web-d9bf66b6c-7qwjk    0/1     ImagePullBackOff   0          2m1s
$ kubectl rollout history deployment/web
deployment.apps/web 
REVISION  CHANGE-CAUSE
1         deploy nginx 1.27
2         upgrade to nginx 1.28
3         try nginx 1.99

$ kubectl rollout history deployment/web --revision=3
deployment.apps/web with revision #3
Pod Template:
  Labels:	app=web
	pod-template-hash=d9bf66b6c
  Annotations:	kubernetes.io/change-cause: try nginx 1.99
  Containers:
   nginx:
    Image:	nginx:1.99
    Port:	<none>
    Host Port:	<none>
    Environment:	<none>
    Mounts:	<none>
  Volumes:	<none>
  Node-Selectors:	<none>
  Tolerations:	<none>

# Undo goes back to the previous revision's template; the Deployment was applied, so kubectl warns.
$ kubectl rollout undo deployment/web
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
deployment.apps/web rolled back
$ kubectl rollout status deployment/web
Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
deployment "web" successfully rolled out
$ kubectl rollout history deployment/web
deployment.apps/web 
REVISION  CHANGE-CAUSE
1         deploy nginx 1.27
3         try nginx 1.99
4         upgrade to nginx 1.28

$ kubectl get rs
NAME             DESIRED   CURRENT   READY   AGE
web-69c6f74b8b   0         0         0       2m13s
web-6f9bcdc979   3         3         3       2m9s
web-d9bf66b6c    0         0         0       2m1s
$ kubectl rollout undo deployment/web --to-revision=4
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
deployment.apps/web skipped rollback (current template already matches revision 4)
# Restart puts a timestamp into the template: the same image rolls out as a new revision.
$ kubectl rollout restart deployment/web
deployment.apps/web restarted
$ kubectl rollout status deployment/web --timeout=2m
Waiting for deployment spec update to be observed...
Waiting for deployment spec update to be observed...
Waiting for deployment "web" rollout to finish: 0 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
deployment "web" successfully rolled out
$ kubectl get deployment web -o yaml | grep restartedAt
        kubectl.kubernetes.io/restartedAt: "2026-11-13T09:02:28Z"
$ kubectl rollout history deployment/web
deployment.apps/web 
REVISION  CHANGE-CAUSE
1         deploy nginx 1.27
3         try nginx 1.99
4         upgrade to nginx 1.28
5         upgrade to nginx 1.28

