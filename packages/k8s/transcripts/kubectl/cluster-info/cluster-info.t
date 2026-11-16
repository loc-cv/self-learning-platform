# kubectl cluster-info: the control plane and the Services labelled as cluster services. kubeadm's
# kube-dns Service carries kubernetes.io/cluster-service=true and kubernetes.io/name=CoreDNS.
# Texts: fixtures/golden/v1.37.2/info/cluster-info.yaml, info/no-server.yaml.
$ kubectl cluster-info
Kubernetes control plane is running at https://172.16.0.10:6443
CoreDNS is running at https://172.16.0.10:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy

To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
$ kubectl cluster-info -n default
Kubernetes control plane is running at https://172.16.0.10:6443

To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
$ kubectl cluster-info --server https://172.16.0.11:6443 2>/dev/null

To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
[exit 1]
$ kubectl cluster-info dump
[sim] kubectl: the command "kubectl cluster-info dump" is not simulated yet
[exit 250]
