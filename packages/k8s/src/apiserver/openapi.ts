// The API server's OpenAPI v3 endpoints: `/openapi/v3`, the index of documents, and
// `/openapi/v3/<api/v1 | apis/<group>/<version>>`, one document per served group version.
// These are non-resource requests: they do not pass through the resource pipeline (pipeline.ts).
//   upstream: staging/src/k8s.io/client-go/openapi/client.go PathsWithContext (GET /openapi/v3,
//             decoded as kube-openapi handler3.OpenAPIV3Discovery: {"paths": {<path>:
//             {"serverRelativeURL": …}}}), groupversion.go SchemaWithContext (GET of that URL)
// The documents are rebuilt from vendored data (openapi/v3.ts), which keeps the schema keys
// kubectl explain reads and each operation's GVK. Divergences: the index lists the group
// versions only (not `api`, `apis`, `apis/<group>`, `version`, `logs`, the OIDC paths), its URLs
// carry no `?hash=` (the real one is the SHA-512 of the real document), and the documents lack
// parameters, responses, formats, defaults and the other x-kubernetes annotations.

import type { JsonObject } from '../apimachinery/json.ts';
import { openApiV3Document, openApiV3Paths } from '../openapi/v3.ts';
import type { ApiServerConfig } from './config.ts';
import type { ApiResponse } from './types.ts';

const PREFIX = '/openapi/v3';

/** A GET of an OpenAPI v3 path (a query string is ignored). */
export function getOpenApiV3(_server: ApiServerConfig, url: string): ApiResponse {
  const path = url.replace(/\?.*$/, '');
  if (path === PREFIX || path === `${PREFIX}/`) {
    const paths: JsonObject = {};
    for (const p of openApiV3Paths()) paths[p] = { serverRelativeURL: `${PREFIX}/${p}` };
    return { ok: true, code: 200, object: { paths }, warnings: [] };
  }
  if (path.startsWith(`${PREFIX}/`)) {
    const doc = openApiV3Document(path.slice(PREFIX.length + 1));
    if (doc) return { ok: true, code: 200, object: doc, warnings: [] };
  }
  return { ok: false, code: 0, notSimulated: `the request GET ${path}`, warnings: [] };
}
