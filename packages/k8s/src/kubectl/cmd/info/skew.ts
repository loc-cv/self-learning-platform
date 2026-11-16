// kubectl version's warning when client and server are further apart than the supported skew.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/version/skew_warning.go getVersionSkewWarning,
//             supportedMinorVersionSkew
//   upstream: staging/src/k8s.io/apimachinery/pkg/util/version/version.go ParseSemantic (the
//             semver grammar: major.minor.patch, optional -pre-release and +build metadata)

const SUPPORTED_MINOR_VERSION_SKEW = 1;

// semverRegexp: a leading "v" is accepted (ParseSemantic strips it), numbers without leading zeros.
const SEMVER = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function majorMinor(gitVersion: string): [number, number] | undefined {
  const m = SEMVER.exec(gitVersion);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * The warning text, '' when within the skew, or undefined when a version does not parse (the real
 * command then fails with ParseSemantic's error, which the simulator's fixed versions never reach).
 */
export function versionSkewWarning(clientGitVersion: string, serverGitVersion: string): string | undefined {
  const c = majorMinor(clientGitVersion);
  const s = majorMinor(serverGitVersion);
  if (!c || !s) return undefined;
  if (c[0] !== s[0] || Math.abs(c[1] - s[1]) > SUPPORTED_MINOR_VERSION_SKEW) {
    return `version difference between client (${c[0]}.${c[1]}) and server (${s[0]}.${s[1]}) exceeds the supported minor version skew of +/-${SUPPORTED_MINOR_VERSION_SKEW}`;
  }
  return '';
}
