// Containers of a PodSpec: regular, init (and sidecar) and the common checks.
// upstream: pkg/apis/core/validation/validation.go validateContainers, validateInitContainers,
// validateContainerCommon, validateContainerPorts, ValidateEnv, validateEnvVarValueFrom,
// validateConfigMapKeySelector, validateSecretKeySelector, validateFileKeySelector, ValidateEnvFrom,
// validateConfigMapEnvSource, validateSecretEnvSource, ValidateVolumeMounts, validateMountPropagation,
// validateMountRecursiveReadOnly, validateBindMountOptions, ValidateVolumeDevices, validateLivenessProbe,
// validateReadinessProbe, validateStartupProbe, validateProbe, validateHandler, validateExecAction,
// validateHTTPGetAction, ValidatePortNumOrName, validateTCPSocketAction, validateGRPCAction,
// validateSleepAction, validateLifecycle, validateStopSignal, validateResizePolicy,
// validateInitContainerRestartPolicy, validateContainerRestartPolicy, checkHostPortConflicts,
// ValidateSecurityContext, validateSeccompProfileField, ValidateProcMountType, validateContainerOnlyForPod.

import { duplicate, forbidden, invalid, notFound, notSupported, required, tooMany, type FieldError, type Path } from '../../../apimachinery/field.ts';
import type { Json, JsonObject } from '../../../apimachinery/json.ts';
import { isConfigMapKey, isEnvVarName, isRelaxedEnvVarName, isValidPortName, isValidPortNum, nameIsDNSSubdomain } from '../../../apimachinery/validation/names.ts';
import { validateNonnegativeField } from '../../../apimachinery/validation/objectmeta.ts';
import { validateObjectFieldSelector, validateContainerResourceFieldSelector, VALID_CONTAINER_RESOURCE_FIELD_PATHS } from './fieldselectors.ts';
import { encodeSecurityContext, encodeSeccompProfile } from './internaljson.ts';
import {
  ALLOW_CONTAINER_RESTART_POLICY_RULES,
  ALLOW_ENV_FILES,
  ALLOW_RELAXED_ENV_VAR_NAMES,
  ALLOW_RESTART_ALL_CONTAINERS,
  ALLOW_SIDECAR_RESIZE_POLICY,
  type PodValidationOptions,
} from './options.ts';
import { validateContainerResourceName, validateResourceRequirements } from './resources.ts';
import { arr, isSet, isValidGroupID, isValidUserID, num, obj, objs, str, strs, validateDNS1123Label, validateLocalDescendingPath, validatePathNoBacksteps, isHTTPHeaderName, goTrimSpace } from './util.ts';
import { validatePullPolicy } from './volumes.ts';

/** What the container checks need to know about the pod around them. */
export interface PodContext {
  /** Volumes that passed validation, by name. */
  vols: Map<string, JsonObject>;
  podClaimNames: ReadonlySet<string>;
  /** spec.terminationGracePeriodSeconds, undefined when unset. */
  gracePeriod: number | undefined;
  restartPolicy: string;
  hostUsers: boolean;
  /** spec.os, undefined when unset. */
  os: JsonObject | undefined;
  opts: PodValidationOptions;
}

const ENV_DOWNWARD_API_FIELD_PATHS = ['metadata.name', 'metadata.namespace', 'metadata.uid', 'spec.nodeName', 'spec.serviceAccountName', 'status.hostIP', 'status.hostIPs', 'status.podIP', 'status.podIPs'];

// ---- ports ----

function validateContainerPorts(ports: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const allNames = new Set<string>();
  objs(ports).forEach((port, i) => {
    const idxPath = path.index(i);
    const name = str(port.name);
    if (name !== '') {
      const msgs = isValidPortName(name);
      if (msgs.length > 0) for (const m of msgs) errs.push(invalid(idxPath.child('name'), name, m));
      else if (allNames.has(name)) errs.push(duplicate(idxPath.child('name'), name));
      else allNames.add(name);
    }
    const cp = num(port.containerPort);
    if (cp === 0) errs.push(required(idxPath.child('containerPort')));
    else for (const m of isValidPortNum(cp)) errs.push(invalid(idxPath.child('containerPort'), cp, m));
    const hp = num(port.hostPort);
    if (hp !== 0) for (const m of isValidPortNum(hp)) errs.push(invalid(idxPath.child('hostPort'), hp, m));
    const protocol = str(port.protocol);
    if (protocol === '') errs.push(required(idxPath.child('protocol')));
    else if (!['SCTP', 'TCP', 'UDP'].includes(protocol)) errs.push(notSupported(idxPath.child('protocol'), protocol, ['SCTP', 'TCP', 'UDP']));
  });
  return errs;
}

/** AccumulateUniqueHostPorts over a set of containers. */
function checkHostPortConflicts(containers: JsonObject[], path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const seen = new Set<string>();
  containers.forEach((c, ci) => {
    objs(c.ports).forEach((p, pi) => {
      const hp = num(p.hostPort);
      if (hp === 0) return;
      const key = `${str(p.protocol)}/${str(p.hostIP)}/${hp}`;
      if (seen.has(key)) errs.push(duplicate(path.index(ci).child('ports').index(pi).child('hostPort'), key));
      else seen.add(key);
    });
  });
  return errs;
}

// ---- env ----

function envNameErrors(name: string): string[] {
  return ALLOW_RELAXED_ENV_VAR_NAMES ? isRelaxedEnvVarName(name) : isEnvVarName(name);
}

function validateKeySelector(s: JsonObject, path: Path): FieldError[] {
  // validateConfigMapKeySelector / validateSecretKeySelector: the name with ValidateSecretName.
  const errs = nameIsDNSSubdomain(str(s.name), false).map((m) => invalid(path.child('name'), str(s.name), m));
  const key = str(s.key);
  if (key === '') errs.push(required(path.child('key')));
  else for (const m of isConfigMapKey(key)) errs.push(invalid(path.child('key'), key, m));
  return errs;
}

function validateFileKeySelector(s: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const key = str(s.key);
  if (key === '') errs.push(required(path.child('key')));
  else for (const m of isRelaxedEnvVarName(key)) errs.push(invalid(path.child('key'), key, m));
  const volumeName = str(s.volumeName);
  if (volumeName === '') errs.push(required(path.child('volumeName')));
  else errs.push(...validateDNS1123Label(volumeName, path.child('volumeName')));
  const p = str(s.path);
  if (p === '') errs.push(required(path.child('path')));
  else errs.push(...validatePathNoBacksteps(p, path.child('path')));
  return errs;
}

function validateEnvVarValueFrom(ev: JsonObject, path: Path): FieldError[] {
  const vf = obj(ev.valueFrom);
  if (!vf) return [];
  const errs: FieldError[] = [];
  let numSources = 0;
  const fieldRef = obj(vf.fieldRef);
  if (fieldRef) {
    numSources++;
    errs.push(...validateObjectFieldSelector(fieldRef, ENV_DOWNWARD_API_FIELD_PATHS, path.child('fieldRef')));
  }
  const resourceFieldRef = obj(vf.resourceFieldRef);
  if (resourceFieldRef) {
    numSources++;
    errs.push(...validateContainerResourceFieldSelector(resourceFieldRef, VALID_CONTAINER_RESOURCE_FIELD_PATHS, path.child('resourceFieldRef'), false));
  }
  const cmRef = obj(vf.configMapKeyRef);
  if (cmRef) {
    numSources++;
    errs.push(...validateKeySelector(cmRef, path.child('configMapKeyRef')));
  }
  const secretRef = obj(vf.secretKeyRef);
  if (secretRef) {
    numSources++;
    errs.push(...validateKeySelector(secretRef, path.child('secretKeyRef')));
  }
  const fileKeyRef = obj(vf.fileKeyRef);
  if (fileKeyRef) {
    numSources++;
    errs.push(...validateFileKeySelector(fileKeyRef, path.child('fileKeyRef')));
  }
  if (numSources === 0) {
    errs.push(
      invalid(
        path,
        '',
        ALLOW_ENV_FILES
          ? 'must specify one of: `fieldRef`, `resourceFieldRef`, `configMapKeyRef`, `secretKeyRef` or `fileKeyRef`'
          : 'must specify one of: `fieldRef`, `resourceFieldRef`, `configMapKeyRef` or `secretKeyRef`',
      ),
    );
  } else if (str(ev.value) !== '') {
    errs.push(invalid(path, '', 'may not be specified when `value` is not empty'));
  } else if (numSources > 1) {
    errs.push(invalid(path, '', 'may not have more than one field specified at a time'));
  }
  return errs;
}

function validateEnv(vars: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(vars).forEach((ev, i) => {
    const idxPath = path.index(i);
    const name = str(ev.name);
    if (name === '') errs.push(required(idxPath.child('name')));
    else for (const m of envNameErrors(name)) errs.push(invalid(idxPath.child('name'), name, m));
    errs.push(...validateEnvVarValueFrom(ev, idxPath.child('valueFrom')));
  });
  return errs;
}

function validateEnvFrom(vars: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(vars).forEach((ev, i) => {
    const idxPath = path.index(i);
    const prefix = str(ev.prefix);
    if (prefix !== '') for (const m of envNameErrors(prefix)) errs.push(invalid(idxPath.child('prefix'), prefix, m));
    let numSources = 0;
    for (const [key, label] of [
      ['configMapRef', 'configMapRef'],
      ['secretRef', 'secretRef'],
    ] as const) {
      const ref = obj(ev[key]);
      if (!ref) continue;
      numSources++;
      const name = str(ref.name);
      if (name === '') errs.push(required(idxPath.child(label).child('name')));
      else for (const m of nameIsDNSSubdomain(name, true)) errs.push(invalid(idxPath.child(label).child('name'), name, m));
    }
    // upstream reports these on the list path, not the item's.
    if (numSources === 0) errs.push(invalid(path, '', 'must specify one of: `configMapRef` or `secretRef`'));
    else if (numSources > 1) errs.push(invalid(path, '', 'may not have more than one field specified at a time'));
  });
  return errs;
}

// ---- volume mounts and devices ----

const MOUNT_PROPAGATIONS = ['Bidirectional', 'HostToContainer', 'None'];
const BIND_MOUNT_OPTIONS = ['noexec', 'nodev', 'nosuid'];

function validateVolumeMounts(c: JsonObject, devices: Map<string, string>, ctx: PodContext, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const mountpoints = new Set<string>();
  objs(c.volumeMounts).forEach((mnt, i) => {
    const idxPath = path.index(i);
    const name = str(mnt.name);
    const mountPath = str(mnt.mountPath);
    if (name === '') errs.push(required(idxPath.child('name')));
    if (!ctx.vols.has(name)) errs.push(notFound(idxPath.child('name'), name));
    if (mountPath === '') errs.push(required(idxPath.child('mountPath')));
    if (mountpoints.has(mountPath)) errs.push(invalid(idxPath.child('mountPath'), mountPath, 'must be unique'));
    mountpoints.add(mountPath);
    if (devices.has(name)) errs.push(invalid(idxPath.child('name'), name, 'must not already exist in volumeDevices'));
    if ([...devices.values()].includes(mountPath)) errs.push(invalid(idxPath.child('mountPath'), mountPath, 'must not already exist as a path in volumeDevices'));
    const subPath = str(mnt.subPath);
    const subPathExpr = str(mnt.subPathExpr);
    // upstream uses the list path (not the item's) for these two.
    if (subPath !== '') errs.push(...validateLocalDescendingPath(subPath, path.child('subPath')));
    if (subPathExpr !== '') {
      if (subPath !== '') errs.push(invalid(idxPath.child('subPathExpr'), subPathExpr, 'subPathExpr and subPath are mutually exclusive'));
      errs.push(...validateLocalDescendingPath(subPathExpr, path.child('subPathExpr')));
    }
    if (isSet(mnt.mountPropagation)) {
      const mp = str(mnt.mountPropagation);
      const p = path.child('mountPropagation');
      if (!MOUNT_PROPAGATIONS.includes(mp)) errs.push(notSupported(p, mp, MOUNT_PROPAGATIONS));
      const privileged = obj(c.securityContext)?.privileged === true;
      if (mp === 'Bidirectional' && !privileged) errs.push(forbidden(p, 'Bidirectional mount propagation is available only to privileged containers'));
    }
    if (isSet(mnt.recursiveReadOnly)) {
      const rro = str(mnt.recursiveReadOnly);
      const p = path.child('recursiveReadOnly');
      if (rro === 'Enabled' || rro === 'IfPossible') {
        if (mnt.readOnly !== true) errs.push(forbidden(p, 'may only be specified when readOnly is true'));
        if (isSet(mnt.mountPropagation) && str(mnt.mountPropagation) !== 'None') errs.push(forbidden(p, 'may only be specified when mountPropagation is None or not specified'));
      } else if (rro !== 'Disabled') {
        errs.push(notSupported(p, rro, ['Disabled', 'Enabled', 'IfPossible']));
      }
    }
    const bindOpts = strs(mnt.bindMountOptions);
    const seen = new Set<string>();
    bindOpts.forEach((o, j) => {
      const p = idxPath.child('bindMountOptions').index(j);
      if (!BIND_MOUNT_OPTIONS.includes(o)) errs.push(notSupported(p, o, BIND_MOUNT_OPTIONS));
      if (seen.has(o)) errs.push(duplicate(p, o));
      seen.add(o);
    });
    if (bindOpts.length > 0 && isSet(ctx.vols.get(name)?.image)) {
      errs.push(invalid(idxPath.child('bindMountOptions'), bindOpts, 'bindMountOptions may not be used with image volumes'));
    }
  });
  return errs;
}

function validateVolumeDevices(c: JsonObject, mounts: Map<string, string>, ctx: PodContext, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const devicePaths = new Set<string>();
  const deviceNames = new Set<string>();
  objs(c.volumeDevices).forEach((dev, i) => {
    const idxPath = path.index(i);
    const name = str(dev.name);
    const devPath = str(dev.devicePath);
    const vol = ctx.vols.get(name);
    const isPVC = vol !== undefined && (isSet(vol.persistentVolumeClaim) || isSet(vol.ephemeral));
    if (name === '') errs.push(required(idxPath.child('name')));
    if (deviceNames.has(name)) errs.push(invalid(idxPath.child('name'), name, 'must be unique'));
    if (vol && !isPVC) errs.push(invalid(idxPath.child('name'), name, 'can only use volume source type of PersistentVolumeClaim or Ephemeral for block mode'));
    if (!vol) errs.push(notFound(idxPath.child('name'), name));
    if (devPath === '') errs.push(required(idxPath.child('devicePath')));
    if (devicePaths.has(devPath)) errs.push(invalid(idxPath.child('devicePath'), devPath, 'must be unique'));
    if (devPath !== '' && validatePathNoBacksteps(devPath, path.child('devicePath')).length > 0) errs.push(invalid(idxPath.child('devicePath'), devPath, "can not contain backsteps ('..')"));
    else devicePaths.add(devPath);
    if (mounts.has(name)) errs.push(invalid(idxPath.child('name'), name, 'must not already exist in volumeMounts'));
    if ([...mounts.values()].includes(devPath)) errs.push(invalid(idxPath.child('devicePath'), devPath, 'must not already exist as a path in volumeMounts'));
    if (name !== '') deviceNames.add(name);
  });
  return errs;
}

// ---- probes and handlers ----

/** ValidatePortNumOrName on an IntOrString (JSON number or string). */
export function validatePortNumOrName(port: Json | undefined, path: Path): FieldError[] {
  if (typeof port === 'string') return isValidPortName(port).map((m) => invalid(path, port, m));
  const n = num(port);
  return isValidPortNum(n).map((m) => invalid(path, n, m));
}

function validateHTTPGetAction(http: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  if (str(http.path) === '') errs.push(required(path.child('path')));
  errs.push(...validatePortNumOrName(http.port, path.child('port')));
  const scheme = str(http.scheme);
  if (scheme !== 'HTTP' && scheme !== 'HTTPS') errs.push(notSupported(path.child('scheme'), scheme, ['HTTP', 'HTTPS']));
  for (const h of objs(http.httpHeaders)) for (const m of isHTTPHeaderName(str(h.name))) errs.push(invalid(path.child('httpHeaders'), str(h.name), m));
  if (isSet(http.protocol)) {
    const protocol = str(http.protocol);
    if (protocol !== 'HTTP1' && protocol !== 'HTTP2') errs.push(notSupported(path.child('protocol'), protocol, ['HTTP1', 'HTTP2']));
    else if (protocol === 'HTTP2' && scheme !== 'HTTP') errs.push(invalid(path.child('protocol'), protocol, 'is only supported with HTTP (H2C)'));
    else if (protocol === 'HTTP2' && str(http.host) !== '') errs.push(invalid(path.child('host'), str(http.host), 'must be empty when `protocol` is "HTTP2"'));
  }
  return errs;
}

/** validateHandler over a probe handler or a lifecycle handler (`sleep` only in the latter). */
function validateHandler(h: JsonObject, kinds: readonly string[], gracePeriod: number | undefined, path: Path): FieldError[] {
  let numHandlers = 0;
  const errs: FieldError[] = [];
  for (const kind of kinds) {
    const a = obj(h[kind]);
    if (!a) continue;
    if (numHandlers > 0) {
      errs.push(forbidden(path.child(kind), 'may not specify more than 1 handler type'));
      continue;
    }
    numHandlers++;
    switch (kind) {
      case 'exec':
        if (arr(a.command).length === 0) errs.push(required(path.child('exec').child('command')));
        break;
      case 'httpGet':
        errs.push(...validateHTTPGetAction(a, path.child('httpGet')));
        break;
      case 'tcpSocket':
        errs.push(...validatePortNumOrName(a.port, path.child('tcpSocket').child('port')));
        break;
      case 'grpc':
        errs.push(...validatePortNumOrName(num(a.port), path.child('grpc').child('port')));
        if (isSet(a.mode) && !['Plaintext', 'TLS'].includes(str(a.mode))) errs.push(notSupported(path.child('grpc').child('mode'), str(a.mode), ['Plaintext', 'TLS']));
        break;
      case 'sleep': {
        // A nil grace period is let through: the pod's own error is reported elsewhere.
        const seconds = num(a.seconds);
        if (gracePeriod !== undefined && (seconds < 0 || seconds > gracePeriod)) {
          errs.push(invalid(path.child('sleep'), seconds, `must be non-negative and less than terminationGracePeriodSeconds (${gracePeriod})`));
        }
        break;
      }
    }
  }
  if (numHandlers === 0) errs.push(required(path, 'must specify a handler type'));
  return errs;
}

const PROBE_HANDLERS = ['exec', 'httpGet', 'tcpSocket', 'grpc'];
const LIFECYCLE_HANDLERS = ['exec', 'httpGet', 'tcpSocket', 'sleep'];

function validateProbe(p: JsonObject, gracePeriod: number | undefined, path: Path): FieldError[] {
  const errs = validateHandler(p, PROBE_HANDLERS, gracePeriod, path);
  for (const f of ['initialDelaySeconds', 'timeoutSeconds', 'periodSeconds', 'successThreshold', 'failureThreshold']) errs.push(...validateNonnegativeField(num(p[f]), path.child(f)));
  if (typeof p.terminationGracePeriodSeconds === 'number' && p.terminationGracePeriodSeconds <= 0) {
    errs.push(invalid(path.child('terminationGracePeriodSeconds'), p.terminationGracePeriodSeconds, 'must be greater than 0'));
  }
  return errs;
}

function validateProbes(c: JsonObject, gracePeriod: number | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const liveness = obj(c.livenessProbe);
  if (liveness) {
    errs.push(...validateProbe(liveness, gracePeriod, path.child('livenessProbe')));
    if (num(liveness.successThreshold) !== 1) errs.push(invalid(path.child('livenessProbe').child('successThreshold'), num(liveness.successThreshold), 'must be 1'));
  }
  const readiness = obj(c.readinessProbe);
  if (readiness) {
    errs.push(...validateProbe(readiness, gracePeriod, path.child('readinessProbe')));
    if (isSet(readiness.terminationGracePeriodSeconds)) {
      errs.push(invalid(path.child('readinessProbe').child('terminationGracePeriodSeconds'), readiness.terminationGracePeriodSeconds, 'must not be set for readinessProbes'));
    }
  }
  const startup = obj(c.startupProbe);
  if (startup) {
    errs.push(...validateProbe(startup, gracePeriod, path.child('startupProbe')));
    if (num(startup.successThreshold) !== 1) errs.push(invalid(path.child('startupProbe').child('successThreshold'), num(startup.successThreshold), 'must be 1'));
  }
  return errs;
}

function validateLifecycle(lc: JsonObject, ctx: PodContext, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const postStart = obj(lc.postStart);
  if (postStart) errs.push(...validateHandler(postStart, LIFECYCLE_HANDLERS, ctx.gracePeriod, path.child('postStart')));
  const preStop = obj(lc.preStop);
  if (preStop) errs.push(...validateHandler(preStop, LIFECYCLE_HANDLERS, ctx.gracePeriod, path.child('preStop')));
  if (isSet(lc.stopSignal)) {
    // validateStopSignal: the signal lists are not ported; an unset spec.os is checked.
    if (!ctx.os) errs.push(forbidden(path.child('stopSignal'), 'may not be set for containers with empty `spec.os.name`'));
    else ctx.opts.notPorted('validation of lifecycle.stopSignal values');
  }
  return errs;
}

// ---- resize and restart policies ----

function validateResizePolicy(policies: Json | undefined, podRestartPolicy: string, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const seen = new Set<string>();
  objs(policies).forEach((p, i) => {
    const resourceName = str(p.resourceName);
    const restartPolicy = str(p.restartPolicy);
    if (seen.has(resourceName)) errs.push(duplicate(path.index(i), resourceName));
    seen.add(resourceName);
    if (resourceName === '') errs.push(required(path));
    else if (resourceName !== 'cpu' && resourceName !== 'memory') errs.push(notSupported(path, resourceName, ['cpu', 'memory']));
    if (restartPolicy === '') errs.push(required(path));
    else if (restartPolicy !== 'NotRequired' && restartPolicy !== 'RestartContainer') errs.push(notSupported(path, restartPolicy, ['NotRequired', 'RestartContainer']));
    if (podRestartPolicy === 'Never' && restartPolicy !== 'NotRequired') errs.push(invalid(path, restartPolicy, "must be 'NotRequired' when pod `restartPolicy` is 'Never'"));
  });
  return errs;
}

function validateContainerRestartPolicy(c: JsonObject, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const rules = objs(c.restartPolicyRules);
  const restartPolicyFld = path.child('restartPolicy');
  if (!isSet(c.restartPolicy)) {
    if (rules.length === 0) return errs;
    errs.push(required(restartPolicyFld, 'must specify restartPolicy when restart rules are used'));
  } else if (!['Always', 'Never', 'OnFailure'].includes(str(c.restartPolicy))) {
    errs.push(notSupported(restartPolicyFld, str(c.restartPolicy), ['Always', 'Never', 'OnFailure']));
  }
  if (rules.length > 20) errs.push(tooMany(path.child('restartPolicyRules'), rules.length, 20));
  const actions = ALLOW_RESTART_ALL_CONTAINERS ? ['Restart', 'RestartAllContainers'] : ['Restart'];
  rules.forEach((rule, i) => {
    const rulePath = path.child('restartPolicyRules').index(i);
    if (!actions.includes(str(rule.action))) errs.push(notSupported(rulePath.child('action'), str(rule.action), actions));
    const exitCodes = obj(rule.exitCodes);
    if (exitCodes) {
      if (!['In', 'NotIn'].includes(str(exitCodes.operator))) errs.push(notSupported(rulePath.child('exitCodes').child('operator'), str(exitCodes.operator), ['In', 'NotIn']));
      const values = arr(exitCodes.values);
      if (values.length > 255) errs.push(tooMany(rulePath.child('exitCodes').child('values'), values.length, 255));
    } else {
      errs.push(required(rulePath.child('exitCodes'), 'must be specified'));
    }
  });
  return errs;
}

function validateInitContainerRestartPolicy(c: JsonObject, path: Path): FieldError[] {
  const rules = arr(c.restartPolicyRules);
  if (!isSet(c.restartPolicy)) return rules.length > 0 ? [required(path.child('restartPolicy'), 'must specify restartPolicy when restart rules are used')] : [];
  if (ALLOW_CONTAINER_RESTART_POLICY_RULES) {
    if (str(c.restartPolicy) === 'Always') {
      if (ALLOW_RESTART_ALL_CONTAINERS) return validateContainerRestartPolicy(c, path);
      return rules.length > 0 ? [forbidden(path.child('restartPolicyRules'), 'restartPolicyRules are not allowed for init containers with restart policy Always')] : [];
    }
    return validateContainerRestartPolicy(c, path);
  }
  return str(c.restartPolicy) === 'Always' ? [] : [notSupported(path.child('restartPolicy'), str(c.restartPolicy), ['Always'])];
}

// ---- security context ----

function validateSeccompProfileField(sp: JsonObject | undefined, path: Path): FieldError[] {
  if (!sp) return [];
  const errs: FieldError[] = [];
  const type = str(sp.type);
  if (type === '') errs.push(required(path.child('type'), 'type is required when seccompProfile is set'));
  else if (!['Localhost', 'RuntimeDefault', 'Unconfined'].includes(type)) errs.push(notSupported(path.child('type'), type, ['Localhost', 'RuntimeDefault', 'Unconfined']));
  if (type === 'Localhost') {
    if (!isSet(sp.localhostProfile)) errs.push(required(path.child('localhostProfile'), 'must be set when seccomp type is Localhost'));
    else errs.push(...validateLocalDescendingPath(str(sp.localhostProfile), path.child('localhostProfile')));
  } else if (isSet(sp.localhostProfile)) {
    errs.push(invalid(path.child('localhostProfile'), { go: encodeSeccompProfile(sp) }, 'can only be set when seccomp type is Localhost'));
  }
  return errs;
}
export { validateSeccompProfileField };

function validateSecurityContext(sc: JsonObject | undefined, path: Path, ctx: PodContext): FieldError[] {
  if (!sc) return [];
  const errs: FieldError[] = [];
  // capabilities.Get().AllowPrivileged is true in kube-apiserver (--allow-privileged=true in kubeadm).
  if (typeof sc.runAsUser === 'number') for (const m of isValidUserID(sc.runAsUser)) errs.push(invalid(path.child('runAsUser'), sc.runAsUser, m));
  if (typeof sc.runAsGroup === 'number') for (const m of isValidGroupID(sc.runAsGroup)) errs.push(invalid(path.child('runAsGroup'), sc.runAsGroup, m));
  if (isSet(sc.procMount)) {
    const pm = str(sc.procMount);
    if (pm !== 'Default' && pm !== 'Unmasked') errs.push(notSupported(path.child('procMount'), pm, ['Default', 'Unmasked']));
    if (ctx.hostUsers && pm === 'Unmasked') errs.push(invalid(path.child('procMount'), pm, '`hostUsers` must be false to use `Unmasked`'));
  }
  errs.push(...validateSeccompProfileField(obj(sc.seccompProfile), path.child('seccompProfile')));
  if (sc.allowPrivilegeEscalation === false) {
    if (sc.privileged === true) errs.push(invalid(path, { go: encodeSecurityContext(sc) }, 'cannot set `allowPrivilegeEscalation` to false and `privileged` to true'));
    // AllowSysAdminWhenPrivilegeEscalationFalse is a backward-compatibility allowance: off.
    for (const cap of strs(obj(sc.capabilities)?.add)) {
      if (cap === 'CAP_SYS_ADMIN') errs.push(invalid(path, { go: encodeSecurityContext(sc) }, 'cannot set `allowPrivilegeEscalation` to false and `capabilities.Add` CAP_SYS_ADMIN'));
    }
  }
  if (isSet(sc.windowsOptions)) ctx.opts.notPorted('validation of securityContext.windowsOptions');
  if (isSet(sc.appArmorProfile)) ctx.opts.notPorted('validation of securityContext.appArmorProfile');
  return errs;
}

// ---- containers ----

/** validateContainerCommon. */
function validateContainerCommon(c: JsonObject, ctx: PodContext, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const name = str(c.name);
  if (name === '') errs.push(required(path.child('name')));
  else errs.push(...validateDNS1123Label(name, path.child('name')));
  if (str(c.image) === '') errs.push(required(path.child('image')));
  const tmp = str(c.terminationMessagePolicy);
  if (tmp === '') errs.push(required(path.child('terminationMessagePolicy')));
  else if (tmp !== 'File' && tmp !== 'FallbackToLogsOnError') errs.push(notSupported(path.child('terminationMessagePolicy'), tmp, ['File', 'FallbackToLogsOnError']));
  const mounts = new Map(objs(c.volumeMounts).map((m) => [str(m.name), str(m.mountPath)] as const));
  const devices = new Map(objs(c.volumeDevices).map((d) => [str(d.name), str(d.devicePath)] as const));
  errs.push(...validateContainerPorts(c.ports, path.child('ports')));
  errs.push(...validateEnv(c.env, path.child('env')));
  errs.push(...validateEnvFrom(c.envFrom, path.child('envFrom')));
  errs.push(...validateVolumeMounts(c, devices, ctx, path.child('volumeMounts')));
  errs.push(...validateVolumeDevices(c, mounts, ctx, path.child('volumeDevices')));
  errs.push(...validatePullPolicy(str(c.imagePullPolicy), path.child('imagePullPolicy')));
  errs.push(...validateResourceRequirements(obj(c.resources), validateContainerResourceName, ctx.podClaimNames, path.child('resources')));
  errs.push(...validateResizePolicy(c.resizePolicy, ctx.restartPolicy, path.child('resizePolicy')));
  errs.push(...validateSecurityContext(obj(c.securityContext), path.child('securityContext'), ctx));
  return errs;
}

/** validateContainers: the regular containers. */
export function validateContainers(containers: Json | undefined, ctx: PodContext, path: Path): FieldError[] {
  const list = objs(containers);
  if (list.length === 0) return [required(path)];
  const errs: FieldError[] = [];
  const allNames = new Set<string>();
  list.forEach((c, i) => {
    const p = path.index(i);
    errs.push(...validateContainerCommon(c, ctx, p));
    const name = str(c.name);
    if (allNames.has(name)) errs.push(duplicate(p.child('name'), name));
    else allNames.add(name);
    const lc = obj(c.lifecycle);
    if (lc) errs.push(...validateLifecycle(lc, ctx, p.child('lifecycle')));
    errs.push(...validateProbes(c, ctx.gracePeriod, p));
    if (ALLOW_CONTAINER_RESTART_POLICY_RULES) errs.push(...validateContainerRestartPolicy(c, p));
    else if (isSet(c.restartPolicy)) errs.push(forbidden(p.child('restartPolicy'), 'may not be set for non-init containers'));
  });
  errs.push(...checkHostPortConflicts(list, path));
  return errs;
}

/** validateInitContainers: init and sidecar containers. */
export function validateInitContainers(containers: Json | undefined, regular: Json | undefined, ctx: PodContext, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  const allNames = new Set(objs(regular).map((c) => str(c.name)));
  objs(containers).forEach((c, i) => {
    const p = path.index(i);
    errs.push(...validateContainerCommon(c, ctx, p));
    errs.push(...validateInitContainerRestartPolicy(c, p));
    const restartAlways = isSet(c.restartPolicy) && str(c.restartPolicy) === 'Always';
    const name = str(c.name);
    if (allNames.has(name)) errs.push(duplicate(p.child('name'), name));
    else if (name !== '') allNames.add(name);
    // Port conflicts of init containers are checked one by one (they run one after the other),
    // over a one-element slice: upstream's path says initContainers[0] whatever the index.
    errs.push(...checkHostPortConflicts([c], path));
    if (restartAlways) {
      const lc = obj(c.lifecycle);
      if (lc) errs.push(...validateLifecycle(lc, ctx, p.child('lifecycle')));
      errs.push(...validateProbes(c, ctx.gracePeriod, p));
    } else {
      for (const f of ['lifecycle', 'livenessProbe', 'readinessProbe', 'startupProbe']) {
        if (isSet(c[f])) errs.push(forbidden(p.child(f), 'may not be set for init containers without restartPolicy=Always'));
      }
    }
    const resize = objs(c.resizePolicy);
    if (!ALLOW_SIDECAR_RESIZE_POLICY && resize.length > 0) errs.push(invalid(p.child('resizePolicy'), c.resizePolicy ?? null, 'must not be set for init containers'));
    if (!restartAlways) {
      resize.forEach((rp, j) => {
        if (str(rp.restartPolicy) === 'RestartContainer') {
          errs.push(invalid(path.index(i).child('resizePolicy').index(j).child('restartPolicy'), 'RestartContainer', "must not be set to 'RestartContainer' for non-sidecar initContainers"));
        }
      });
    }
  });
  return errs;
}

/** validateContainerOnlyForPod: an image with surrounding whitespace (Pods only, not templates). */
export function validateContainersOnlyForPod(containers: Json | undefined, path: Path): FieldError[] {
  const errs: FieldError[] = [];
  objs(containers).forEach((c, i) => {
    const image = str(c.image);
    if (image.length !== goTrimSpace(image).length) errs.push(invalid(path.index(i).child('image'), image, 'must not have leading or trailing whitespace'));
  });
  return errs;
}
