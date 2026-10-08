// A-M01-01 logic 1: no source file other than the constants registry may contain a program ID literal, so a mistyped
// address cannot reach a transaction or a filter. The known IDs are read from the registry itself
// (packages/venue/src/constants.ts, the `PROGRAMS` object); eslint.config.mjs turns the rule off only for that file.
// A string or a template without expressions whose whole value is a known program ID is reported; import the constant
// instead. Ported from Snipe-solana card C03 (#6 @ 6ae4d62); C11's fixture capture (tools/fixtures/lib.ts) is not
// ported (it reads the network), so the registry is the only exempt file here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@typescript-eslint/parser';
import type { Rule } from 'eslint';
import { findNode, type AstNode } from './ast.ts';

export const CONSTANTS_FILE = fileURLToPath(new URL('../../../packages/venue/src/constants.ts', import.meta.url));

/** The string values of the `PROGRAMS` object in the constants registry `file`. */
export function knownProgramIds(file: string = CONSTANTS_FILE): Set<string> {
  const program = parse(readFileSync(file, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' }) as unknown as AstNode;
  const decl = findNode(program, (n) => n.type === 'VariableDeclarator' && (n as { id?: AstNode }).id?.name === 'PROGRAMS');
  const ids = new Set<string>();
  if (decl === null) return ids;
  const visit = (n: AstNode): boolean => {
    if (n.type === 'Literal' && typeof n.value === 'string') ids.add(n.value);
    return false;
  };
  findNode((decl as { init?: AstNode }).init as AstNode, visit);
  return ids;
}

let cached: Set<string> | null = null;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject program ID literals outside the constants registry (A-M01-01)' },
    schema: [],
    messages: { literal: 'Program ID literal: import it from @bot/venue/constants (A-M01-01).' },
  },
  create(context) {
    cached ??= knownProgramIds();
    const ids = cached;
    return {
      Literal(node) {
        if (typeof node.value === 'string' && ids.has(node.value)) context.report({ node, messageId: 'literal' });
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0 && ids.has(node.quasis[0]?.value.cooked ?? '')) context.report({ node, messageId: 'literal' });
      },
    };
  },
};
export default rule;
