// A-M01-01 logic 1: no source file other than the constants registry may contain a program ID literal, so a mistyped
// address cannot reach a transaction or a filter. The known IDs are read from the registry itself
// (packages/venue/src/constants.ts, the `PROGRAMS` object); eslint.config.mjs turns the rule off only for that file.
// A string or a template without expressions whose whole value is a known program ID is reported; import the constant
// instead. Ported from Snipe-solana card C03 (#6 @ 6ae4d62); C11's fixture capture (tools/fixtures/lib.ts) is not
// ported (it reads the network), so the registry is the only exempt file here.
// Z03 round 2 (ruling m7): any base58 literal that decodes to 32 bytes (an address: a mint, a fixed account or a
// program not yet in the registry) is reported too, so ACCOUNTS and MINTS are covered as well. Deliberate string
// building at run time is out of scope (docs/DECISIONS.md Z03-9); review catches it. Round 3 (ruling 16): an address
// inside a longer string (`solana:<address>`, padding, a URL path) is reported too: every run of base58 characters,
// split at any other character, is checked. Concatenation and JSON config stay out of scope (Z03-9).
// Ruling 32 (#304 merge red team): fixture files run the rule with `allowAddresses`, so they may hold addresses (random
// test keys, a sample mint) but never a `PROGRAMS` id; only the registry itself turns the rule off.
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

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when `s` is base58 text that decodes to exactly 32 bytes (Solana address length). */
export function isAddressLiteral(s: string): boolean {
  if (!BASE58.test(s)) return false;
  let zeros = 0;
  while (s[zeros] === '1') zeros++;
  let v = 0n;
  for (const c of s) v = v * 58n + BigInt(ALPHABET.indexOf(c));
  const body = v === 0n ? 0 : Math.ceil(v.toString(16).length / 2);
  return zeros + body === 32;
}

/** The runs of base58 characters in `s`, split at every other character (a candidate address token each). */
export function base58Runs(s: string): string[] {
  return s.split(/[^1-9A-HJ-NP-Za-km-z]+/).filter((t) => t.length > 0);
}

let cached: Set<string> | null = null;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject program ID literals outside the constants registry (A-M01-01)' },
    schema: [{ type: 'object', properties: { allowAddresses: { type: 'boolean' } }, additionalProperties: false }],
    messages: {
      literal: 'Program ID literal: import it from @bot/venue/constants (A-M01-01).',
      address: 'Address literal: add it to @bot/venue/constants with its fact ID, or read it from a fixture file (A-M01-01).',
    },
  },
  create(context) {
    cached ??= knownProgramIds();
    const ids = cached;
    const allowAddresses = (context.options[0] as { allowAddresses?: boolean } | undefined)?.allowAddresses === true;
    const check = (node: Rule.Node, value: string): void => {
      const runs = base58Runs(value);
      if (runs.some((t) => ids.has(t))) context.report({ node, messageId: 'literal' });
      else if (!allowAddresses && runs.some(isAddressLiteral)) context.report({ node, messageId: 'address' });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value.cooked ?? '');
      },
    };
  },
};
export default rule;
