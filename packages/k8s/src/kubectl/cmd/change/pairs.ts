// Resource arguments and KEY=VALUE / KEY- arguments, as the commands that take both split them.
//   upstream: staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go GetResourcesAndPairs

import { messageError, type KubectlError } from '../../cli/errors.ts';

/** GetResourcesAndPairs: everything before the first pair is a resource; nothing may follow the pairs. */
export function resourcesAndPairs(args: readonly string[], pairType: string): { resources: string[]; pairs: string[] } | KubectlError {
  const resources: string[] = [];
  const pairs: string[] = [];
  let foundPair = false;
  for (const s of args) {
    const nonResource = (s.includes('=') && s[0] !== '=') || (s.endsWith('-') && s !== '-');
    if (nonResource) {
      foundPair = true;
      pairs.push(s);
    } else if (!foundPair) resources.push(s);
    else return messageError(`all resources must be specified before ${pairType} changes: ${s}`);
  }
  return { resources, pairs };
}
