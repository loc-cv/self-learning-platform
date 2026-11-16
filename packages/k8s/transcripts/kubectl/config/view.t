# kubectl config view: kubeadm's kubeconfig, a second file merged in, minified, flattened.
# kubeadm's user has no certificate data in the simulator (STATUS.md, D-057), so it prints as {}.
# Texts: fixtures/golden/v1.37.2/config/view.yaml.
# file: team.yaml
# file: certs/ca.crt
$ kubectl config view
apiVersion: v1
clusters:
- cluster:
    server: https://172.16.0.10:6443
  name: kubernetes
contexts:
- context:
    cluster: kubernetes
    user: kubernetes-admin
  name: kubernetes-admin@kubernetes
current-context: kubernetes-admin@kubernetes
kind: Config
users:
- name: kubernetes-admin
  user: {}
$ KUBECONFIG=~/.kube/config:team.yaml kubectl config view
apiVersion: v1
clusters:
- cluster:
    server: https://172.16.0.10:6443
  name: kubernetes
- cluster:
    certificate-authority: certs/ca.crt
    server: https://10.0.0.5:6443
  name: staging
contexts:
- context:
    cluster: staging
    namespace: team-a
    user: dev
  name: dev@staging
- context:
    cluster: kubernetes
    user: kubernetes-admin
  name: kubernetes-admin@kubernetes
current-context: kubernetes-admin@kubernetes
kind: Config
users:
- name: dev
  user:
    token: REDACTED
- name: kubernetes-admin
  user: {}
$ KUBECONFIG=~/.kube/config:team.yaml kubectl config view --minify --context dev@staging --raw -o json
{
    "kind": "Config",
    "apiVersion": "v1",
    "clusters": [
        {
            "name": "staging",
            "cluster": {
                "server": "https://10.0.0.5:6443",
                "certificate-authority": "certs/ca.crt"
            }
        }
    ],
    "users": [
        {
            "name": "dev",
            "user": {
                "token": "abc123"
            }
        }
    ],
    "contexts": [
        {
            "name": "dev@staging",
            "context": {
                "cluster": "staging",
                "user": "dev",
                "namespace": "team-a"
            }
        }
    ],
    "current-context": "dev@staging"
}
$ kubectl config view --kubeconfig team.yaml --flatten | grep certificate-authority
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUIKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=
$ kubectl config view --minify --kubeconfig team.yaml
error: current-context must exist in order to minify
[exit 1]
$ kubectl config view --merge=false
error: if merge==false a precise file must be specified
[exit 1]
$ kubectl config view -o jsonpath='{.users[*].name}'
[sim] kubectl: the output format "jsonpath" is not simulated yet
[exit 250]
