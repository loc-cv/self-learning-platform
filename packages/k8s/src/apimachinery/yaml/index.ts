// kubectl's YAML and JSON: encoding for -o yaml / -o json, decoding of manifests and kubeconfig
// files. See encode.ts, jsonprint.ts, decode.ts and stream.ts for the upstream each one ports.

export { marshalYaml, YamlMarshalError } from './encode.ts';
export { marshalIndentJson, printJson } from './jsonprint.ts';
export { unmarshalYaml, yamlToJson, type YamlResult } from './decode.ts';
export { decodeManifestStream, splitYamlDocuments, type StreamResult } from './stream.ts';
export { YAML_JSON_PROVENANCE } from './provenance.ts';
