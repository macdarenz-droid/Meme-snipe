import { STATUS_FLAGS } from '../api/contract.ts';
import { Empty, Section } from '../components/ui.tsx';
import { StatusCard, StatusFlags } from '../dashboard/Sections.tsx';
import { ErrorState, Loading, StaleNote } from '../dashboard/State.tsx';

const STALE_AT = new Date(Date.now() - 42_000).toISOString();

/** Samples screen only: every section state and every worker state, side by side. */
export function States() {
  return (
    <>
      <Section title="Loading">
        <Loading />
      </Section>
      <Section title="Empty">
        <Empty title="No trades" />
      </Section>
      <Section title="Stale">
        <StaleNote asOf={STALE_AT} />
        <Empty title="No open trade" />
      </Section>
      <Section title="Errors">
        <ErrorState reason="offline" />
        <ErrorState reason="mixed-modes" />
      </Section>
      <Section title="Worker states" className="span-2">
        <StatusFlags status={{ mode: 'paper', connected: true, flags: [...STATUS_FLAGS], risk: [] }} />
        <StatusCard status={{ mode: 'paper', connected: true, flags: [...STATUS_FLAGS], risk: [] }} />
      </Section>
    </>
  );
}
