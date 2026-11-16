// A describer that meets a field the simulator cannot render (an exotic volume source) stops with
// NotSimulated; describe then prints the `[sim]` notice and nothing else (docs/FIDELITY.md §4.1).

export class NotSimulated extends Error {
  readonly what: string;
  constructor(what: string) {
    super(what);
    this.what = what;
    this.name = 'NotSimulated';
  }
}

export function notSimulated(what: string): never {
  throw new NotSimulated(what);
}
