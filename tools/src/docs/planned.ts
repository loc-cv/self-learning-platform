// The checks and faults docs/SCENARIO_FORMAT.md §7.1 and §8 specify for later phases, as
// stand-ins with the argument schemas phase 00 wrote, so the worked examples (§13), which use
// them, can be validated against the generated schema. Each entry names the phase that builds it;
// that phase registers the real one and removes the entry here (a test fails while both exist).

import { CHECK, FAULT, type ArgsSchema, type CheckSpec, type Contribution, type FaultSpec, type Plugin } from "@simlab/kernel";

const planned = (): never => {
  throw new Error("a planned check or fault does not run");
};

export const PLANNED_CHECKS: readonly (CheckSpec & { phase: string })[] = [
  { name: "host.unit", phase: "25a", args: {"type":"object","properties":{"on":{"type":"string","minLength":1},"unit":{"type":"string","minLength":1},"active":{"type":"boolean"},"enabled":{"type":"boolean"}},"required":["on","unit"],"additionalProperties":false} as ArgsSchema, run: planned },
  { name: "net.reach", phase: "17", args: {"type":"object","properties":{"from":{"oneOf":[{"type":"object","properties":{"machine":{"type":"string","minLength":1}},"required":["machine"],"additionalProperties":false},{"type":"object","properties":{"pod":{"type":"object","properties":{"namespace":{"type":"string","minLength":1},"selector":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}},"required":["namespace"],"additionalProperties":false,"minProperties":2}},"required":["pod"],"additionalProperties":false}]},"to":{"type":"string","minLength":1},"expect":{"enum":["answered","refused","timeout","unresolved"]},"status":{"oneOf":[{"type":"integer"},{"type":"string","pattern":"^\\{\\{[a-z][a-zA-Z0-9]*\\}\\}$"}]},"bodyContains":{"type":"string","minLength":1}},"required":["from","to"],"additionalProperties":false} as ArgsSchema, run: planned },
  { name: "k8s.nodeReady", phase: "26a", args: {"type":"object","properties":{"node":{"type":"string","minLength":1},"ready":{"type":"boolean"}},"required":["node"],"additionalProperties":false} as ArgsSchema, run: planned },
  { name: "k8s.can", phase: "20a", args: {"type":"object","properties":{"as":{"type":"string","minLength":1},"verb":{"type":"string","minLength":1},"resource":{"type":"string","minLength":1},"namespace":{"type":"string","minLength":1},"name":{"type":"string","minLength":1},"allowed":{"type":"boolean"}},"required":["as","verb","resource"],"additionalProperties":false} as ArgsSchema, run: planned },
];

export const PLANNED_FAULTS: readonly (FaultSpec & { phase: string })[] = [
  { name: "host.process.kill", phase: "25a", args: {"type":"object","properties":{"on":{"type":"string","minLength":1},"unit":{"type":"string","minLength":1},"signal":{"enum":["KILL","TERM"]}},"required":["on","unit"],"additionalProperties":false} as ArgsSchema, inject: planned },
  { name: "k8s.cert.setValidity", phase: "28", args: {"type":"object","properties":{"on":{"type":"string","minLength":1},"path":{"type":"string","minLength":1},"notAfter":{"type":"string","pattern":"^[+-][0-9]+(s|m|h|d)$"}},"required":["on","path","notAfter"],"additionalProperties":false} as ArgsSchema, inject: planned },
];

export const plannedPlugin: Plugin = {
  name: "planned",
  contributions: { [CHECK]: [...PLANNED_CHECKS] as unknown as Contribution[], [FAULT]: [...PLANNED_FAULTS] as unknown as Contribution[] },
};
