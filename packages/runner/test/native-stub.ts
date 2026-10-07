// Compile the unchanged synthetic fixture just as Vitest compiles fixtures, before its registered run starts.
// LocalControl still measures real process startup, its separate reconcile, SIGKILL and supervisor restarts.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';

export const nativeStub = (dir: string): string => {
  const compiled = join(dir, 'native-stub');
  mkdirSync(compiled);
  const worker = readFileSync(join(import.meta.dirname, '../stub/worker.ts'), 'utf8');
  const contract = readFileSync(join(import.meta.dirname, '../src/contract.ts'), 'utf8');
  const workerJs = stripTypeScriptTypes(worker).replace("'../src/contract.ts'", "'./contract.mjs'");
  writeFileSync(join(compiled, 'worker.mjs'), workerJs);
  writeFileSync(join(compiled, 'contract.mjs'), stripTypeScriptTypes(contract));
  writeFileSync(join(compiled, 'source.json'), JSON.stringify({
    worker_sha256: createHash('sha256').update(worker).digest('hex'),
    contract_sha256: createHash('sha256').update(contract).digest('hex'),
    transform: 'node:module stripTypeScriptTypes; contract import suffix only',
  }, null, 2));
  return join(compiled, 'worker.mjs');
};
