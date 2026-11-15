// Pod and PodTemplateSpec validation on the versioned JSON.
// upstream: pkg/apis/core/validation/validation.go ValidatePodCreate, validatePodMetadataAndSpec,
// ValidatePodSpec, validatePodSpecSecurityContext, validateShareProcessNamespace,
// validatePodHostNetworkDeps, validateRestartPolicy, validateDNSPolicy, ValidatePreemptionPolicy,
// validateHostUsers, validatePodHostName, validateFileKeyRefVolumes, validateOS, validateLinux,
// validateOverhead, ValidatePodSpecificAnnotations, ValidatePodSpecificAnnotationUpdates,
// ValidateSeccompPodAnnotations, ValidateSeccompProfile, ValidatePodUpdate, ValidateContainerUpdates,
// validateOnlyAddedTolerations, validateOnlyDeletedSchedulingGates, ValidatePodStatusUpdate,
// validatePodConditions, ValidatePodTemplateSpec; pkg/apis/core/helper/helpers.go
// GetDeletionCostFromPodAnnotations.
//
// Declarative validation (zz_generated.validations.go) adds nothing visible for Pods in v1.37.2:
// its Pod rules (tolerations[*].key, metadata.uid) are alpha, not enforced with the default gates.

import { forbidden, invalid, notSupported, required, type FieldError, type Path, newPath } from '../../../apimachinery/field.ts';
import { cloneJson, jsonEqual, type Json, type JsonObject } from '../../../apimachinery/json.ts';
import { validateLabels, validateAnnotations, validateImmutableField } from '../../../apimachinery/validation/objectmeta.ts';
import { inclusiveRangeError, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateContainers, validateContainersOnlyForPod, validateInitContainers, validateSeccompProfileField, type PodContext } from './containers.ts';
import { validateObjectMeta, validateObjectMetaUpdate } from './objectmeta.ts';
import { ALLOW_USER_NAMESPACES_HOST_NETWORK, type PodValidationOptions } from './options.ts';
import { podSpecDiff } from './podspecdiff.ts';
import { validateContainerResourceName, validateResourceRequirements } from './resources.ts';
import {
  validateAffinity,
  validateHostAliases,
  validatePodDNSConfig,
  validateReadinessGates,
  validateSchedulingGates,
  validateTolerations,
  validateTopologySpreadConstraints,
} from './scheduling.ts';
import { arr, goTrimSpace, isSet, isValidGroupID, isValidUserID, num, obj, objs, sortStrings, str, strMap, validateDNS1123Label, validateDNS1123Subdomain, validateLocalDescendingPath, validateQualifiedName } from './util.ts';
import { validateVolumes } from './volumes.ts';

export type { PodValidationOptions } from './options.ts';

const MAX_INT32 = 2147483647;
const MIRROR_POD_ANNOTATION = 'kubernetes.io/config.mirror';
const TOLERATIONS_ANNOTATION = 'scheduler.alpha.kubernetes.io/tolerations';
const POD_DELETION_COST = 'controller.kubernetes.io/pod-deletion-cost';
const SECCOMP_POD_ANNOTATION = 'seccomp.security.alpha.kubernetes.io/pod';
const SECCOMP_CONTAINER_ANNOTATION_PREFIX = 'container.seccomp.security.alpha.kubernetes.io/';
const APPARMOR_CONTAINER_ANNOTATION_PREFIX = 'container.apparmor.security.beta.kubernetes.io/';

// ---- annotations ----

/** GetDeletionCostFromPodAnnotations: a decimal int32 without '+' or leading zeros. */
function deletionCostValid(value: string): boolean {
  // validFirstDigit
  if (value.length === 0) return false;
  const c = value[0] as string;
  if (!(c === '-' || (c === '0' && value === '0') || (c >= '1' && c <= '9'))) return false;
  // strconv.ParseInt(value, 10, 32)
  if (!/^[+-]?[0-9]+$/.test(value)) return false;
  const n = Number(value);
  return n >= -2147483648 && n <= MAX_INT32;
}

/** ValidateSeccompProfile of an annotation value. */
function validateSeccompAnnotation(p: string, path: Path): FieldError[] {
  if (p === 'runtime/default' || p === 'docker/default' || p === 'unconfined') return [];
  if (p.startsWith('localhost/')) return validateLocalDescendingPath(p.slice('localhost/'.length), path);
  return [invalid(path, p, 'must be a valid seccomp profile')];
}

/** ValidatePodSpecificAnnotations. */
export function validatePodSpecificAnnotations(annotations: Record<string, string>, spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  if (MIRROR_POD_ANNOTATION in annotations && str(spec.nodeName) === '') {
    errs.push(invalid(path.key(MIRROR_POD_ANNOTATION), annotations[MIRROR_POD_ANNOTATION], 'must set spec.nodeName if mirror pod annotation is set'));
  }
  if ((annotations[TOLERATIONS_ANNOTATION] ?? '') !== '') opts.notPorted(`validation of the ${TOLERATIONS_ANNOTATION} annotation`);
  // AllowInvalidPodDeletionCost only for objects that already had one.
  if (POD_DELETION_COST in annotations && !deletionCostValid(annotations[POD_DELETION_COST] as string)) {
    errs.push(invalid(path.key(POD_DELETION_COST), annotations[POD_DELETION_COST], 'must be a 32bit integer'));
  }
  if (SECCOMP_POD_ANNOTATION in annotations) errs.push(...validateSeccompAnnotation(annotations[SECCOMP_POD_ANNOTATION] as string, path.child(SECCOMP_POD_ANNOTATION)));
  for (const k of sortStrings(Object.keys(annotations))) {
    if (k.startsWith(SECCOMP_CONTAINER_ANNOTATION_PREFIX)) errs.push(...validateSeccompAnnotation(annotations[k] as string, path.child(k)));
  }
  if (Object.keys(annotations).some((k) => k.startsWith(APPARMOR_CONTAINER_ANNOTATION_PREFIX))) opts.notPorted('validation of AppArmor pod annotations');
  return errs;
}

/** validateSeccompAnnotationsAndFields / validateAppArmorAnnotationsAndFieldsMatchOnCreate: only when the legacy annotations are used. */
function legacyAnnotationFieldChecks(annotations: Record<string, string>, opts: PodValidationOptions): void {
  if (Object.keys(annotations).some((k) => k === SECCOMP_POD_ANNOTATION || k.startsWith(SECCOMP_CONTAINER_ANNOTATION_PREFIX) || k.startsWith(APPARMOR_CONTAINER_ANNOTATION_PREFIX))) {
    opts.notPorted('matching of seccomp and AppArmor annotations with their fields');
  }
}

// ---- PodSpec ----

function validatePodSpecSecurityContext(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const sc = obj(spec.securityContext);
  if (!sc) return [];
  const errs: FieldError[] = [];
  if (typeof sc.fsGroup === 'number') for (const m of isValidGroupID(sc.fsGroup)) errs.push(invalid(path.child('fsGroup'), sc.fsGroup, m));
  if (typeof sc.runAsUser === 'number') for (const m of isValidUserID(sc.runAsUser)) errs.push(invalid(path.child('runAsUser'), sc.runAsUser, m));
  if (typeof sc.runAsGroup === 'number') for (const m of isValidGroupID(sc.runAsGroup)) errs.push(invalid(path.child('runAsGroup'), sc.runAsGroup, m));
  arr(sc.supplementalGroups).forEach((g, i) => {
    for (const m of isValidGroupID(num(g))) errs.push(invalid(path.child('supplementalGroups').index(i), num(g), m));
  });
  if (arr(sc.sysctls).length > 0) opts.notPorted('validation of securityContext.sysctls');
  if (isSet(sc.fsGroupChangePolicy) && !['Always', 'OnRootMismatch'].includes(str(sc.fsGroupChangePolicy))) {
    errs.push(notSupported(path.child('fsGroupChangePolicy'), str(sc.fsGroupChangePolicy), ['Always', 'OnRootMismatch']));
  }
  errs.push(...validateSeccompProfileField(obj(sc.seccompProfile), path.child('seccompProfile')));
  if (isSet(sc.windowsOptions)) opts.notPorted('validation of securityContext.windowsOptions');
  if (isSet(sc.appArmorProfile)) opts.notPorted('validation of securityContext.appArmorProfile');
  if (isSet(sc.supplementalGroupsPolicy) && !['Merge', 'Strict'].includes(str(sc.supplementalGroupsPolicy))) {
    errs.push(notSupported(path.child('supplementalGroupsPolicy'), str(sc.supplementalGroupsPolicy), ['Merge', 'Strict']));
  }
  if (isSet(sc.seLinuxChangePolicy)) opts.notPorted('validation of securityContext.seLinuxChangePolicy');
  return errs;
}

/** podshelper.VisitContainersWithPath: init, regular, then ephemeral containers. */
function visitContainers(spec: JsonObject, path: Path, fn: (c: JsonObject, p: Path) => void): void {
  objs(spec.initContainers).forEach((c, i) => fn(c, path.child('initContainers').index(i)));
  objs(spec.containers).forEach((c, i) => fn(c, path.child('containers').index(i)));
  objs(spec.ephemeralContainers).forEach((c, i) => fn(c, path.child('ephemeralContainers').index(i)));
}

function validateHostUsers(spec: JsonObject, path: Path): FieldError[] {
  if (spec.hostUsers !== false) return [];
  const errs: FieldError[] = [];
  if (!ALLOW_USER_NAMESPACES_HOST_NETWORK && spec.hostNetwork === true) errs.push(forbidden(path.child('hostNetwork'), 'when `hostUsers` is false'));
  if (spec.hostPID === true) errs.push(forbidden(path.child('HostPID'), 'when `hostUsers` is false'));
  if (spec.hostIPC === true) errs.push(forbidden(path.child('HostIPC'), 'when `hostUsers` is false'));
  visitContainers(spec, path, (c, p) => {
    if (arr(c.volumeDevices).length > 0) errs.push(forbidden(p.child('volumeDevices'), 'when `hostUsers` is false'));
  });
  return errs;
}

function validatePodHostName(spec: JsonObject, path: Path): FieldError[] {
  if (!isSet(spec.hostnameOverride)) return [];
  const errs: FieldError[] = [];
  const name = str(spec.hostnameOverride);
  if (spec.setHostnameAsFQDN === true) errs.push(forbidden(path.child('hostnameOverride'), 'may not be specified when setHostnameAsFQDN is true'));
  if (spec.hostNetwork === true) errs.push(forbidden(path.child('hostnameOverride'), 'may not be specified when hostNetwork is true'));
  if (name.length > 64) errs.push({ type: 'FieldValueTooLong', field: path.child('hostnameOverride').toString(), value: '', detail: 'may not be more than 64 bytes' });
  errs.push(...validateDNS1123Subdomain(name, path.child('hostnameOverride')));
  return errs;
}

function validateFileKeyRefVolumes(spec: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const sources = new Map(objs(spec.volumes).map((v) => [str(v.name), v] as const));
  visitContainers(spec, path, (c, p) => {
    objs(c.env).forEach((env, j) => {
      const fk = obj(obj(env.valueFrom)?.fileKeyRef);
      if (!fk) return;
      const volumeName = str(fk.volumeName);
      const vp = p.child('env').index(j).child('valueFrom').child('fileKeyRef').child('volumeName');
      const source = sources.get(volumeName);
      if (!source) errs.push({ type: 'FieldValueNotFound', field: vp.toString(), value: volumeName, detail: '' });
      else if (!isSet(source.emptyDir)) errs.push(invalid(vp, volumeName, 'referenced volume must be of type emptyDir'));
    });
  });
  return errs;
}

function validateOSFields(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const os = obj(spec.os);
  if (!os) return [];
  const name = str(os.name);
  if (name === '') return [required(path.child('os').child('name'))];
  if (name !== 'linux' && name !== 'windows') return [notSupported(path.child('os'), name, ['linux', 'windows'])];
  if (name === 'windows') {
    opts.notPorted('validation of Windows pods');
    return [];
  }
  // validateLinux
  const errs: FieldError[] = [];
  if (isSet(obj(spec.securityContext)?.windowsOptions)) errs.push(forbidden(path.child('securityContext').child('windowsOptions'), 'windows options cannot be set for a linux pod'));
  visitContainers(spec, path, (c, p) => {
    if (isSet(obj(c.securityContext)?.windowsOptions)) errs.push(forbidden(p.child('securityContext').child('windowsOptions'), 'windows options cannot be set for a linux pod'));
  });
  return errs;
}

const nameErrors = (value: string, path: Path): FieldError[] => nameIsDNSSubdomain(value, false).map((m) => invalid(path, value, m));

/** ValidatePodSpec (podMeta is only used by the generic ephemeral volume checks, not ported). */
export function validatePodSpec(spec: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  if (typeof spec.terminationGracePeriodSeconds !== 'number') errs.push(required(path.child('terminationGracePeriodSeconds')));
  const hostUsers = spec.hostUsers !== false;
  const { vols, errs: vErrs } = validateVolumes(spec.volumes, path.child('volumes'), opts);
  errs.push(...vErrs);
  const podClaimNames = new Set(objs(spec.resourceClaims).map((c) => str(c.name)));
  if (podClaimNames.size > 0) opts.notPorted('validation of spec.resourceClaims');
  const ctx: PodContext = {
    vols,
    podClaimNames,
    gracePeriod: typeof spec.terminationGracePeriodSeconds === 'number' ? spec.terminationGracePeriodSeconds : undefined,
    restartPolicy: str(spec.restartPolicy),
    hostUsers,
    os: obj(spec.os),
    opts,
  };
  errs.push(...validateContainers(spec.containers, ctx, path.child('containers')));
  errs.push(...validateInitContainers(spec.initContainers, spec.containers, ctx, path.child('initContainers')));
  if (arr(spec.ephemeralContainers).length > 0) opts.notPorted('validation of ephemeral containers');
  // PodLevelResources is on: validatePodResources.
  if (isSet(spec.resources)) opts.notPorted('validation of pod-level resources (spec.resources)');
  // validatePodHostNetworkDeps
  if (spec.hostNetwork === true) {
    objs(spec.containers).forEach((c, i) => {
      objs(c.ports).forEach((port, j) => {
        const hp = num(port.hostPort);
        const cp = num(port.containerPort);
        if ((opts.resourceIsPod || hp !== 0) && hp !== cp) {
          errs.push(invalid(path.child('containers').index(i).child('ports').index(j).child('hostPort'), hp, 'must match `containerPort` when `hostNetwork` is true'));
        }
      });
    });
  }
  // validateRestartPolicy
  const restartPolicy = str(spec.restartPolicy);
  if (restartPolicy === '') errs.push(required(path.child('restartPolicy')));
  else if (!['Always', 'OnFailure', 'Never'].includes(restartPolicy)) errs.push(notSupported(path.child('restartPolicy'), restartPolicy, ['Always', 'OnFailure', 'Never']));
  // validateDNSPolicy
  const dnsPolicy = str(spec.dnsPolicy);
  if (dnsPolicy === '') errs.push(required(path.child('dnsPolicy')));
  else if (!['ClusterFirstWithHostNet', 'ClusterFirst', 'Default', 'None'].includes(dnsPolicy)) {
    errs.push(notSupported(path.child('dnsPolicy'), dnsPolicy, ['ClusterFirstWithHostNet', 'ClusterFirst', 'Default', 'None']));
  }
  errs.push(...validateLabels(strMap(spec.nodeSelector), path.child('nodeSelector')));
  errs.push(...validatePodSpecSecurityContext(spec, path.child('securityContext'), opts));
  if (spec.shareProcessNamespace === true && spec.hostPID === true) {
    errs.push(invalid(path.child('shareProcessNamespace'), true, 'ShareProcessNamespace and HostPID cannot both be enabled'));
  }
  errs.push(...validateAffinity(obj(spec.affinity), path.child('affinity'), opts));
  errs.push(...validatePodDNSConfig(obj(spec.dnsConfig), dnsPolicy, path.child('dnsConfig')));
  errs.push(...validateReadinessGates(spec.readinessGates, path.child('readinessGates')));
  errs.push(...validateSchedulingGates(spec.schedulingGates, path.child('schedulingGates')));
  errs.push(...validateTopologySpreadConstraints(spec.topologySpreadConstraints, path.child('topologySpreadConstraints'), opts));
  // validateWindowsHostProcessPod only acts on windowsOptions.hostProcess (logged as not ported above).
  errs.push(...validateHostUsers(spec, path));
  errs.push(...validatePodHostName(spec, path));
  const sa = str(spec.serviceAccountName);
  if (sa !== '') errs.push(...nameErrors(sa, path.child('serviceAccountName')));
  if (str(spec.serviceAccount) !== sa) errs.push(invalid(path.child('deprecatedServiceAccount'), str(spec.serviceAccount), `must be the same as serviceAccountName: ${JSON.stringify(sa)}`));
  const nodeName = str(spec.nodeName);
  if (nodeName !== '') errs.push(...nameErrors(nodeName, path.child('nodeName')));
  if (typeof spec.activeDeadlineSeconds === 'number') {
    const v = spec.activeDeadlineSeconds;
    if (v < 1 || v > MAX_INT32) errs.push(invalid(path.child('activeDeadlineSeconds'), v, inclusiveRangeError(1, MAX_INT32)));
  }
  if (str(spec.hostname) !== '') errs.push(...validateDNS1123Label(str(spec.hostname), path.child('hostname')));
  if (str(spec.subdomain) !== '') errs.push(...validateDNS1123Label(str(spec.subdomain), path.child('subdomain')));
  if (arr(spec.tolerations).length > 0) errs.push(...validateTolerations(spec.tolerations, path.child('tolerations')));
  if (arr(spec.hostAliases).length > 0) errs.push(...validateHostAliases(spec.hostAliases, path.child('hostAliases')));
  const pc = str(spec.priorityClassName);
  if (pc !== '') errs.push(...nameErrors(pc, path.child('priorityClassName')));
  if (isSet(spec.runtimeClassName)) errs.push(...nameErrors(str(spec.runtimeClassName), path.child('runtimeClassName')));
  if (isSet(spec.preemptionPolicy)) {
    const pp = str(spec.preemptionPolicy);
    if (pp === '') errs.push(required(path.child('preemptionPolicy')));
    else if (pp !== 'PreemptLowerPriority' && pp !== 'Never') errs.push(notSupported(path.child('preemptionPolicy'), pp, ['PreemptLowerPriority', 'Never']));
  }
  if (isSet(spec.overhead)) errs.push(...validateResourceRequirements({ limits: spec.overhead as Json }, validateContainerResourceName, new Set(), path.child('overhead')));
  errs.push(...validateOSFields(spec, path, opts));
  if (isSet(spec.schedulingGroup)) opts.notPorted('validation of spec.schedulingGroup');
  errs.push(...validateFileKeyRefVolumes(spec, path));
  return errs;
}

// ---- Pod ----

/** validatePodMetadataAndSpec. */
function validatePodMetadataAndSpec(pod: JsonObject, opts: PodValidationOptions): FieldError[] {
  const metaPath = newPath('metadata');
  const specPath = newPath('spec');
  const meta = obj(pod.metadata) ?? {};
  const spec = obj(pod.spec) ?? {};
  const errs = validateObjectMeta(meta, true, nameIsDNSSubdomain, metaPath);
  errs.push(...validatePodSpecificAnnotations(strMap(meta.annotations), spec, metaPath.child('annotations'), opts));
  errs.push(...validatePodSpec(spec, specPath, opts));
  if (str(spec.serviceAccountName) === '') {
    objs(spec.volumes).forEach((v, vi) => {
      objs(obj(v.projected)?.sources).forEach((s, si) => {
        if (isSet(s.serviceAccountToken)) {
          errs.push(forbidden(specPath.child('volumes').index(vi).child('projected').child('sources').index(si).child('serviceAccountToken'), 'must not be specified when serviceAccountName is not set'));
        }
      });
    });
  }
  if (typeof spec.terminationGracePeriodSeconds === 'number' && spec.terminationGracePeriodSeconds < 0) {
    errs.push(invalid(specPath.child('terminationGracePeriodSeconds'), spec.terminationGracePeriodSeconds, 'must be greater than or equal to 0'));
  }
  errs.push(...validateContainersOnlyForPod(spec.containers, specPath.child('containers')));
  errs.push(...validateContainersOnlyForPod(spec.initContainers, specPath.child('initContainers')));
  return errs;
}

/** ValidatePodCreate. */
export function validatePodCreate(pod: JsonObject, opts: PodValidationOptions): FieldError[] {
  const errs = validatePodMetadataAndSpec(pod, opts);
  const spec = obj(pod.spec) ?? {};
  const path = newPath('spec');
  if (arr(spec.ephemeralContainers).length > 0) errs.push(forbidden(path.child('ephemeralContainers'), 'cannot be set on create'));
  if (str(spec.nodeName) !== '' && arr(spec.schedulingGates).length > 0) errs.push(forbidden(path.child('nodeName'), 'cannot be set until all schedulingGates have been cleared'));
  legacyAnnotationFieldChecks(strMap(obj(pod.metadata)?.annotations), opts);
  return errs;
}

/** ValidateContainerUpdates: the same number of containers, each with an image. */
function validateContainerUpdates(newC: Json | undefined, oldC: Json | undefined, path: Path): { errs: FieldError[]; stop: boolean } {
  const n = objs(newC);
  if (n.length !== objs(oldC).length) return { errs: [forbidden(path, 'pod updates may not add or remove containers')], stop: true };
  const errs: FieldError[] = [];
  n.forEach((c, i) => {
    const image = str(c.image);
    if (image === '') errs.push(required(path.index(i).child('image')));
    if (goTrimSpace(image).length !== image.length) errs.push(invalid(path.index(i).child('image'), image, 'must not have leading or trailing whitespace'));
  });
  return { errs, stop: false };
}

/** ValidatePodSpecificAnnotationUpdates. */
function validatePodSpecificAnnotationUpdates(pod: JsonObject, old: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const errs: FieldError[] = [];
  const newA = strMap(obj(pod.metadata)?.annotations);
  const oldA = strMap(obj(old.metadata)?.annotations);
  for (const k of sortStrings(Object.keys(oldA))) {
    if (k in newA && newA[k] === oldA[k]) continue;
    if (k.startsWith(APPARMOR_CONTAINER_ANNOTATION_PREFIX)) errs.push(forbidden(path.key(k), 'may not remove or update AppArmor annotations'));
    if (k === MIRROR_POD_ANNOTATION) errs.push(forbidden(path.key(k), 'may not remove or update mirror pod annotation'));
  }
  for (const k of sortStrings(Object.keys(newA))) {
    if (k in oldA) continue;
    if (k.startsWith(APPARMOR_CONTAINER_ANNOTATION_PREFIX)) errs.push(forbidden(path.key(k), 'may not add AppArmor annotations'));
    if (k === MIRROR_POD_ANNOTATION) errs.push(forbidden(path.key(k), 'may not add mirror pod annotation'));
  }
  errs.push(...validatePodSpecificAnnotations(newA, obj(pod.spec) ?? {}, path, opts));
  return errs;
}

const UPDATABLE_POD_SPEC_FIELDS = [
  '`spec.containers[*].image`',
  '`spec.initContainers[*].image`',
  '`spec.activeDeadlineSeconds`',
  '`spec.tolerations` (only additions to existing tolerations)',
  '`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)',
];

/** The first line of the Forbidden pod update error. */
export const POD_UPDATE_FORBIDDEN = `pod updates may not change fields other than ${UPDATABLE_POD_SPEC_FIELDS.join(',')}`;

/** ValidatePodUpdate. */
export function validatePodUpdate(pod: JsonObject, old: JsonObject, opts: PodValidationOptions): FieldError[] {
  const metaPath = newPath('metadata');
  const errs = validateObjectMetaUpdate(obj(pod.metadata) ?? {}, obj(old.metadata) ?? {}, metaPath);
  errs.push(...validatePodMetadataAndSpec(pod, opts));
  errs.push(...validatePodSpecificAnnotationUpdates(pod, old, metaPath.child('annotations'), opts));
  const specPath = newPath('spec');
  const spec = obj(pod.spec) ?? {};
  const oldSpec = obj(old.spec) ?? {};
  for (const list of ['containers', 'initContainers']) {
    const r = validateContainerUpdates(spec[list], oldSpec[list], specPath.child(list));
    errs.push(...r.errs);
    if (r.stop) return errs;
  }
  if (typeof spec.activeDeadlineSeconds === 'number') {
    const v = spec.activeDeadlineSeconds;
    if (v < 0 || v > MAX_INT32) return [...errs, invalid(specPath.child('activeDeadlineSeconds'), v, inclusiveRangeError(0, MAX_INT32))];
    if (typeof oldSpec.activeDeadlineSeconds === 'number' && oldSpec.activeDeadlineSeconds < v) {
      return [...errs, invalid(specPath.child('activeDeadlineSeconds'), v, 'must be less than or equal to previous value')];
    }
  } else if (typeof oldSpec.activeDeadlineSeconds === 'number') {
    errs.push(invalid(specPath.child('activeDeadlineSeconds'), null, 'must not update from a positive integer to nil value'));
  }
  // validateOnlyAddedTolerations
  const newT = objs(spec.tolerations);
  const withoutSeconds = (t: JsonObject): JsonObject => {
    const { tolerationSeconds: _s, ...rest } = t;
    return rest;
  };
  const allKept = objs(oldSpec.tolerations).every((o) => newT.some((n) => jsonEqual(withoutSeconds(o), withoutSeconds(n))));
  if (!allKept) errs.push(forbidden(specPath.child('tolerations'), 'existing toleration can not be modified except its tolerationSeconds'));
  else errs.push(...validateTolerations(spec.tolerations, specPath.child('tolerations')));
  // validateOnlyDeletedSchedulingGates (Go map order becomes name order, D-040)
  const newGates = objs(spec.schedulingGates);
  if (newGates.length > 0) {
    const added = new Map<string, number>();
    newGates.forEach((g, i) => added.set(str(g.name), i));
    for (const g of objs(oldSpec.schedulingGates)) added.delete(str(g.name));
    for (const name of sortStrings([...added.keys()])) {
      errs.push(forbidden(specPath.child('schedulingGates').index(added.get(name) as number).child('name'), `only deletion is allowed, but found new scheduling gate '${name}'`));
    }
  }
  if (jsonEqual(spec, oldSpec)) return errs;
  // Munge the updatable fields to their old values, then compare.
  const munged = cloneJson(spec);
  for (const list of ['containers', 'initContainers']) {
    const oldList = objs(oldSpec[list]);
    objs(munged[list]).forEach((c, i) => {
      const oldImage = oldList[i]?.image;
      if (oldImage === undefined) delete c.image;
      else c.image = oldImage;
    });
  }
  for (const f of ['activeDeadlineSeconds', 'schedulingGates', 'tolerations']) {
    if (oldSpec[f] === undefined) delete munged[f];
    else munged[f] = cloneJson(oldSpec[f] as Json);
  }
  if (typeof oldSpec.terminationGracePeriodSeconds === 'number' && oldSpec.terminationGracePeriodSeconds < 0 && munged.terminationGracePeriodSeconds === 1) {
    munged.terminationGracePeriodSeconds = oldSpec.terminationGracePeriodSeconds;
  }
  if (arr(oldSpec.schedulingGates).length > 0) {
    // Gated pods may add to nodeSelector and node affinity: those mutation rules are not ported.
    const oldNA = obj(oldSpec.affinity)?.nodeAffinity;
    const newNA = obj(munged.affinity)?.nodeAffinity;
    if (!jsonEqual(munged.nodeSelector ?? null, oldSpec.nodeSelector ?? null) || !jsonEqual(newNA ?? null, oldNA ?? null)) {
      opts.notPorted('nodeSelector and node affinity updates of scheduling-gated pods');
      return errs;
    }
  }
  if (!jsonEqual(munged, oldSpec)) {
    const diff = podSpecDiff(oldSpec, munged);
    errs.push(forbidden(specPath, diff === undefined ? POD_UPDATE_FORBIDDEN : `${POD_UPDATE_FORBIDDEN}\n${diff}`));
  }
  return errs;
}

/** ValidatePodStatusUpdate (the parts the simulator's writers can reach). */
export function validatePodStatusUpdate(pod: JsonObject, old: JsonObject, opts: PodValidationOptions): FieldError[] {
  const metaPath = newPath('metadata');
  const errs = validateObjectMetaUpdate(obj(pod.metadata) ?? {}, obj(old.metadata) ?? {}, metaPath);
  errs.push(...validatePodSpecificAnnotationUpdates(pod, old, metaPath.child('annotations'), opts));
  const path = newPath('status');
  const status = obj(pod.status) ?? {};
  const oldStatus = obj(old.status) ?? {};
  // validatePodConditions
  objs(status.conditions).forEach((c, i) => {
    if (num(c.observedGeneration) < 0) errs.push(invalid(path.child('conditions').index(i).child('observedGeneration'), num(c.observedGeneration), 'must be a non-negative integer'));
    if (['PodScheduled', 'Ready', 'Initialized'].includes(str(c.type))) return;
    errs.push(...validateQualifiedName(str(c.type), path.child('conditions').index(i).child('Type')));
  });
  if (str(obj(pod.spec)?.nodeName) !== str(obj(old.spec)?.nodeName)) errs.push(forbidden(path.child('nodeName'), 'may not be changed directly'));
  const nominated = str(status.nominatedNodeName);
  if (nominated !== str(oldStatus.nominatedNodeName) && nominated !== '') errs.push(...nameErrors(nominated, path.child('nominatedNodeName')));
  // ClearingNominatedNodeNameAfterBinding is on.
  if (str(obj(old.spec)?.nodeName) !== '' && nominated !== '' && nominated !== str(oldStatus.nominatedNodeName)) {
    errs.push(forbidden(path.child('nominatedNodeName'), 'may not be set on pods that are already bound to a node'));
  }
  if (num(status.observedGeneration) < 0) errs.push(invalid(path.child('observedGeneration'), num(status.observedGeneration), 'must be a non-negative integer'));
  errs.push(...validateImmutableField(str(status.qosClass), str(oldStatus.qosClass), path.child('qosClass')));
  return errs;
}

// ---- PodTemplateSpec ----

/** ValidatePodTemplateSpec: labels are checked at `<path>.labels` (sic, upstream). */
export function validatePodTemplateSpec(t: JsonObject, path: Path, opts: PodValidationOptions): FieldError[] {
  const meta = obj(t.metadata) ?? {};
  const spec = obj(t.spec) ?? {};
  const annotations = strMap(meta.annotations);
  const errs = validateLabels(strMap(meta.labels), path.child('labels'));
  errs.push(...validateAnnotations(annotations, path.child('annotations')));
  errs.push(...validatePodSpecificAnnotations(annotations, spec, path.child('annotations'), opts));
  errs.push(...validatePodSpec(spec, path.child('spec'), opts));
  legacyAnnotationFieldChecks(annotations, opts);
  if (arr(spec.ephemeralContainers).length > 0) errs.push(forbidden(path.child('spec', 'ephemeralContainers'), 'ephemeral containers not allowed in pod template'));
  return errs;
}
