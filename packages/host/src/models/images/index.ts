// Behavior models of the programs in the official images the simulator pulls (PLAN.md §6.3):
// the entrypoint scripts and the servers they exec, the pause container, and the stand-in for
// the cluster's own components. packages/k8s/src/runtime/images/files.ts maps image files to
// these names.

import type { ProgramModel } from '../types.ts';
import { componentModel } from './component.ts';
import { httpdForegroundModel, httpdModel } from './httpd.ts';
import { nginxEntrypointModel } from './nginx-entrypoint.ts';
import { nginxModel } from './nginx.ts';
import { pauseModel } from './pause.ts';
import { redisEntrypointModel, redisServerModel } from './redis.ts';

export const IMAGE_MODELS: readonly ProgramModel[] = [
  nginxEntrypointModel,
  nginxModel,
  httpdForegroundModel,
  httpdModel,
  redisEntrypointModel,
  redisServerModel,
  pauseModel,
  componentModel,
];
