import { Section } from '../components/ui.tsx';
import { ResultsStats } from '../performance/ResultsStats.tsx';
import { RiskMeters } from '../performance/RiskMeters.tsx';
import { Results } from '../performance/Results.tsx';
import { TokenTable } from '../screens/Home.tsx';
import { SessionCard } from '../screens/Snipe.tsx';
import { WalletSummary } from '../screens/Wallet.tsx';
import { FIXTURE_MARKER, fixtureResults, fixtureResultsSmall, fixtureSession, fixtureTokens, fixtureWallet } from './fixtures.ts';

/** Dev-only review page. Every value here is fake. */
export default function Fixtures() {
  return (
    <div className="screen-grid" data-marker={FIXTURE_MARKER}>
      <div className="fixture-banner span-2" role="note">
        Fixture data. Fake values for layout review only.
      </div>
      <Section title="Discovered" className="span-2">
        <TokenTable rows={fixtureTokens} />
      </Section>
      <SessionCard session={fixtureSession} />
      <Section title="Risk">
        <RiskMeters meters={fixtureResults.risk} />
      </Section>
      <Section title="Small sample">
        <ResultsStats stats={fixtureResultsSmall.stats} />
      </Section>
      <Results view={fixtureResults} />
      <WalletSummary wallet={fixtureWallet} />
    </div>
  );
}
