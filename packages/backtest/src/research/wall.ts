// The holdout wall a research CLI runs under (RES-3, RES-5): the committed window, checked against the research
// config's sealed holdout and, when it exists, BT-2's holdout store, read with BT-2's own reader.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RESEARCH_CONFIG } from '../../../core/src/config/index.ts';
import { readHoldoutStore } from '../holdout.ts';
import { holdoutStarts, loadWindow, type PracticeWindow, resolveWindow } from './practice.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const WINDOW_PATH = join(ROOT, 'research', 'signals', 'window.json');
/** BT-2's holdout store (RESEARCH_CONFIG.holdout.registryPath). A missing store does not block: the config date holds. */
export const STORE_PATH = join(ROOT, RESEARCH_CONFIG.holdout.registryPath);

export interface WallOptions {
  /** A window file that may only move the wall earlier. */
  readonly windowPath?: string;
  /** Another holdout store file (must exist). */
  readonly storePath?: string;
  /** Only for tests: the config's holdout. */
  readonly config?: { readonly fromDay: string };
  readonly committedPath?: string;
}

export const researchWindow = (o: WallOptions = {}): PracticeWindow => {
  const storePath = o.storePath ?? STORE_PATH;
  if (o.storePath !== undefined && !existsSync(storePath)) throw new Error(`holdout store ${storePath} does not exist`);
  const store = existsSync(storePath) ? readHoldoutStore(storePath) : null;
  const committed = loadWindow(o.committedPath ?? WINDOW_PATH);
  return resolveWindow(committed, o.windowPath === undefined ? committed : loadWindow(o.windowPath), holdoutStarts(o.config ?? RESEARCH_CONFIG.holdout, store));
};
