# kubectl edit: the file kubectl writes (shown with cat as the editor), the editor answered through
# the editor protocol (@editor: vi, the default, opens it), a change sent as a patch, the reopen
# with the reasons after an invalid file, the copy kept when the editor then quits, and the errors.
# Output lines and errors: fixtures/golden/v1.37.2/change/edit.yaml (the same paths with editor
# scripts against the real kubectl); upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/editor/
# editoptions.go, editor.go, launcher_others.go.
# file: drop-mode.sh
# file: drop-name.sh
% kubectl create configmap settings --from-literal=mode=fast --from-literal=size=10
$ KUBE_EDITOR=cat kubectl edit configmap settings
\# Please edit the object below. Lines beginning with a '#' will be ignored,
\# and an empty file will abort the edit. If an error occurs while saving this file will be
\# reopened with the relevant failures.
\#
apiVersion: v1
data:
  mode: fast
  size: "10"
kind: ConfigMap
metadata:
  creationTimestamp: "<<time>>"
  name: settings
  namespace: default
  resourceVersion: "<<rv>>"
  uid: <<uid:1>>
Edit cancelled, no changes made.
# vi opens the file; quitting without saving changes nothing.
@editor :q!
$ kubectl edit configmap settings
Edit cancelled, no changes made.
# An editor script drops a key: the patch is sent, and --output-patch shows it.
$ KUBE_EDITOR='bash drop-mode.sh' kubectl edit configmap settings --output-patch
Patch: {"data":{"mode":null}}
configmap/settings edited
$ kubectl get configmap settings -o yaml | grep -A2 '^data'
data:
  size: "10"
kind: ConfigMap
# A file that does not parse: kubectl reports it and opens the editor again with the reasons on
# top; quitting then keeps a copy.
@editor <<EOF
data: [
EOF
@editor :q!
$ kubectl edit configmap settings
error: configmaps "settings" is invalid
A copy of your changes has been stored to "/tmp/kubectl-edit-<<tmp>>.yaml"
error: Edit cancelled, no valid changes were saved.
[exit 1]
# An empty file is not an object either.
@editor <<EOF
EOF
@editor :q!
$ EDITOR=nano kubectl edit configmap settings
error: configmaps "settings" is invalid
A copy of your changes has been stored to "/tmp/kubectl-edit-<<tmp>>.yaml"
error: Edit cancelled, no valid changes were saved.
[exit 1]
# The name may not change.
$ KUBE_EDITOR='bash drop-name.sh' kubectl edit configmap settings
A copy of your changes has been stored to "/tmp/kubectl-edit-<<tmp>>.yaml"
error: At least one of apiVersion, kind and name was changed
[exit 1]
$ KUBE_EDITOR=nope kubectl edit configmap settings
error: unable to launch the editor "nope"
[exit 1]
$ KUBE_EDITOR=false kubectl edit configmap settings
error: there was a problem with the editor "false"
[exit 1]
$ kubectl edit configmap nope
Error from server (NotFound): configmaps "nope" not found
[exit 1]
$ kubectl edit
error: You must provide one or more resources by argument or filename.
Example resource specifications include:
   '-f rsrc.yaml'
   '--filename=rsrc.json'
   '<resource> <name>'
   '<resource>'
[exit 1]
