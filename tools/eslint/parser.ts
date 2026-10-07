// The TypeScript parser for ESLint, imported from here so it resolves from tools/package.json, where its TypeScript peer
// is 6.x (typescript-eslint 8.70.1 supports TypeScript below 6.1; the repository builds with TypeScript 7).
import tsParser from '@typescript-eslint/parser';

export default tsParser;
