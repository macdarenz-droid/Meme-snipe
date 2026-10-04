// The mutation runner's generator (scripts/mutate.mjs): comments, strings and templates are never mutated, by any
// operator, including the forced if-conditions.
import { describe, expect, test } from 'vitest';

type Mutant = { start: number; end: number; rep: string; op: string; orig: string };
const { mutantsOf } = (await import('../scripts/mutate.mjs' as string)) as { mutantsOf: (file: string, src: string) => Mutant[] };

const ifs = (src: string) => mutantsOf('x.ts', src).filter((m) => m.op.startsWith('if→'));

describe('mutate.mjs mutant generator', () => {
  test('an if in code gets both forced conditions, over the whole condition', () => {
    const src = 'export const f = (a: number) => {\n  if (a > 1) return 1;\n  return 0;\n};\n';
    expect(ifs(src).map((m) => [m.op, m.orig])).toEqual([['if→true', 'a > 1'], ['if→false', 'a > 1']]);
  });

  test('an if inside a comment, a string or a template is not mutated', () => {
    const src = [
      '// if (comment) here',
      '/* block: if (x) y */',
      "const s = 'if (str)';",
      'const d = "if (dq)";',
      'const t = `if (tpl)`;',
      'export const g = () => 1;',
      '',
    ].join('\n');
    expect(ifs(src)).toEqual([]);
    // No other operator touches them either.
    expect(mutantsOf('x.ts', src).map((m) => m.orig)).toEqual(['1', '1']);
  });

  test('an if in a comment whose condition a later code parenthesis would close is not mutated', () => {
    // Without the code check on the `if (` itself, the scan from the comment ends at the call's `)` and makes a mutant.
    const src = 'export const v = f(\n  // if (x\n  1);\n';
    expect(ifs(src)).toEqual([]);
  });

  test("a parenthesis in a string inside the condition does not cut the condition short", () => {
    const src = "export const h = (s: string) => {\n  if (s === ')' || s === '(') return 1;\n  return 0;\n};\n";
    expect(ifs(src).map((m) => m.orig)).toEqual(["s === ')' || s === '('", "s === ')' || s === '('"]);
  });
});
