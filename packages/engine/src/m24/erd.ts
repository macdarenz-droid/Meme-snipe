// Entity-relationship diagram of the schema (B-M24-02 definition of done: "ERD generated into the repository docs").
// docs/ERD.md is this function's output; a test fails when the two differ. Relationships are drawn from a column to
// the table whose single-column key it names (the database declares no foreign keys; M24 repositories own integrity).
import { snake, TABLES, type TableDef } from './schema.ts';
import { storageOf } from './ddl.ts';

/** The table that owns a key name shared by several tables. */
const OWNERS: Readonly<Record<string, string>> = {
  mint: 'token', pool_id: 'pool', limit_id: 'limit_def', fill_id: 'fill', candidate_id: 'candidate',
};

function referenceTargets(tables: Readonly<Record<string, TableDef>>): Map<string, string> {
  const byKey = new Map<string, string[]>();
  for (const [name, def] of Object.entries(tables)) {
    if (def.key.length !== 1) continue;
    const key = snake(def.key[0] as string);
    if (key !== 'mint' && !key.endsWith('_id')) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), name]);
  }
  const out = new Map<string, string>();
  for (const [key, owners] of byKey) out.set(key, owners.length === 1 ? owners[0] as string : OWNERS[key] as string);
  return out;
}

/** Mermaid `erDiagram` of every table, its columns (storage class, PK and UK markers) and its references. */
export function erdMermaid(tables: Readonly<Record<string, TableDef>> = TABLES): string {
  const targets = referenceTargets(tables);
  const lines = ['erDiagram'];
  const links: string[] = [];
  for (const [name, def] of Object.entries(tables)) {
    lines.push(`  ${name} {`);
    const uniques = new Set((def.unique ?? []).flat());
    for (const [col, c] of Object.entries(def.columns)) {
      const marker = def.key.includes(col) ? ' PK' : uniques.has(col) ? ' UK' : '';
      lines.push(`    ${storageOf(c.kind)} ${snake(col)}${marker}`);
      const target = targets.get(snake(col));
      if (target !== undefined && target !== name) links.push(`  ${target} ||--o{ ${name} : ${snake(col)}`);
    }
    lines.push('  }');
  }
  return [...lines, ...links].join('\n');
}

/** The whole docs/ERD.md file. */
export function erdMarkdown(): string {
  return `# Database schema (ERD)

Generated from \`packages/engine/src/m24/schema.ts\` by \`erdMarkdown()\` (B-M24-02); do not edit by hand. A test fails
when this file and the schema differ. The schema is created by the numbered migrations in
\`packages/engine/src/m24/migrations/\`. Lines join a column to the table whose key it names; the database declares
no foreign keys.

\`\`\`mermaid
${erdMermaid()}
\`\`\`
`;
}
