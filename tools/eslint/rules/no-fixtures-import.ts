// Ruling 32 (#304 merge red team, docs/reviews/Z03.md): a fixtures module may hold address literals (the
// bot/no-program-id-literal exemption), so production code must never import one, or a real address could reach a
// transaction or a filter through it. Any import, re-export, dynamic import or require() whose specifier ends in a
// path segment named `fixtures` (with or without a source extension; `@bot/contract/fixtures` included) is reported.
// eslint.config.mjs turns the rule off only where fixtures belong: the dashboard catalogue and test code.
import type { Rule } from 'eslint';

const FIXTURES = /(^|\/)fixtures(\.[cm]?[jt]sx?)?$/;

/** True when an import specifier names a fixtures module. */
export function isFixturesSpecifier(spec: string): boolean {
  return FIXTURES.test(spec);
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Only the dashboard catalogue and test code may import a fixtures module (Z03 ruling 32)' },
    schema: [],
    messages: { fixtures: 'Fixtures import: only the dashboard catalogue and test code may import a fixtures module (Z03 ruling 32).' },
  },
  create(context) {
    const check = (node: Rule.Node, source: unknown): void => {
      if (typeof source === 'string' && isFixturesSpecifier(source)) context.report({ node, messageId: 'fixtures' });
    };
    const literal = (n: unknown): unknown => {
      const x = n as { type?: string; value?: unknown; expressions?: unknown[]; quasis?: Array<{ value: { cooked?: string } }> } | null;
      if (x?.type === 'Literal') return x.value;
      if (x?.type === 'TemplateLiteral' && x.expressions?.length === 0) return x.quasis?.[0]?.value.cooked;
      return undefined;
    };
    return {
      ImportDeclaration(node) { check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value); },
      ExportAllDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { check(node, literal(node.source)); },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, literal(node.arguments[0]));
      },
    };
  },
};
export default rule;
