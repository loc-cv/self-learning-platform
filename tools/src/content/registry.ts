// The registry content is validated and played against: every plugin the apps load.

import { createRegistry, type Plugin } from '@simlab/kernel';
import { hostPlugin } from '@simlab/host';
import { k8sPlugin } from '@simlab/k8s';

export const CONTENT_PLUGINS: Plugin[] = [hostPlugin, k8sPlugin];

export const contentRegistry = createRegistry(CONTENT_PLUGINS);
