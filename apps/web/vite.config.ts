// Vite for the web app. Everything the page needs is bundled: the engine runs in a module
// worker, and the content packs are read from disk at build time into a virtual module
// (docs/decisions.md D-103), so nothing is fetched at runtime.

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT_ROOT, loadPacks, parseYaml, type ItemFile } from '@simlab/content';
import { parseSidecar, type Sidecar } from '@simlab/learn';

const CONTENT_ID = 'virtual:simlab/content';
const RESOLVED = `\0${CONTENT_ID}`;

/**
 * A build for the browser tests also bundles the fixture pack (one item of each kind, two
 * sidecars; docs/LEARNING_MODEL.md §11): `SIMLAB_FIXTURES=1`. The app the owner runs never has it.
 */
const WITH_FIXTURES = process.env['SIMLAB_FIXTURES'] === '1';

/** The item's Vietnamese sidecar when it is one (`npm run content:i18n` reports the ones that are not). */
function sidecarOf(i: ItemFile): Sidecar | undefined {
  if (!i.sidecar) return undefined;
  const { sidecar } = parseSidecar(i.sidecar.raw);
  return sidecar && sidecar.id === i.fileId ? sidecar : undefined;
}

const CURRICULUM = join(CONTENT_ROOT, '..', '..', 'docs', 'curriculum', 'competencies.yaml');

/** The curricula the content is built against (docs/curriculum/): exams, domains with weights, competencies. */
function curriculum(): unknown {
  const doc = parseYaml(readFileSync(CURRICULUM, 'utf8'), 'docs/curriculum/competencies.yaml') as unknown as {
    exams: Record<string, { title: string; domains: { id: string; title: string; weight: number; competencies: { id: string; text: string }[] }[] }>;
  };
  return Object.entries(doc.exams).map(([id, e]) => ({ id, title: e.title, domains: e.domains }));
}

/** `import content from 'virtual:simlab/content'`: every pack, its items and their sidecars as plain data. */
function contentPacks(): Plugin {
  return {
    name: 'simlab-content',
    resolveId: (id) => (id === CONTENT_ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      this.addWatchFile(CONTENT_ROOT);
      const loaded = [...loadPacks(), ...(WITH_FIXTURES ? loadPacks(join(CONTENT_ROOT, 'fixtures')) : [])];
      const packs = loaded.map((p) => ({ pack: p.pack, items: p.items.map((i) => i.raw), sidecars: p.items.flatMap((i) => sidecarOf(i) ?? []) }));
      this.addWatchFile(CURRICULUM);
      return `export default ${JSON.stringify({ packs, curriculum: curriculum() })};`;
    },
    handleHotUpdate(ctx) {
      if (!ctx.file.startsWith(CONTENT_ROOT) || !ctx.file.endsWith('.yaml')) return undefined;
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED);
      if (mod) ctx.server.moduleGraph.invalidateModule(mod);
      ctx.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}

export default defineConfig({
  plugins: [react(), contentPacks()],
  // The worker is bundled separately and needs the content module too.
  worker: { format: 'es', plugins: () => [contentPacks()] },
  build: {
    target: 'es2024',
    // The engine bundle is large by nature (vendored API schema, kubectl's command manifest).
    chunkSizeWarningLimit: 16_000,
    sourcemap: true,
  },
  server: { strictPort: true },
});
