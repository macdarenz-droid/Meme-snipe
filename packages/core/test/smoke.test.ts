import { expect, test } from 'vitest';
import { CORE_VERSION } from '../src/index.ts';
test('toolchain', () => { expect(CORE_VERSION).toBe('0.1.0'); });
