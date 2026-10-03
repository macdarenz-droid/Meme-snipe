import { Component, type ReactNode } from 'react';
import { ErrorState } from './State.tsx';

/**
 * Catches a render error inside one section (or sheet) and shows that
 * section's error state, so one bad record never blanks the app. Data is
 * checked before render (src/api/schemas.ts); this is the last line.
 */
export class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <ErrorState reason="bad-data" /> : this.props.children;
  }
}
