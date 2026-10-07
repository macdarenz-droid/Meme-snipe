// B-M19-01 logic 3 / ARCH 5.0: forbid Date.now, performance.now and Math.random outside the clock and RNG modules
// (eslint.config.mjs turns this rule off only for the exact paths in CLOCK_AND_RNG_MODULES). `new Date()` with no
// argument and `Date()` read the same wall clock, so they are forbidden too, and so is destructuring
// (`const { now } = Date`, `const { Date: { now } } = globalThis`). `globalThis`, `global`, `window` and `self` name
// the global object. Use the injected Clock and Rng. A syntactic rule cannot follow aliasing (`const D = Date`).
import type { Rule } from 'eslint';
import { GLOBAL_OBJECTS, globalName, memberName, stringValue, type AstNode } from './ast.ts';

/** The fields of a destructuring pattern, or of the property holding it, that the rule reads. */
interface PatternNode extends AstNode {
  parent: { type: string; id?: unknown; init?: AstNode | null; left?: unknown; right?: AstNode; value?: unknown; key?: AstNode; computed?: boolean; parent?: unknown };
  properties: Array<{ type: string; computed?: boolean; key?: AstNode }>;
}

/** The key of a destructured property: `{ now }`, `{ now: n }`, `{ 'now': n }` and `{ ['now']: n }` → "now". */
function keyName(property: { computed?: boolean; key?: AstNode }): string | null {
  const key = property.key as AstNode;
  return property.computed || key.type !== 'Identifier' ? stringValue(key) : (key.name as string);
}

/**
 * The global `pattern` destructures: `const {…} = Date`, `({…} = Date)` and a parameter default `({…} = Date) => …`
 * read "Date"; in `const { Date: {…} } = globalThis` the inner pattern reads "Date". Null when unknown.
 */
function patternSource(pattern: PatternNode): string | null {
  const p = pattern.parent;
  if (p.type === 'VariableDeclarator' && p.id === pattern) return p.init ? globalName(p.init) : null;
  if ((p.type === 'AssignmentExpression' || p.type === 'AssignmentPattern') && p.left === pattern) return globalName(p.right as AstNode);
  if (p.type === 'Property' && p.value === pattern) {
    const outer = patternSource(p.parent as PatternNode);
    return outer !== null && GLOBAL_OBJECTS.has(outer) ? keyName(p) : null;
  }
  return null;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid reading the clock or Math.random outside the clock and RNG modules' },
    schema: [],
    messages: {
      clock: '{{what}} reads the clock: use the injected Clock (ARCH 5.0).',
      random: 'Math.random is not seeded: use the injected Rng (ARCH 5.0).',
    },
  },
  create(context) {
    const check = (node: Rule.Node, owner: string | null, prop: string | null): void => {
      if ((owner === 'Date' || owner === 'performance') && prop === 'now') context.report({ node, messageId: 'clock', data: { what: `${owner}.now` } });
      if (owner === 'Math' && prop === 'random') context.report({ node, messageId: 'random' });
    };
    return {
      MemberExpression(node) {
        const n = node as unknown as AstNode;
        check(node, globalName(n.object as AstNode), memberName(n));
      },
      ObjectPattern(node) {
        const n = node as unknown as PatternNode;
        const owner = patternSource(n);
        if (owner === null) return;
        for (const property of n.properties) {
          if (property.type === 'Property') check(node, owner, keyName(property));
        }
      },
      NewExpression(node) {
        const n = node as unknown as { callee: AstNode; arguments: unknown[] };
        if (globalName(n.callee) === 'Date' && n.arguments.length === 0) context.report({ node, messageId: 'clock', data: { what: 'new Date()' } });
      },
      CallExpression(node) {
        const n = node as unknown as { callee: AstNode };
        if (globalName(n.callee) === 'Date') context.report({ node, messageId: 'clock', data: { what: 'Date()' } });
      },
    };
  },
};
export default rule;
