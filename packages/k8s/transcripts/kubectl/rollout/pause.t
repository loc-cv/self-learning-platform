# Pausing a rollout: while a Deployment is paused, a template change starts no rollout (the
# controller sets Progressing to DeploymentPaused), restart is refused, undo finds no earlier
# revision (it looks before it checks the pause), and resuming rolls the change out. Texts from
# the golden fixtures rollout/pause-restart and controllers/paused
# (fixtures/golden/v1.37.2); the progress lines from upstream source
# (polymorphichelpers/rollout_status.go DeploymentStatusViewer.Status).
# file: web-1.yaml
# file: web-2.yaml
% kubectl apply -f web-1.yaml
% kubectl rollout status deployment/web
$ kubectl rollout pause deployment/web
deployment.apps/web paused
$ kubectl rollout pause deployment/web
error: deployments.apps "web" is already paused
[exit 1]
$ kubectl apply -f web-2.yaml
deployment.apps/web configured
$ sleep 5
$ kubectl get rs
NAME             DESIRED   CURRENT   READY   AGE
web-69c6f74b8b   3         3         3       9s
$ kubectl get deployment web -o yaml | grep -A1 'reason: DeploymentPaused'
    reason: DeploymentPaused
    status: Unknown
$ kubectl rollout status deployment/web --watch=false
Waiting for deployment "web" rollout to finish: 0 out of 3 new replicas have been updated...
$ kubectl rollout restart deployment/web
error: deployments.apps "web" can't restart paused deployment (run rollout resume first)
[exit 1]
$ kubectl rollout undo deployment/web
Warning: resource deployments/web was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.
error: no rollout history found for deployment "web"
[exit 1]
$ kubectl rollout resume deployment/web -o name
deployment.apps/web
$ kubectl rollout resume deployment/web
error: deployments.apps "web" is not paused
[exit 1]
$ kubectl rollout status deployment/web
Waiting for deployment spec update to be observed...
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

