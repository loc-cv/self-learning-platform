# kubectl version against the cluster's API server and against nothing. Texts:
# fixtures/golden/v1.37.2/info/version.yaml, info/no-server.yaml.
$ kubectl version
Client Version: v1.37.2
Kustomize Version: v5.8.1
Server Version: v1.37.2
$ kubectl version --client -o json
{
  "clientVersion": {
    "major": "1",
    "minor": "37",
    "gitVersion": "v1.37.2",
    "gitCommit": "c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32",
    "gitTreeState": "clean",
    "buildDate": "2026-10-27T12:04:48Z",
    "goVersion": "go1.26.10",
    "compiler": "gc",
    "platform": "linux/amd64"
  },
  "kustomizeVersion": "v5.8.1"
}
$ kubectl version -o yaml | grep -A3 serverVersion
serverVersion:
  buildDate: "2026-10-27T12:01:06Z"
  compiler: gc
  emulationMajor: "1"
$ kubectl version extra
error: extra arguments: [extra]
[exit 1]
$ kubectl version --client extra
Client Version: v1.37.2
Kustomize Version: v5.8.1
$ kubectl version -o xml
error: --output must be 'yaml' or 'json'
[exit 1]
$ kubectl version --server https://172.16.0.10:6444
Client Version: v1.37.2
Kustomize Version: v5.8.1
The connection to the server 172.16.0.10:6444 was refused - did you specify the right host or port?
[exit 1]
