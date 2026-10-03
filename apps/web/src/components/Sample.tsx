import { createContext, useContext, type ReactNode } from 'react';
import { SAMPLE_LABEL } from '../lib/preview.ts';

const SampleContext = createContext(false);

/** Wraps any view that shows made-up numbers, so every sheet opened from it carries the marker too. */
export function SampleScope({ children }: { children: ReactNode }) {
  return <SampleContext.Provider value={true}>{children}</SampleContext.Provider>;
}

export function useSample(): boolean {
  return useContext(SampleContext);
}

export function SampleMarker() {
  return (
    <span className="sample-marker" role="note">
      {SAMPLE_LABEL}
    </span>
  );
}
