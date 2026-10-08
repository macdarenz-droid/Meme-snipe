// B-M19-01 logic 3 / ARCH 16.1: forbid Number(), parseFloat() and parseInt() on on-chain unit quantities. A name is a
// unit quantity when it ends in Lamports, Base, Slot or Height at a word boundary, in any case: `feeLamports`,
// `fee_lamports`, `LAMPORTS`, `lamports`, `slot`; or when it is exactly `amount` (the RPC token-amount field). Names
// count as identifiers, member properties (`info.lamports`) and computed string keys (`info['lamports']`).
// On-chain quantities stay bigint; a JS number silently loses precision above 2^53.
import type { Rule } from 'eslint';
import { findNode, globalName, memberName, type AstNode } from './ast.ts';

const UNIT_SUFFIXES = ['lamports', 'base', 'slot', 'height'];
const UNIT_NAMES = ['amount'];
const NUMBER_FUNCTIONS = new Set(['Number', 'parseFloat', 'parseInt']);

/**
 * True when `name` ends in a unit at a word boundary: the unit is the whole name, follows "_" or "$", or starts with a
 * capital letter (camelCase). `database` and `timeslot` are not units; `lineHeight` is (a reviewed false positive).
 */
export function isUnitName(name: string): boolean {
  const lower = name.toLowerCase();
  if (UNIT_NAMES.includes(lower)) return true;
  return UNIT_SUFFIXES.some((unit) => {
    if (!lower.endsWith(unit)) return false;
    const at = name.length - unit.length;
    const first = name[at] as string;
    return at === 0 || name[at - 1] === '_' || name[at - 1] === '$' || first !== first.toLowerCase();
  });
}

/** The unit name a node spells: an identifier, or the property of a member expression (`a.b`, `a['b']`); else null. */
function unitNameOf(n: AstNode): string | null {
  const name = n.type === 'Identifier' ? (n.name as string) : n.type === 'MemberExpression' ? memberName(n) : null;
  return name !== null && isUnitName(name) ? name : null;
}

/** The number conversion `callee` names (`Number`, `parseFloat`, `parseInt`, `Number.parseFloat`, `Number.parseInt`), or null. */
export function converterName(callee: AstNode): string | null {
  const g = globalName(callee);
  if (g !== null) return NUMBER_FUNCTIONS.has(g) ? g : null;
  if (callee.type !== 'MemberExpression' || globalName(callee.object as AstNode) !== 'Number') return null;
  const prop = memberName(callee);
  return prop === 'parseFloat' || prop === 'parseInt' ? `Number.${prop}` : null;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid converting on-chain unit quantities (lamports, base units, slots, heights, amounts) to JS numbers' },
    schema: [],
    messages: { unitToNumber: '{{fn}}() on "{{name}}": on-chain quantities stay bigint (ARCH 16.1).' },
  },
  create(context) {
    function check(node: Rule.Node): void {
      const call = node as unknown as { callee: AstNode; arguments: AstNode[] };
      const fn = converterName(call.callee);
      if (fn === null) return;
      for (const arg of call.arguments) {
        const hit = findNode(arg, (n) => unitNameOf(n) !== null);
        if (hit) context.report({ node, messageId: 'unitToNumber', data: { fn, name: unitNameOf(hit) as string } });
      }
    }
    return { CallExpression: check, NewExpression: check };
  },
};
export default rule;
