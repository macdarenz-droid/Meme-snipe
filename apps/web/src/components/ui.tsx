import type { ReactNode } from 'react';

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`} aria-label={title}>
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{title}</p>
      {detail && <p className="empty-detail">{detail}</p>}
    </div>
  );
}

/** A label and value pair; a missing value shows a dash, never an invented number. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'gain' | 'loss' | undefined }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className={tone ? `num ${tone}` : 'num'}>{value ?? '—'}</dd>
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ state }: { state: 'off' | 'on' | 'warn' }) {
  return <span className={`dot dot-${state}`} aria-hidden="true" />;
}
