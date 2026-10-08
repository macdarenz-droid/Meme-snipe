// Loading timing (UI-T05; DS Motion and Universal states): a loading indicator appears only after 200 ms, so a fast
// answer never flashes a skeleton, and once shown it stays at least 400 ms.
export const LOADING_DELAY_MS = 200;
export const LOADING_MIN_MS = 400;

/** When a skeleton shows and hides for a request from `startMs` to `endMs`; null when it never shows. */
export function skeletonWindow(startMs: number, endMs: number): { showAt: number; hideAt: number } | null {
  const showAt = startMs + LOADING_DELAY_MS;
  return endMs < showAt ? null : { showAt, hideAt: Math.max(endMs, showAt + LOADING_MIN_MS) };
}
