// What the real kubectl binary of the pin reports about itself: its version.Info (set by the
// release build's ldflags) and the Kustomize version it was built with.
//   reference: .upstream/bin/v1.37.2/kubectl version --client -o json, run 2026-11-16 with a scratch
//              HOME (fixtures/golden/v1.37.2/info/no-server.yaml; the fixture normalizes buildDate)
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/version/version.go getKustomizeVersion (the
//             module version from debug.ReadBuildInfo; kustomizeVersion "v5.8.1" is the fallback)

import type { JsonObject } from '../../../apimachinery/json.ts';

/** apimachinery version.Info of the client, in its JSON field order. */
export const CLIENT_VERSION_INFO: JsonObject = {
  major: '1',
  minor: '37',
  gitVersion: 'v1.37.2',
  gitCommit: 'c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32',
  gitTreeState: 'clean',
  buildDate: '2026-10-27T12:04:48Z',
  goVersion: 'go1.26.10',
  compiler: 'gc',
  platform: 'linux/amd64',
};

export const KUSTOMIZE_VERSION = 'v5.8.1';
