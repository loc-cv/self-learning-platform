import { describe, expect, it } from 'vitest';
import { capturedImage, diffCatalogs, envValue, rawConfig, selectPlatformManifest, sortImages, splitReference, type Catalog, type RawImage } from './catalog.ts';
import { familyFor, keepTag } from './references.ts';

const amd64 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:aa', size: 100, platform: { architecture: 'amd64', os: 'linux' } };

describe('selectPlatformManifest', () => {
  it('picks linux/amd64 and skips attestations', () => {
    const index = {
      manifests: [
        { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:att', size: 5, platform: { architecture: 'unknown', os: 'unknown' } },
        { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:arm', size: 6, platform: { architecture: 'arm64', os: 'linux', variant: 'v8' } },
        amd64,
      ],
    };
    expect(selectPlatformManifest(index, { os: 'linux', architecture: 'amd64' })).toEqual({ digest: 'sha256:aa', mediaType: amd64.mediaType, size: 100 });
    expect(() => selectPlatformManifest({ manifests: [] }, { os: 'linux', architecture: 'amd64' })).toThrow(/no linux\/amd64/);
  });
});

const configBlob = {
  architecture: 'amd64',
  os: 'linux',
  created: '2026-10-01T00:00:00Z',
  config: { Env: ['PATH=/usr/bin', 'NGINX_VERSION=1.29.3'], Cmd: ['nginx', '-g', 'daemon off;'], Entrypoint: ['/docker-entrypoint.sh'], ExposedPorts: { '80/tcp': {} }, StopSignal: 'SIGQUIT', Labels: { z: '1', a: '2' }, User: '', WorkingDir: '', Volumes: null },
  rootfs: { type: 'layers', diff_ids: [] },
};

function image(tags: string[], digest = 'sha256:top'): RawImage {
  return {
    repository: 'docker.io/library/nginx',
    tags,
    digest,
    index: { mediaType: 'application/vnd.oci.image.index.v1+json', size: 10 },
    manifest: { digest: 'sha256:aa', mediaType: amd64.mediaType, size: 100 },
    config: rawConfig({ digest: 'sha256:cfg', mediaType: 'application/vnd.oci.image.config.v1+json', size: 50 }, configBlob),
    layers: [{ digest: 'sha256:l1', mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: 1000 }],
  };
}

describe('records', () => {
  it('keeps the runtime fields of the config verbatim, labels sorted', () => {
    const c = image(['1']).config;
    expect(Object.keys(c.config)).toEqual(['User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'ExposedPorts', 'StopSignal', 'Labels']);
    expect(Object.keys(c.config['Labels'] as object)).toEqual(['a', 'z']);
    expect(envValue(c, 'NGINX_VERSION')).toBe('1.29.3');
    expect(envValue(c, 'NOPE')).toBeUndefined();
  });

  it('makes the engine copy: empty strings dropped, ports as a list, filesFrom when given', () => {
    const ci = capturedImage(image(['latest']), 'sha256:rep');
    expect(ci.config).toEqual({
      digest: 'sha256:cfg',
      size: 50,
      created: '2026-10-01T00:00:00Z',
      env: ['PATH=/usr/bin', 'NGINX_VERSION=1.29.3'],
      entrypoint: ['/docker-entrypoint.sh'],
      cmd: ['nginx', '-g', 'daemon off;'],
      exposedPorts: ['80/tcp'],
      stopSignal: 'SIGQUIT',
      labels: { a: '2', z: '1' },
    });
    expect(ci.filesFrom).toBe('sha256:rep');
    expect('filesFrom' in capturedImage(image(['latest']))).toBe(false);
  });

  it('sorts images by repository then first tag, tags by code unit', () => {
    const imgs = sortImages([image(['stable', '1.28']), image(['mainline', 'latest', '1', '1.29'])]);
    expect(imgs.map((i) => i.tags)).toEqual([['1', '1.29', 'latest', 'mainline'], ['1.28', 'stable']]);
  });

  it('splits normalized references', () => {
    expect(splitReference('registry.k8s.io/coredns/coredns:v1.14.6')).toEqual({ repository: 'registry.k8s.io/coredns/coredns', tag: 'v1.14.6' });
    expect(() => splitReference('localhost:5000/x')).toThrow(/no tag/);
  });
});

describe('references', () => {
  it('assigns families by tag, alsoTags, else the repository default', () => {
    expect(familyFor('docker.io/library/nginx', ['alpine'])?.family).toBe('nginx-alpine');
    expect(familyFor('docker.io/library/nginx', ['1.17'])?.family).toBe('nginx-1.14.2');
    expect(familyFor('docker.io/library/nginx', ['1.25'])?.family).toBe('nginx');
    expect(familyFor('docker.io/library/busybox', ['uclibc'])?.family).toBe('busybox');
    expect(familyFor('docker.io/library/nosuch', ['1'])).toBeUndefined();
  });

  it('filters tag lists', () => {
    expect(keepTag('registry.k8s.io/kube-proxy', 'v1.37.2', [])).toBe(true);
    expect(keepTag('registry.k8s.io/kube-proxy', 'v1.29.0', [])).toBe(false);
    expect(keepTag('registry.k8s.io/kube-proxy', 'v1.29.0', ['v1.29.0'])).toBe(true);
    expect(keepTag('registry.k8s.io/pause', `sha256-${'a'.repeat(64)}.sig`, [])).toBe(false);
    expect(keepTag('docker.io/library/nginx', '1.14.2', [])).toBe(true);
  });
});

describe('diffCatalogs', () => {
  const base: Catalog = {
    header: { producedBy: '', captured: '2026-11-16', platform: 'linux/amd64', accept: '', registries: [], notes: [] },
    references: { 'docker.io/library/nginx:latest': 'sha256:a', 'docker.io/library/nginx:1.29': 'sha256:a' },
    missing: [],
    images: [],
    errors: [],
    repositoryTags: { 'docker.io/library/nginx': ['1.29', 'latest'] },
    officialImages: { hub: { url: '', count: 1 }, github: { repository: '', path: '', commit: 'c1', date: '', count: 1 }, names: ['nginx'], hubOnly: [] },
    families: [],
  };

  it('is empty for equal catalogs and names moved tags and tag list changes', () => {
    expect(diffCatalogs(base, structuredClone(base))).toEqual([]);
    const fresh = structuredClone(base);
    fresh.references['docker.io/library/nginx:latest'] = 'sha256:b';
    fresh.repositoryTags['docker.io/library/nginx'] = ['1.29', '1.30', 'latest'];
    expect(diffCatalogs(base, fresh)).toEqual(['docker.io/library/nginx:latest: moved sha256:a -> sha256:b', 'docker.io/library/nginx tags added: 1.30']);
  });
});
