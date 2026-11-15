// The Kubernetes plugin: the `k8s` slice (etcd contents and watch subscriptions).

import { put, type Plugin, type SliceSpec } from '@simlab/kernel';
import { K8S, type K8sSlice } from './apiserver/store.ts';

/** 1: etcd data and watches (phase 05a). */
export const K8S_SLICE_VERSION = 1;

const k8sSliceSpec: SliceSpec<K8sSlice> = {
  name: K8S,
  version: K8S_SLICE_VERSION,
  init: () => ({ etcd: {}, watches: {} }),
  adopt(slice) {
    const refreeze = <V>(table: Record<string, V>): void => {
      for (const k of Object.keys(table)) put(table, k, table[k] as V);
    };
    for (const id of Object.keys(slice.etcd)) {
      const d = slice.etcd[id];
      if (!d) continue;
      for (const r of Object.keys(d.resources)) refreeze(d.resources[r] ?? {});
      refreeze(d.ranges);
      refreeze(d.history);
    }
    refreeze(slice.watches);
  },
};

export const k8sPlugin: Plugin = {
  name: K8S,
  requires: ['host'],
  slice: k8sSliceSpec as SliceSpec<unknown>,
};
