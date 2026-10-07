// B-M19-01 "Edge cases": no local redefinitions of shared types. Any type alias, interface, enum or class outside
// packages/types whose name is a type exported by @bot/types is rejected; import the shared type instead, or file a
// change request against the frozen package.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@typescript-eslint/parser';
import type { Rule } from 'eslint';

const TYPES_SRC = fileURLToPath(new URL('../../../packages/types/src/', import.meta.url));
const DECLARATIONS = ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSEnumDeclaration', 'ClassDeclaration'];

let cached: Set<string> | null = null;

/** Names of the types exported by the .ts files of `dir` (export type X, export interface X). */
export function exportedTypeNames(dir: string): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
    const program = parse(readFileSync(join(dir, file), 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' });
    for (const stmt of program.body) {
      if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
      const d = stmt.declaration;
      if (d.type === 'TSTypeAliasDeclaration' || d.type === 'TSInterfaceDeclaration') names.add(d.id.name);
    }
  }
  return names;
}

function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject local redefinitions of types exported by @bot/types' },
    schema: [],
    messages: { redefined: '"{{name}}" is a shared type of @bot/types: import it instead of redefining it (B-M19-01).' },
  },
  create(context) {
    if (isInside(context.filename, TYPES_SRC)) return {};
    cached ??= exportedTypeNames(TYPES_SRC);
    const names = cached;
    const listener: Rule.RuleListener = {};
    for (const kind of DECLARATIONS) {
      listener[kind] = (node: Rule.Node) => {
        const id = (node as unknown as { id?: { name?: string } | null }).id;
        if (id?.name !== undefined && names.has(id.name)) context.report({ node, messageId: 'redefined', data: { name: id.name } });
      };
    }
    return listener;
  },
};
export default rule;
