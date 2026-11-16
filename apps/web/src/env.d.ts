// The content packs, bundled at build time by vite.config.ts (docs/decisions.md D-103).
declare module 'virtual:simlab/content' {
  import type { Json } from '@simlab/kernel';
  const content: { packs: { pack: { id: string; title: string; skills: { id: string; title: string }[] }; items: Json[] }[] };
  export default content;
}
