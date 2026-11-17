// The content packs, bundled at build time by vite.config.ts (docs/decisions.md D-103).
declare module 'virtual:simlab/content' {
  import type { Json } from '@simlab/kernel';
  import type { PackManifest, Sidecar } from '@simlab/learn';
  export interface CurriculumDomain {
    /** `cka.workloads`: the first two segments of its competencies' ids. */
    id: string;
    title: string;
    /** Share of the exam, in percent. */
    weight: number;
    competencies: { id: string; text: string }[];
  }
  export interface CurriculumExam {
    id: string;
    title: string;
    domains: CurriculumDomain[];
  }
  const content: { packs: { pack: PackManifest; items: Json[]; sidecars: Sidecar[] }[]; curriculum: CurriculumExam[] };
  export default content;
}
