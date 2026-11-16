# kubectl explain through `alias k=kubectl`; a field path in JSONPath syntax the simulator does
# not parse and the OpenAPI v2 renderer print a notice; the JSONPath errors for a wildcard and a
# repeated recursive descent, an escaped dot, --max-depth with --recursive, and an unknown -o.
# The explain output itself is golden-verified by fixtures/golden/v1.37.2/explain/; the rest is
# source-derived: staging/src/k8s.io/client-go/util/jsonpath/parser.go (parseField, advance,
# parseRecursive), staging/src/k8s.io/kubectl/pkg/explain/explain.go, explain/v2/generator.go Render.
$ alias k=kubectl
$ k explain deploy.spec.strategy.type
GROUP:      apps
KIND:       Deployment
VERSION:    v1

FIELD: type <string>
ENUM:
    Recreate
    RollingUpdate

DESCRIPTION:
    Type of deployment. Can be "Recreate" or "RollingUpdate". Default is
    RollingUpdate.
    
    Possible enum values:
     - `"Recreate"` Kill all existing pods before creating new ones.
     - `"RollingUpdate"` Replace the old ReplicaSets by new one using rolling
    update i.e gradually scale down the old ReplicaSets and scale up the new
    one.
    

$ kubectl explain 'pods.spec.containers[0]'
[sim] kubectl: the field path syntax of "pods.spec.containers[0]" is not simulated yet
[exit 250]
$ kubectl explain deploy -o plaintext-openapiv2
[sim] kubectl: the output format "plaintext-openapiv2" is not simulated yet
[exit 250]
$ kubectl explain 'pods.spec.*'
error: invalid jsonpath syntax, first node must be field node
[exit 1]
$ kubectl explain 'pods....spec'
error: invalid multiple recursive descent
[exit 1]
$ kubectl explain 'pods.spec\.x'
KIND:       Pod
VERSION:    v1

error: field "spec.x" does not exist
[exit 1]
$ kubectl explain pods.spec.containers.ports --recursive --max-depth=1
KIND:       Pod
VERSION:    v1

FIELD: ports <[]ContainerPort>


DESCRIPTION:
    List of ports to expose from the container. Not specifying a port here DOES
    NOT prevent that port from being exposed. Any port which is listening on the
    default "0.0.0.0" address inside a container will be accessible from the
    network. Modifying this array with strategic merge patch may corrupt the
    data. For more information See
    https://github.com/kubernetes/kubernetes/issues/108255. Cannot be updated.
    ContainerPort represents a network port in a single container.
    
FIELDS:
  containerPort	<integer> -required-
  hostIP	<string>
  hostPort	<integer>
  name	<string>
  protocol	<string>
  enum: SCTP, TCP, UDP

$ kubectl explain svc --api-version=v1 --output=yaml
error: unrecognized format: yaml
[exit 1]
