// M02 log codes and their fields, for the engine's M27 logger (B-M27-01: a field not declared is written as
// `[redacted]`). Plain data, so this package keeps no dependency on the engine (C-02); the engine merges it with
// mergeLogCodes. `signature` is an M27 correlation field and is not declared again.
export const M02_LOG_CODES = {
  'm02.idl_verified': { fields: { program: 'id', commit: 'string', sha256: 'string' } },
  'm02.idl_hash_mismatch': { fields: { file: 'name', expected: 'string', actual: 'string' } },
  'm02.unknown_event': { fields: { program: 'id', discriminator: 'string' } },
} as const;
