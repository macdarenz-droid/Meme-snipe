// UI-T03 Definition of done (docs/UI.md): the money module is the only place the dashboard formats numbers. Forbid
// calls of toFixed(), toPrecision() and toLocaleString() (`x.toFixed(2)`, `x['toFixed'](2)`, optional calls), and any
// use of Intl.NumberFormat (`new Intl.NumberFormat()`, `globalThis.Intl['NumberFormat']`, `const { NumberFormat } =
// Intl`) in the dashboard's source, and Intl used as a whole value (`const I = Intl`, `f(Intl)`, a rest or array
// destructure), which reaches NumberFormat out of sight; eslint.config.mjs turns the rule off only for the money module's
// exact path.
import type { Rule } from 'eslint';
import { globalName, globalPath, globalValueReferences, memberName, stringValue, type AstNode, type LinkedNode } from './ast.ts';

export const FORMATTING_METHODS = new Set(['toFixed', 'toPrecision', 'toLocaleString']);

/** The globals Intl is reached through. */
const INTL_ROOTS: ReadonlySet<string> = new Set(['Intl', 'globalThis', 'global', 'window', 'self']);

/**
 * True when a reference reaches Intl as a whole value. A member access (`Intl.X`) and an object destructure that names
 * its keys are checked by key instead; `typeof Intl` in a type converts nothing.
 */
function isIntlValue(ref: LinkedNode): boolean {
  const path = globalPath(ref);
  if (globalName(path) !== 'Intl') return false;
  const p = path.parent as LinkedNode & { init?: unknown; id?: { type: string; properties: Array<{ type: string }> } };
  if ((p.type === 'MemberExpression' && p.object === path) || p.type === 'TSTypeQuery') return false;
  const keyed = p.type === 'VariableDeclarator' && p.init === path && p.id?.type === 'ObjectPattern' && p.id.properties.every((q) => q.type === 'Property');
  return !keyed;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid ad-hoc number formatting outside the dashboard money module' },
    schema: [],
    messages: {
      adHoc: '{{name}}() formats a number outside the money module: use src/lib/money.ts (docs/UI.md UI-T03).',
      intl: 'Intl.NumberFormat formats a number outside the money module: use src/lib/money.ts (docs/UI.md UI-T03).',
      intlValue: 'Intl used as a value reaches Intl.NumberFormat out of sight: use src/lib/money.ts, or name the Intl member you need (docs/UI.md UI-T03).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = (node as unknown as { callee: AstNode }).callee;
        if (callee.type !== 'MemberExpression') return;
        const name = memberName(callee);
        if (name !== null && FORMATTING_METHODS.has(name)) context.report({ node, messageId: 'adHoc', data: { name } });
      },
      MemberExpression(node) {
        const n = node as unknown as AstNode;
        if (memberName(n) === 'NumberFormat' && globalName(n.object as AstNode) === 'Intl') context.report({ node, messageId: 'intl' });
      },
      VariableDeclarator(node) {
        const d = node as unknown as { id: { type: string; properties: Array<{ type: string; computed?: boolean; key?: AstNode }> }; init: AstNode | null };
        if (d.id.type !== 'ObjectPattern' || d.init === null || globalName(d.init) !== 'Intl') return;
        const keys = d.id.properties.map((p) => (p.type !== 'Property' ? null : p.computed === true ? stringValue(p.key as AstNode) : (p.key as AstNode).name ?? stringValue(p.key as AstNode)));
        if (keys.includes('NumberFormat')) context.report({ node, messageId: 'intl' });
      },
      'Program:exit'(node) {
        for (const ref of globalValueReferences(context.sourceCode.getScope(node), INTL_ROOTS)) {
          if (isIntlValue(ref)) context.report({ node: ref as unknown as Rule.Node, messageId: 'intlValue' });
        }
      },
    };
  },
};
export default rule;
