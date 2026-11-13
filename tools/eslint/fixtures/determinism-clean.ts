// lint-as: packages/kernel/src/prng.ts
// expect: none
// A local named like a banned global member is fine, and so is the rest of Math.
export function draw(state: number): number {
  const Math2 = { random: () => state };
  return Math.floor(Math2.random() * 10) + Math.max(1, 2);
}
export function shadow(Date: number, process: string): string {
  return `${Date}${process}`;
}
