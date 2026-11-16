# kubectl create configmap and create secret generic: keys from literals, files (by basename or
# key=path), directories (each regular file) and env files (comments and blank lines skipped, a
# bare name taken from kubectl's environment), --append-hash, and the client-side errors.
# file: app.properties
# file: conf/a.txt
# file: conf/b.conf
# file: conf/sub/c.txt
# file: app.env
# settle: 0
# Texts from the golden fixtures generate/client, generate/create and client/yaml-output
# (fixtures/golden/v1.37.2); the bare env-file name follows env_file.go processEnvFileLine
# (os.Getenv).
$ kubectl create configmap app --from-file=app.properties --from-file=greeting=conf/a.txt --from-literal=mode=prod
configmap/app created
$ kubectl get configmap app -o yaml | grep -v -e uid -e resourceVersion -e creationTimestamp
apiVersion: v1
data:
  app.properties: |
    color=blue
    size=10
  greeting: |
    alpha
  mode: prod
kind: ConfigMap
metadata:
  name: app
  namespace: default
$ kubectl create configmap conf --from-file=conf --dry-run=client -o yaml
apiVersion: v1
data:
  a.txt: |
    alpha
  b.conf: bravo
kind: ConfigMap
metadata:
  name: conf
$ FROM_SHELL=exported kubectl create configmap env --from-env-file=app.env --dry-run=client -o yaml
apiVersion: v1
data:
  FROM_SHELL: exported
  LEVEL: debug
  MODE: prod
  URL: http://x?a=b
kind: ConfigMap
metadata:
  name: env
$ kubectl create configmap env --from-env-file=app.env --dry-run=client -o json
{
    "kind": "ConfigMap",
    "apiVersion": "v1",
    "metadata": {
        "name": "env"
    },
    "data": {
        "FROM_SHELL": "",
        "LEVEL": "debug",
        "MODE": "prod",
        "URL": "http://x?a=b"
    }
}
$ kubectl create configmap hashed --from-literal=a=1 --append-hash
configmap/hashed-tt42b4m6hd created
$ kubectl create cm app --from-literal=a=b
error: failed to create configmap: configmaps "app" already exists
[exit 1]
$ kubectl create configmap bad --from-literal=novalue
error: invalid literal source novalue, expected key=value
[exit 1]
$ kubectl create configmap bad --from-literal='my key=1'
error: "my key" is not a valid key name for a ConfigMap: a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')
[exit 1]
$ kubectl create configmap bad --from-literal=a=1 --from-literal=a=2
error: cannot add key "a", another key by that name already exists in Data for ConfigMap "bad"
[exit 1]
$ kubectl create configmap bad --from-file=missing.txt
error: error reading missing.txt: no such file or directory
[exit 1]
$ kubectl create configmap bad --from-file=key=conf
error: cannot give a key name for a directory path
[exit 1]
$ kubectl create configmap bad --from-env-file=conf
error: env config file cannot be a directory
[exit 1]
$ kubectl create configmap bad --from-env-file=app.env --from-literal=a=b
error: from-env-file cannot be combined with from-file or from-literal
[exit 1]
# Secrets: the same sources, values in base64; --type sets the type.
$ kubectl create secret generic creds --from-literal=user=admin --from-literal=pass='s3cr3t!' -o yaml | grep -A3 '^data:'
data:
  pass: czNjcjN0IQ==
  user: YWRtaW4=
kind: Secret
$ kubectl create secret generic files --from-file=conf --type=example.com/files --dry-run=client -o yaml
apiVersion: v1
data:
  a.txt: YWxwaGEK
  b.conf: YnJhdm8=
kind: Secret
metadata:
  name: files
type: example.com/files
$ kubectl create secret generic hashed --from-literal=a=b --append-hash -o name
secret/hashed-cgm2t8ff2d
$ kubectl create secret generic creds --from-literal=a=b
error: failed to create secret secrets "creds" already exists
[exit 1]
$ kubectl create secret generic bad --from-literal='my key=1'
error: "my key" is not valid key name for a Secret a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')
[exit 1]
$ kubectl create secret generic bad --from-literal=a=1 --from-file=a=app.properties
error: cannot add key a, another key by that name already exists
[exit 1]
$ kubectl create secret generic tls --type=kubernetes.io/tls --from-literal=a=b
error: failed to create secret Secret "tls" is invalid: [data[tls.crt]: Required value, data[tls.key]: Required value]
[exit 1]
$ kubectl get configmaps,secrets -l '!x'
NAME                          DATA   AGE
configmap/app                 3      0s
configmap/hashed-tt42b4m6hd   1      0s

NAME                       TYPE     DATA   AGE
secret/creds               Opaque   2      0s
secret/hashed-cgm2t8ff2d   Opaque   1      0s
