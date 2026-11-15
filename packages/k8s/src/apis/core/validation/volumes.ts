// Pod volumes. upstream: pkg/apis/core/validation/validation.go ValidateVolumes,
// validateVolumeSource, validateHostPathVolumeSource, validateHostPathType, validateGitRepoVolumeSource,
// validateSecretVolumeSource, validateConfigMapVolumeSource, validateKeyToPath,
// validatePersistentClaimVolumeSource, validateNFSVolumeSource, validateDownwardAPIVolumeFile,
// validateDownwardAPIVolumeSource, validateProjectionSources, validateProjectedVolumeSource,
// validateImageVolumeSource.
//
// The source checks run in validateVolumeSource's order; the "may not specify more than 1 volume
// type" paths keep upstream's spelling (`downwarAPI`, `cephFS`). Sources whose own checks are not
// ported (cloud and network block storage, CSI, generic ephemeral) are counted and logged as gaps.

import { forbidden, invalid, notSupported, required, duplicate, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { parseQuantity, sign } from '../../../apimachinery/quantity.ts';
import { validateObjectFieldSelector, validateContainerResourceFieldSelector, VALID_CONTAINER_RESOURCE_FIELD_PATHS } from './fieldselectors.ts';
import type { PodValidationOptions } from './options.ts';
import {
  EMPTY_DIR_MODE_ERROR,
  FILE_MODE_ERROR,
  isSet,
  obj,
  objs,
  str,
  validateDNS1123Label,
  validateLocalDescendingPath,
  validateLocalNonReservedPath,
  validatePathNoBacksteps,
  validateUserField,
} from './util.ts';

/** validVolumeDownwardAPIFieldPathExpressions. */
const VOLUME_DOWNWARD_API_FIELD_PATHS = ['metadata.name', 'metadata.namespace', 'metadata.labels', 'metadata.annotations', 'metadata.uid'];

/** supportedHostPathTypes, as sets.List sorts it. */
const HOST_PATH_TYPES = ['', 'BlockDevice', 'CharDevice', 'Directory', 'DirectoryOrCreate', 'File', 'FileOrCreate', 'Socket'];

/** The VolumeSource members in validateVolumeSource's order, with the path of their Forbidden. */
const SOURCES: readonly [json: string, forbiddenPath: string][] = [
  ['emptyDir', 'emptyDir'],
  ['hostPath', 'hostPath'],
  ['gitRepo', 'gitRepo'],
  ['gcePersistentDisk', 'gcePersistentDisk'],
  ['awsElasticBlockStore', 'awsElasticBlockStore'],
  ['secret', 'secret'],
  ['nfs', 'nfs'],
  ['iscsi', 'iscsi'],
  ['glusterfs', 'glusterfs'],
  ['flocker', 'flocker'],
  ['persistentVolumeClaim', 'persistentVolumeClaim'],
  ['rbd', 'rbd'],
  ['cinder', 'cinder'],
  ['cephfs', 'cephFS'],
  ['quobyte', 'quobyte'],
  ['downwardAPI', 'downwarAPI'],
  ['fc', 'fc'],
  ['flexVolume', 'flexVolume'],
  ['configMap', 'configMap'],
  ['azureFile', 'azureFile'],
  ['vsphereVolume', 'vsphereVolume'],
  ['photonPersistentDisk', 'photonPersistentDisk'],
  ['portworxVolume', 'portworxVolume'],
  ['azureDisk', 'azureDisk'],
  ['storageos', 'storageos'],
  ['projected', 'projected'],
  ['scaleIO', 'scaleIO'],
  ['csi', 'csi'],
  ['ephemeral', 'ephemeral'],
  ['image', 'image'],
];

const fileMode = (v: Json | undefined, path: Path): FieldError[] =>
  typeof v === 'number' && (v > 0o777 || v < 0) ? [invalid(path, v, FILE_MODE_ERROR)] : [];

export function validateKeyToPath(kp: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(kp.key) === '') errs.push(required(path.child('key')));
  if (str(kp.path) === '') errs.push(required(path.child('path')));
  errs.push(...validateLocalNonReservedPath(str(kp.path), path.child('path')));
  errs.push(...fileMode(kp.mode, path.child('mode')));
  errs.push(...validateUserField(kp.user, path.child('user')));
  return errs;
}

function validateSecretVolumeSource(s: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(s.secretName) === '') errs.push(required(path.child('secretName')));
  errs.push(...fileMode(s.defaultMode, path.child('defaultMode')));
  errs.push(...validateUserField(s.defaultUser, path.child('defaultUser')));
  objs(s.items).forEach((kp, i) => errs.push(...validateKeyToPath(kp, path.child('items').index(i))));
  return errs;
}

function validateConfigMapVolumeSource(s: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(s.name) === '') errs.push(required(path.child('name')));
  errs.push(...fileMode(s.defaultMode, path.child('defaultMode')));
  errs.push(...validateUserField(s.defaultUser, path.child('defaultUser')));
  objs(s.items).forEach((kp, i) => errs.push(...validateKeyToPath(kp, path.child('items').index(i))));
  return errs;
}

function validateHostPathVolumeSource(s: JsonObject, path: Path): FieldError[] {
  if (str(s.path) === '') return [required(path.child('path'))];
  const errs = validatePathNoBacksteps(str(s.path), path.child('path'));
  if (typeof s.type === 'string' && !HOST_PATH_TYPES.includes(s.type)) errs.push(notSupported(path.child('type'), s.type, HOST_PATH_TYPES));
  return errs;
}

function validateDownwardAPIVolumeFile(file: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(file.path) === '') errs.push(required(path.child('path')));
  errs.push(...validateLocalNonReservedPath(str(file.path), path.child('path')));
  const fieldRef = obj(file.fieldRef);
  const resourceFieldRef = obj(file.resourceFieldRef);
  if (fieldRef) {
    errs.push(...validateObjectFieldSelector(fieldRef, VOLUME_DOWNWARD_API_FIELD_PATHS, path.child('fieldRef')));
    if (resourceFieldRef) errs.push(invalid(path, 'resource', 'fieldRef and resourceFieldRef can not be specified simultaneously'));
  } else if (resourceFieldRef) {
    errs.push(...validateContainerResourceFieldSelector(resourceFieldRef, VALID_CONTAINER_RESOURCE_FIELD_PATHS, path.child('resourceFieldRef'), true));
  } else {
    errs.push(required(path, 'one of fieldRef and resourceFieldRef is required'));
  }
  errs.push(...fileMode(file.mode, path.child('mode')));
  errs.push(...validateUserField(file.user, path.child('user')));
  return errs;
}

function validateDownwardAPIVolumeSource(s: JsonObject, path: Path): FieldError[] {
  const errs = fileMode(s.defaultMode, path.child('defaultMode'));
  errs.push(...validateUserField(s.defaultUser, path.child('defaultUser')));
  for (const file of objs(s.items)) errs.push(...validateDownwardAPIVolumeFile(file, path));
  return errs;
}

function validateProjectedVolumeSource(p: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs = fileMode(p.defaultMode, path.child('defaultMode'));
  errs.push(...validateUserField(p.defaultUser, path.child('defaultUser')));
  const allPaths = new Set<string>();
  const addPath = (p2: string, value: Json): void => {
    if (p2 === '') return;
    if (allPaths.has(p2)) errs.push(invalid(path, value, 'conflicting duplicate paths'));
    else allPaths.add(p2);
  };
  objs(p.sources).forEach((source, i) => {
    let numSources = 0;
    const srcPath = path.child('sources').index(i);
    const secret = obj(source.secret);
    if (secret) {
      numSources++;
      const projPath = srcPath.child('secret');
      if (str(secret.name) === '') errs.push(required(projPath.child('name')));
      objs(secret.items).forEach((kp, j) => {
        errs.push(...validateKeyToPath(kp, projPath.child('items').index(j)));
        addPath(str(kp.path), str(secret.name));
      });
    }
    const cm = obj(source.configMap);
    if (cm) {
      numSources++;
      const projPath = srcPath.child('configMap');
      if (str(cm.name) === '') errs.push(required(projPath.child('name')));
      objs(cm.items).forEach((kp, j) => {
        errs.push(...validateKeyToPath(kp, projPath.child('items').index(j)));
        addPath(str(kp.path), str(cm.name));
      });
    }
    const downward = obj(source.downwardAPI);
    if (downward) {
      numSources++;
      const projPath = srcPath.child('downwardAPI');
      for (const file of objs(downward.items)) {
        errs.push(...validateDownwardAPIVolumeFile(file, projPath));
        addPath(str(file.path), str(file.path));
      }
    }
    const sat = obj(source.serviceAccountToken);
    if (sat) {
      numSources++;
      const projPath = srcPath.child('serviceAccountToken');
      if (typeof sat.expirationSeconds !== 'number') errs.push(required(projPath.child('expirationSeconds')));
      else {
        if (sat.expirationSeconds < 10 * 60) errs.push(invalid(projPath.child('expirationSeconds'), sat.expirationSeconds, 'may not specify a duration less than 10 minutes'));
        if (sat.expirationSeconds > 2 ** 32) errs.push(invalid(projPath.child('expirationSeconds'), sat.expirationSeconds, 'may not specify a duration larger than 2^32 seconds'));
      }
      if (str(sat.path) === '') errs.push(required(path.child('path')));
      else errs.push(...validateLocalNonReservedPath(str(sat.path), path.child('path')));
      errs.push(...validateUserField(sat.user, projPath.child('user')));
    }
    for (const other of ['clusterTrustBundle', 'podCertificate']) {
      if (isSet(source[other])) {
        numSources++;
        opts.notPorted(`validation of projected ${other} volume sources`);
      }
    }
    if (numSources > 1) errs.push(forbidden(srcPath, 'may not specify more than 1 volume type per source'));
  });
  return errs;
}

function validateNFSVolumeSource(s: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(s.server) === '') errs.push(required(path.child('server')));
  if (str(s.path) === '') errs.push(required(path.child('path')));
  if (!str(s.path).startsWith('/')) errs.push(invalid(path.child('path'), str(s.path), 'must be an absolute path'));
  return errs;
}

function validateSource(json: string, s: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  switch (json) {
    case 'emptyDir': {
      const errs: FieldError[] = [];
      if (typeof s.sizeLimit === 'string') {
        const q = parseQuantity(s.sizeLimit);
        if (!('error' in q) && sign(q) < 0) errs.push(forbidden(path.child('emptyDir').child('sizeLimit'), 'SizeLimit field must be a valid resource quantity'));
      }
      if (typeof s.mode === 'number' && (s.mode > 0o1777 || s.mode < 0)) errs.push(invalid(path.child('emptyDir').child('mode'), s.mode, EMPTY_DIR_MODE_ERROR));
      return errs;
    }
    case 'hostPath':
      return validateHostPathVolumeSource(s, path.child('hostPath'));
    case 'gitRepo': {
      const errs: FieldError[] = [];
      if (str(s.repository) === '') errs.push(required(path.child('gitRepo').child('repository')));
      errs.push(...validateLocalDescendingPath(str(s.directory), path.child('gitRepo').child('directory')));
      return errs;
    }
    case 'secret':
      return validateSecretVolumeSource(s, path.child('secret'));
    case 'nfs':
      return validateNFSVolumeSource(s, path.child('nfs'));
    case 'persistentVolumeClaim':
      return str(s.claimName) === '' ? [required(path.child('persistentVolumeClaim').child('claimName'))] : [];
    case 'downwardAPI':
      return validateDownwardAPIVolumeSource(s, path.child('downwardAPI'));
    case 'configMap':
      return validateConfigMapVolumeSource(s, path.child('configMap'));
    case 'projected':
      return validateProjectedVolumeSource(s, path.child('projected'), opts);
    case 'image': {
      // AllowEmptyImageVolumeReference is only for updates of objects that already had one.
      const errs: FieldError[] = [];
      if (str(s.reference) === '') errs.push(required(path.child('image').child('reference')));
      errs.push(...validatePullPolicy(str(s.pullPolicy), path.child('image').child('pullPolicy')));
      return errs;
    }
    default:
      opts.notPorted(`validation of ${json} volumes`);
      return [];
  }
}

/** validatePullPolicy (also used by containers). */
export function validatePullPolicy(policy: string, path: Path): FieldError[] {
  switch (policy) {
    case 'Always':
    case 'IfNotPresent':
    case 'Never':
      return [];
    case '':
      return [required(path)];
    default:
      return [notSupported(path, policy, ['Always', 'IfNotPresent', 'Never'])];
  }
}

function validateVolumeSource(v: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  let numVolumes = 0;
  const errs: FieldError[] = [];
  for (const [json, forbiddenPath] of SOURCES) {
    const s = obj(v[json]);
    if (!s) continue;
    if (json === 'emptyDir') {
      // The only source checked without the "more than 1" test: it is the first.
      numVolumes++;
      errs.push(...validateSource(json, s, path, opts));
      continue;
    }
    if (numVolumes > 0) {
      errs.push(forbidden(path.child(forbiddenPath), 'may not specify more than 1 volume type'));
      continue;
    }
    numVolumes++;
    errs.push(...validateSource(json, s, path, opts));
  }
  if (numVolumes === 0) errs.push(required(path, 'must specify a volume type'));
  return errs;
}

/**
 * ValidateVolumes: the errors, and the names of the volumes that passed (the map containers'
 * volumeMounts are checked against; a volume with an error is left out of it).
 */
export function validateVolumes(volumes: Json | undefined, path: Path, opts: PodValidationOptions): { vols: Map<string, JsonObject>; errs: FieldError[] } {
  const errs: FieldError[] = [];
  const vols = new Map<string, JsonObject>();
  objs(volumes).forEach((vol, i) => {
    const idxPath = path.index(i);
    const namePath = idxPath.child('name');
    const name = str(vol.name);
    const el = validateVolumeSource(vol, idxPath, opts);
    if (name === '') el.push(required(namePath));
    else el.push(...validateDNS1123Label(name, namePath));
    if (vols.has(name)) el.push(duplicate(namePath, name));
    if (el.length === 0) vols.set(name, vol);
    else errs.push(...el);
    // A PVC created for an ephemeral volume of this Pod can't also be referenced: the ephemeral
    // source is not ported (logged above), so neither is this check.
  });
  return { vols, errs };
}
