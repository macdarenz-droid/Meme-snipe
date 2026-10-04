import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { lazy, Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { apiFor } from './api/client.ts';
import { connection, useConnection, type Connection } from './api/connection.ts';
import type { WorkerStatus } from './api/contract.ts';
import { schemaFor } from './api/schemas.ts';
import { useEndpoint } from './api/useEndpoint.ts';
import { SampleMarker } from './components/Sample.tsx';
import { DESKTOP, useMedia } from './lib/media.ts';
import { page } from './lib/motion.ts';
import { SAMPLES_TITLE } from './lib/preview.ts';
import { hrefFor, SCREENS, useRoute, type Screen } from './lib/route.ts';
import { Home } from './screens/Home.tsx';
import { Snipe } from './screens/Snipe.tsx';
import { Wallet } from './screens/Wallet.tsx';
import { NavIcon } from './shell/icons.tsx';
import { Lockup, Mark } from './shell/Logo.tsx';
import { EMPTY_SESSION } from './screens/types.ts';
import { dataLabel, modeLabel, PauseButton, shellSession, StatusList, type ShellSession } from './shell/Status.tsx';
import { ThemeSwitch } from './shell/ThemeSwitch.tsx';

// Dev and preview builds only: SAMPLES is a build-time constant, false in a normal production build, so the import is dropped.
const Fixtures = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === '1' ? lazy(() => import('./dev/Fixtures.tsx')) : null;

const TITLES: Record<Screen, string> = { home: 'Home', snipe: 'Snipe', wallet: 'Wallet', fixtures: SAMPLES_TITLE };

function screenFor(s: Screen): ReactNode {
  if (s === 'snipe') return <Snipe />;
  if (s === 'wallet') return <Wallet />;
  if (s === 'fixtures' && Fixtures) {
    return (
      <Suspense fallback={null}>
        <Fixtures />
      </Suspense>
    );
  }
  return <Home />;
}

/** The paper worker's status for the shell's session line (the only mode a worker runs today). */
export function useShellSession(conn: Connection): ShellSession {
  const api = useMemo(() => apiFor(conn.origin, connection()), [conn.origin]);
  const status = useEndpoint<WorkerStatus>('paper', `status|${conn.origin ?? 'none'}`, schemaFor('status', 'paper'), () => api.status('paper'));
  return shellSession(status, conn);
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export function App() {
  const [screen, go] = useRoute();
  const desktop = useMedia(DESKTOP);
  const conn = useConnection();
  const session = useShellSession(conn);

  useEffect(() => {
    document.title = `${TITLES[screen]} · Zeroed`;
  }, [screen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e) || document.querySelector('[role="dialog"]')) return;
      const target = SCREENS.find((s) => s.key === e.key);
      if (target) {
        e.preventDefault();
        go(target.id);
        requestAnimationFrame(() => document.getElementById('main')?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        {desktop ? (
          <nav className="rail" aria-label="Main">
            <div className="rail-brand">
              <Lockup />
            </div>
            <ul className="rail-nav">
              {SCREENS.map((s) => (
                <li key={s.id}>
                  <a href={hrefFor(s.id)} className="rail-link" aria-current={screen === s.id ? 'page' : undefined}>
                    <NavIcon id={s.id} />
                    <span>{s.label}</span>
                    <kbd>{s.key}</kbd>
                  </a>
                </li>
              ))}
            </ul>
            <div className="rail-foot">
              <StatusList session={EMPTY_SESSION} state={session} conn={conn} />
              <PauseButton />
              <ThemeSwitch />
            </div>
          </nav>
        ) : (
          <header className="mobile-head">
            <Mark size={22} />
            <span className="badge badge-neutral">{modeLabel(EMPTY_SESSION)}</span>
            {screen === 'fixtures' && <SampleMarker />}
            <PauseButton compact />
            <span className="mobile-status muted small">
              {session.label} · {dataLabel(conn)}
            </span>
          </header>
        )}

        <main id="main" className="main" tabIndex={-1}>
          <header className="page-head">
            <h1>{TITLES[screen]}</h1>
            {desktop && screen === 'fixtures' && <SampleMarker />}
          </header>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={screen}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={page}
            >
              {screenFor(screen)}
            </motion.div>
          </AnimatePresence>
          {!desktop && (
            <div className="mobile-controls">
              <ThemeSwitch />
            </div>
          )}
        </main>

        {!desktop && (
          <nav className="tabs" aria-label="Main">
            {SCREENS.map((s) => (
              <a key={s.id} href={hrefFor(s.id)} className="tab" aria-current={screen === s.id ? 'page' : undefined}>
                <NavIcon id={s.id} />
                <span>{s.label}</span>
              </a>
            ))}
          </nav>
        )}
      </div>
    </MotionConfig>
  );
}
