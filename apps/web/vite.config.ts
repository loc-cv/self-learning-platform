// Vite for the web app. Everything the page needs is bundled: the engine runs in a module
// worker, and the content packs are read from disk at build time into a virtual module
// (docs/decisions.md D-103), so nothing is fetched at runtime.

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { CONTENT_ROOT, loadPacks } from '@simlab/content';

const CONTENT_ID = 'virtual:simlab/content';
const RESOLVED = `\0${CONTENT_ID}`;

/** `import content from 'virtual:simlab/content'`: every pack and its items as plain data. */
function contentPacks(): Plugin {
  return {
    name: 'simlab-content',
    resolveId: (id) => (id === CONTENT_ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      this.addWatchFile(CONTENT_ROOT);
      const packs = loadPacks().map((p) => ({ pack: p.pack, items: p.items.map((i) => i.raw) }));
      return `export default ${JSON.stringify({ packs })};`;
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
