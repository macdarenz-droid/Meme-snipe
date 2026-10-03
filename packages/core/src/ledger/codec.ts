// JSON that keeps bigints exact: a bigint is written as {"$bigint":"123"} and read back as 123n.

export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));

export const fromJson = <T = unknown>(text: unknown): T => {
  if (typeof text !== 'string') throw new TypeError(`expected JSON text, got ${typeof text}`);
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      const big = (v as { $bigint?: unknown }).$bigint;
      if (keys.length === 1 && typeof big === 'string' && /^-?(0|[1-9][0-9]*)$/.test(big)) return BigInt(big);
    }
    return v;
  }) as T;
};
