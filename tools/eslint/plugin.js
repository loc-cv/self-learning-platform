// Local ESLint plugin with the two guarantees PLAN.md §12 asks the gate to enforce:
//   simlab/package-boundaries   — imports follow the dependency graph in boundaries.js
//   simlab/engine-determinism   — engine source uses no ambient time, randomness, timers or host APIs
// Fixtures in ./fixtures prove each one fires (plugin.test.ts).

import { builtinModules } from 'node:module';
import path from 'node:path';
import { WORKSPACES, workspaceOf } from './boundaries.js';

const toPosix = (/** @type {string} */ p) => p.split(path.sep).join('/');

/**
 * Calls `visit(sourceNode)` for the module specifier of every static import, re-export,
 * literal dynamic import, `import('x')` type and `require('x')`.
 * @param {(node: any) => void} visit
 */
function importVisitors(visit) {
  const literal = (/** @type {any} */ node) => {
    if (node && node.type === 'Literal' && typeof node.value === 'string') visit(node);
  };
  return {
    ImportDeclaration: (/** @type {any} */ n) => literal(n.source),
    ExportNamedDeclaration: (/** @type {any} */ n) => literal(n.source),
    ExportAllDeclaration: (/** @type {any} */ n) => literal(n.source),
    ImportExpression: (/** @type {any} */ n) => literal(n.source),
    TSImportType: (/** @type {any} */ n) => literal(n.source ?? n.argument?.literal),
    CallExpression: (/** @type {any} */ n) => {
      if (n.callee.type === 'Identifier' && n.callee.name === 'require') literal(n.arguments[0]);
    },
  };
}

/** @type {import('eslint').Rule.RuleModule} */
const packageBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Workspace imports must follow the dependency graph (PLAN.md §6).' },
    schema: [],
    messages: {
      notAllowed:
        "'{{from}}' must not import '@simlab/{{target}}'. Allowed: {{allowed}}. The dependency rule is kernel ← host ← domain plugins; learn imports kernel only (PLAN.md §6).",
      deep: "Import '@simlab/{{target}}' through its entry point, not '{{specifier}}'.",
      self: "Import files of the same package with a relative path, not '{{specifier}}'.",
      escape:
        "Relative import '{{specifier}}' leaves '{{from}}'. Cross-package imports go through '@simlab/<name>'.",
    },
  },
  create(context) {
    const rel = toPosix(path.relative(context.cwd, context.filename));
    const root = workspaceOf(rel);
    if (root === undefined) return {};
    const self = WORKSPACES[root];
    if (self === undefined) return {};

    return importVisitors((node) => {
      const specifier = /** @type {string} */ (node.value);
      if (specifier.startsWith('@simlab/')) {
        const [target, ...rest] = specifier.slice('@simlab/'.length).split('/');
        if (target === self.name) {
          context.report({ node, messageId: 'self', data: { specifier } });
        } else if (target === undefined || !self.allowed.includes(target)) {
          context.report({
            node,
            messageId: 'notAllowed',
            data: {
              from: root,
              target: target ?? '',
              allowed: self.allowed.length ? self.allowed.map((a) => `@simlab/${a}`).join(', ') : 'none',
            },
          });
        } else if (rest.length > 0) {
          context.report({ node, messageId: 'deep', data: { target, specifier } });
        }
        return;
      }
      if (specifier.startsWith('.')) {
        const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)));
        if (resolved !== root && !resolved.startsWith(`${root}/`)) {
          context.report({ node, messageId: 'escape', data: { specifier, from: root } });
        }
      }
    });
  },
};

// Ambient globals that make a run depend on something other than (scenario, seed, input log),
// or that exist only in one host environment. CLAUDE.md hard rule 4, PLAN.md §3.4 and §6.
/** @type {Record<string, string>} */
const BANNED_GLOBALS = {
  // Wall-clock time: use the kernel clock.
  Date: 'wall-clock time; use the kernel clock',
  performance: 'wall-clock time; use the kernel clock',
  // Timers and scheduling: schedule a kernel event instead.
  setTimeout: 'a real timer; schedule a kernel event',
  setInterval: 'a real timer; schedule a kernel event',
  setImmediate: 'a real timer; schedule a kernel event',
  clearTimeout: 'a real timer; schedule a kernel event',
  clearInterval: 'a real timer; schedule a kernel event',
  clearImmediate: 'a real timer; schedule a kernel event',
  queueMicrotask: 'host scheduling; schedule a kernel event',
  requestAnimationFrame: 'a real timer; schedule a kernel event',
  requestIdleCallback: 'a real timer; schedule a kernel event',
  // Locale and time zone of the machine running the engine.
  Intl: 'depends on the host locale and time zone',
  // Randomness outside the named PRNG streams.
  crypto: 'host randomness; use a named PRNG stream',
  // Node globals.
  process: 'a Node global; the engine runs in a Web Worker too',
  Buffer: 'a Node global; the engine runs in a Web Worker too',
  require: 'a Node global; the engine runs in a Web Worker too',
  module: 'a Node global; the engine runs in a Web Worker too',
  __dirname: 'a Node global; the engine runs in a Web Worker too',
  __filename: 'a Node global; the engine runs in a Web Worker too',
  global: 'a Node global; the engine runs in a Web Worker too',
  // DOM and browser globals.
  window: 'a browser global; the engine runs in Node too',
  document: 'a browser global; the engine runs in Node too',
  navigator: 'a browser global; the engine runs in Node too',
  self: 'a browser global; the engine runs in Node too',
  localStorage: 'real I/O; state lives in the world',
  sessionStorage: 'real I/O; state lives in the world',
  indexedDB: 'real I/O; state lives in the world',
  Worker: 'a host API; the app owns workers',
  // Real I/O.
  fetch: 'real I/O; the engine never touches the network',
  XMLHttpRequest: 'real I/O; the engine never touches the network',
  WebSocket: 'real I/O; the engine never touches the network',
  console: 'real I/O; emit a trace record or write to a program stream',
  // An escape hatch to all of the above.
  globalThis: 'reaches every banned global',
};

const NODE_BUILTINS = new Set(builtinModules);

/** @type {import('eslint').Rule.RuleModule} */
const engineDeterminism = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Engine packages use no ambient time, randomness, timers, Node or DOM APIs (CLAUDE.md hard rule 4).',
    },
    schema: [],
    messages: {
      global: "'{{name}}' is banned in engine packages: {{why}}.",
      mathRandom: "'Math.random' is banned in engine packages: use a named PRNG stream from the kernel.",
      nodeImport: "'{{specifier}}' is a Node built-in. Engine packages run in a Web Worker and in Node.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    /** @param {any} ref */
    const reportRef = (ref) => {
      const name = ref.identifier.name;
      const why = Object.hasOwn(BANNED_GLOBALS, name) ? BANNED_GLOBALS[name] : undefined;
      if (why !== undefined) context.report({ node: ref.identifier, messageId: 'global', data: { name, why } });
    };

    return {
      ...importVisitors((node) => {
        const specifier = /** @type {string} */ (node.value);
        if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) {
          context.report({ node, messageId: 'nodeImport', data: { specifier } });
        }
      }),
      MemberExpression(/** @type {any} */ node) {
        if (node.object.type !== 'Identifier' || node.object.name !== 'Math') return;
        const prop = node.property;
        const isRandom = node.computed
          ? prop.type === 'Literal' && prop.value === 'random'
          : prop.type === 'Identifier' && prop.name === 'random';
        // Only the global Math, not a local variable that shadows it.
        const scope = sourceCode.getScope(node);
        const ref = scope.references.find((/** @type {any} */ r) => r.identifier === node.object);
        const shadowed = ref?.resolved != null && ref.resolved.defs.length > 0;
        if (isRandom && !shadowed) context.report({ node, messageId: 'mathRandom' });
      },
      'Program:exit'(/** @type {any} */ program) {
        const globalScope = sourceCode.getScope(program);
        // Globals unknown to the scope manager.
        for (const ref of globalScope.through) reportRef(ref);
        // Globals the scope manager knows from its lib or from languageOptions.globals:
        // variables with no definition in this file.
        for (const variable of globalScope.variables) {
          if (variable.defs.length > 0) continue;
          for (const ref of variable.references) reportRef(ref);
        }
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-simlab' },
  rules: {
    'package-boundaries': packageBoundaries,
    'engine-determinism': engineDeterminism,
  },
};
