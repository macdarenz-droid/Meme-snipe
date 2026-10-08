// Small AST helpers shared by the bot lint rules. Nodes come from ESLint (ESTree plus typescript-eslint nodes);
// the casts below rely on the ESTree shapes: an Identifier has a name, a MemberExpression has an object and a property.
import type { Scope } from 'eslint';

/** The fields of an AST node the rules read. */
export interface AstNode {
  type: string;
  name?: string;
  computed?: boolean;
  object?: AstNode;
  property?: AstNode;
  value?: unknown;
}

const SKIPPED_KEYS = new Set(['parent', 'loc', 'range']);

function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** Depth-first search of `root` and its descendants; returns the first node `match` accepts. */
export function findNode(root: AstNode, match: (n: AstNode) => boolean): AstNode | null {
  if (match(root)) return root;
  for (const [key, child] of Object.entries(root)) {
    if (SKIPPED_KEYS.has(key)) continue;
    const children: unknown[] = Array.isArray(child) ? child : [child];
    for (const c of children) {
      if (!isNode(c)) continue;
      const found = findNode(c, match);
      if (found) return found;
    }
  }
  return null;
}

/** Names of the global object: `globalThis.Date`, `global.Date`, `window.Date` and `self.Date` all read `Date`. */
export const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/**
 * The global a reference names: `Date`, `globalThis.Date`, `global['Date']`, `window.globalThis.Date` → "Date";
 * anything else → null.
 */
export function globalName(n: AstNode): string | null {
  if (n.type === 'Identifier') return n.name as string;
  if (n.type !== 'MemberExpression') return null;
  const owner = globalName(n.object as AstNode);
  return owner !== null && GLOBAL_OBJECTS.has(owner) ? memberName(n) : null;
}

/** A string the node spells out exactly: 'a', "a" and `a` (a template with no substitutions) → "a"; else null. */
export function stringValue(n: AstNode): string | null {
  if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : null;
  if (n.type !== 'TemplateLiteral') return null;
  const t = n as unknown as { expressions: unknown[]; quasis: Array<{ value: { cooked: string | null } }> };
  return t.expressions.length === 0 ? (t.quasis[0] as { value: { cooked: string | null } }).value.cooked : null;
}

/** The property name of a member expression: `a.b`, `a['b']` and `` a[`b`] `` → "b"; any other computed key → null. */
export function memberName(n: AstNode): string | null {
  const property = n.property as AstNode;
  return n.computed ? stringValue(property) : (property.name as string);
}

/** A node with the parent link ESLint sets on every AST node. */
export interface LinkedNode extends AstNode { parent?: LinkedNode }

/**
 * Every value reference (not a type reference) to a global named in `names`, whether ESLint resolved it to a declared
 * global (`Number`, `Intl`) or left it unresolved. A local variable of the same name is not a global and not returned.
 */
export function globalValueReferences(globalScope: Scope.Scope, names: ReadonlySet<string>): LinkedNode[] {
  const refs = globalScope.through.filter((r) => names.has(r.identifier.name));
  for (const name of names) {
    const v = globalScope.set.get(name);
    if (v !== undefined && v.defs.length === 0) refs.push(...v.references);
  }
  return refs.filter((r) => (r as { isValueReference?: boolean }).isValueReference !== false).map((r) => r.identifier as unknown as LinkedNode);
}

/** The outermost node of a global path that starts at `id`: `globalThis` in `globalThis.Intl.x` → `globalThis.Intl`. */
export function globalPath(id: LinkedNode): LinkedNode {
  let n = id;
  while (n.parent?.type === 'MemberExpression' && n.parent.object === n && globalName(n.parent) !== null) n = n.parent;
  return n;
}
