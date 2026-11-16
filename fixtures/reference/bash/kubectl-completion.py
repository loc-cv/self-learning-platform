# Ground truth for kubectl's tab completion in bash (packages/k8s/src/kubectl/completion, phase 08):
# the bytes the real bash writes for given keys when kubectl's completion script is loaded the
# documented way, with the real kubectl answering `__complete` against a real API server.
# Capture (from the repository root, with an oracle up: npm run oracle -- up, then its env):
#   KUBECONFIG=<oracle dir>/admin.conf python3 -I fixtures/reference/bash/kubectl-completion.py \
#     > fixtures/reference/bash/kubectl-completion.json
# Recorded with bash 5.2.21, bash-completion 2.11 (/usr/share/bash-completion/bash_completion),
# kubectl v1.37.2 (.upstream/bin/v1.37.2/kubectl), Python 3.12.3, locale C.UTF-8.
#
# The terminal, the shell and the way keys are sent and output collected are readline.py's (this
# script imports it). The environment adds KUBECONFIG and puts the pinned kubectl first in PATH.
# Before the cases the script creates, on that server: Pods web-1, web-2 and api in default, the
# namespace team-a with Pods db and cache, and the Deployment frontend (0 replicas).
# Each case starts a fresh shell and types SETUP: the documented setup (bash-completion, then
# `source <(kubectl completion bash)`, `alias k=kubectl`, `complete -o default -F __start_kubectl
# k`), a literal prompt, and a working directory `work` with the files the cases complete. Each
# Tab is collected for at least TAB_WAIT seconds, since kubectl answers it.
import datetime, importlib.util, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
spec = importlib.util.spec_from_file_location("readline_capture", os.path.join(HERE, "readline.py"))
rl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rl)

BIN = os.path.join(ROOT, ".upstream", "bin", "v1.37.2")
KUBECTL = os.path.join(BIN, "kubectl")
TAB_WAIT = 1.0
FILES = "touch a.yaml b.yml c.json notes.txt Upper.YAML mixed.Yaml dot. && mkdir dir"
SETUP = ("PS1='student@node01:~$ '; source /usr/share/bash-completion/bash_completion; "
         "source <(kubectl completion bash); alias k=kubectl; complete -o default -F __start_kubectl k; "
         "mkdir work && cd work && " + FILES + "; clear")
OBJECTS = """
apiVersion: v1
kind: Namespace
metadata: {name: team-a}
---
apiVersion: v1
kind: Pod
metadata: {name: web-1, namespace: default}
spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
---
apiVersion: v1
kind: Pod
metadata: {name: web-2, namespace: default}
spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
---
apiVersion: v1
kind: Pod
metadata: {name: api, namespace: default}
spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
---
apiVersion: v1
kind: Pod
metadata: {name: db, namespace: team-a}
spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
---
apiVersion: v1
kind: Pod
metadata: {name: cache, namespace: team-a}
spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: frontend, namespace: default}
spec:
  replicas: 0
  selector: {matchLabels: {app: frontend}}
  template:
    metadata: {labels: {app: frontend}}
    spec: {containers: [{name: nginx, image: "nginx:1.27"}]}
"""


def T(n=1):
    """n Tabs, each collected for TAB_WAIT seconds."""
    return [rl.W("\t", TAB_WAIT)] * n


CASES = [
    dict(name="verb-unique", keys=["kubectl ge"] + T()),
    dict(name="verbs-with-descriptions", note="r: replace, rollout, run share only r; the second Tab lists them with descriptions.",
         keys=["kubectl r"] + T(2)),
    dict(name="verbs-narrow", cols=40, note="The descriptions are cut to the 40 columns with an ellipsis.",
         keys=["kubectl r"] + T(2)),
    dict(name="subcommand-prefix", keys=["kubectl rollout re"] + T(3)),
    dict(name="resource-type-prefix", note="po: the first Tab inserts the common prefix pod, the third lists.",
         keys=["kubectl get po"] + T(3)),
    dict(name="resource-types-all", keys=["kubectl describe "] + T(2)),
    dict(name="pod-names", keys=["kubectl get pods "] + T(2)),
    dict(name="pod-names-prefix", keys=["kubectl get pods w"] + T(3)),
    dict(name="pod-names-namespace-before", keys=["kubectl -n team-a get pods "] + T(2)),
    dict(name="namespaces-after-n", keys=["kubectl get pods -n "] + T(2)),
    dict(name="namespace-after-n-unique", keys=["kubectl get pods -n te"] + T()),
    dict(name="namespace-equals", keys=["kubectl get pods --namespace=te"] + T()),
    dict(name="type-slash-name", keys=["kubectl rollout status deployment/"] + T()),
    dict(name="type-list-escaped", note="One match left: printf %q escapes the comma.",
         keys=["kubectl get pods,secr"] + T()),
    dict(name="type-list-several", keys=["kubectl get pods,se"] + T(2)),
    dict(name="logs-pods-and-types", keys=["kubectl logs "] + T(2)),
    dict(name="logs-type-nospace", keys=["kubectl logs dep"] + T()),
    dict(name="output-formats", keys=["kubectl get pods -o j"] + T(3)),
    dict(name="required-flag", keys=["kubectl create deployment "] + T()),
    dict(name="flag-name-unique", keys=["kubectl get --show-l"] + T()),
    dict(name="flag-names", rows=60, note="60 rows, so the list needs no pager. The candidates end at the first colon of the output.",
         keys=["kubectl get --"] + T(2)),
    dict(name="filename-filter", note="-f: json, yaml and yml files, either case, a name ending in a dot, and directories.",
         keys=["kubectl apply -f "] + T(2)),
    dict(name="filename-unique", keys=["kubectl apply -f a"] + T()),
    dict(name="filename-directory", keys=["kubectl apply -f d"] + T()),
    dict(name="filename-fallback", note="No json/yaml/yml file or directory starts with n: -o default completes any file.",
         keys=["kubectl apply -f n"] + T()),
    dict(name="context", keys=["kubectl config use-context "] + T()),
    dict(name="alias-type-prefix", keys=["k get po"] + T()),
    dict(name="alias-pod-names", keys=["k get pods w"] + T()),
    dict(name="alias-namespace-before", keys=["k -n team-a get pods "] + T(2)),
    dict(name="unknown-command-files", note="No such command: the directive is 0 and -o default completes file names.",
         keys=["kubectl bogus "] + T(2)),
]


def main():
    if "KUBECONFIG" not in os.environ:
        raise SystemExit("set KUBECONFIG to an oracle's kubeconfig (npm run oracle -- up)")
    kubeconfig = os.environ["KUBECONFIG"]
    env = {"PATH": BIN + ":/usr/bin:/bin", "KUBECONFIG": kubeconfig, "HOME": "/nonexistent"}
    subprocess.run([KUBECTL, "apply", "-f", "-"], input=OBJECTS, text=True, env=env, check=True, capture_output=True)
    cases = []
    for c in CASES:
        case = dict(c)
        res = run_case(case, kubeconfig)
        cases.append(res)
    version = subprocess.run(["/bin/bash", "--version"], capture_output=True, text=True, env={"LANG": "C.UTF-8"}).stdout.splitlines()[0]
    json.dump({"captured": datetime.date.today().isoformat(), "bash": version, "kubectl": "v1.37.2", "setup": SETUP, "cases": cases},
              sys.stdout, indent=2, ensure_ascii=True)
    sys.stdout.write("\n")


def spawn(home, cols, rows, kubeconfig):
    """readline.py's spawn, with KUBECONFIG and the pinned kubectl first in PATH."""
    import fcntl, pty, signal, struct, termios
    env = {"HOME": home, "PATH": BIN + ":" + rl.ENV_PATH, "LANG": "C.UTF-8", "TERM": "xterm-256color",
           "INPUTRC": "/dev/null", "USER": "student", "LOGNAME": "student", "SHELL": "/bin/bash", "TZ": "UTC",
           "KUBECONFIG": kubeconfig}
    pid, fd = pty.fork()
    if pid == 0:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.chdir(home)
        os.umask(0o022)
        os.execve("/bin/bash", ["-bash", "--noprofile", "--norc", "-i"], env)
    return pid, fd


def run_case(case, kubeconfig):
    """readline.py's run_case with this script's setup line instead of its own."""
    cols, rows = case.get("cols", 80), case.get("rows", 24)
    import tempfile
    with tempfile.TemporaryDirectory(prefix="simlab-kubectl-completion-") as tmp:
        home = os.path.join(tmp, "home", "student")
        os.makedirs(home)

        def text(b):
            return b.decode("utf-8", "backslashreplace").replace(tmp, "")

        pid, fd = spawn(home, cols, rows, kubeconfig)
        try:
            out = rl.read_until(fd, b"$ ")
            os.write(fd, SETUP.encode() + b"\r")
            out += rl.read_until(fd, rl.PROMPT)
            more, _ = rl.read_quiet(fd)
            if more:
                raise SystemExit("%s: output after the prompt: %r" % (case["name"], more))
            keys, outputs = [], []
            for k in case["keys"]:
                key, wait = k if isinstance(k, tuple) else (k, 0.0)
                os.write(fd, key.encode())
                got, _ = rl.read_quiet(fd, at_least=wait)
                keys.append(key)
                outputs.append(text(got))
        finally:
            rl.finish(pid, fd, False)
    res = {"name": case["name"]}
    if case.get("note"):
        res["note"] = case["note"]
    res.update(cols=cols, rows=rows, keys=keys, outputs=outputs)
    return res


if __name__ == "__main__":
    main()
