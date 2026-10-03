import { useCallback, useState } from 'react';
import { SampleScope } from '../components/Sample.tsx';
import { Section } from '../components/ui.tsx';
import { FundingSheet, type FundingKind } from '../funding/FundingSheet.tsx';
import { TokenTable } from '../screens/Home.tsx';
import { Snipe } from '../screens/Snipe.tsx';
import { WalletSummary } from '../screens/Wallet.tsx';
import { FIXTURE_MONTH, fixtureApi } from './dashboardFixtures.ts';
import { States } from './States.tsx';
import { FIXTURE_MARKER, fixtureSession, fixtureTokens, fixtureWallet } from './fixtures.ts';

const api = fixtureApi();

/** Dev and preview review page. Every value here is made up; the shell shows the "Sample data" marker. */
export default function Fixtures() {
  const [funding, setFunding] = useState<FundingKind | null>(null);
  const close = useCallback(() => setFunding(null), []);
  return (
    <SampleScope>
      <div className="screen-grid" data-marker={FIXTURE_MARKER}>
        <Section title="Discovered" className="span-2">
          <TokenTable rows={fixtureTokens} />
        </Section>
        <div className="span-2">
          <Snipe session={fixtureSession} api={api} months={FIXTURE_MONTH} />
        </div>
        <States />
        <WalletSummary wallet={fixtureWallet} onFund={setFunding} />
        <FundingSheet kind={funding} onClose={close} savedWallet={fixtureWallet.savedWallet} botWallet={fixtureWallet.botAddress} gatePassed />
      </div>
    </SampleScope>
  );
}
