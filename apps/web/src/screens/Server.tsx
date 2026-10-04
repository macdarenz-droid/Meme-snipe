import { useId, useState, type FormEvent } from 'react';
import { connection, useConnection, type Connection, type ConnectionStore } from '../api/connection.ts';
import { parseServer, SERVER_ERROR_TEXT, type ServerError } from '../api/server.ts';
import { Badge, Dot, Section } from '../components/ui.tsx';
import { melDateTime } from '../dashboard/time.ts';

const STATE_LABEL: Record<Connection['state'], string> = { none: 'Not set', connecting: 'Connecting', online: 'Online', error: 'Server error', update: 'App update needed', offline: 'Offline' };

export const PLACEHOLDER = 'https://zeroed.example.ts.net';

/** "Online", "Offline · last update 3 Oct, 14:32", "Server error · no update yet". The update time is the last good data only. */
export function connectionLabel(c: Connection): string {
  if (c.state !== 'offline' && c.state !== 'error') return STATE_LABEL[c.state];
  return `${STATE_LABEL[c.state]} · ${c.lastOk ? `last update ${melDateTime(c.lastOk)}` : 'no update yet'}`;
}

export const connectionDot = (c: Connection): 'on' | 'off' | 'warn' => (c.state === 'online' ? 'on' : c.state === 'offline' || c.state === 'error' || c.state === 'update' ? 'warn' : 'off');

export function ServerForm({ initial = '', onSave, onCancel }: { initial?: string; onSave: (origin: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<ServerError | null>(null);
  const ids = { input: useId(), error: useId() };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseServer(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onSave(parsed.origin);
  };
  return (
    <form className="server-form" onSubmit={submit} noValidate>
      <div className="field-block">
        <label className="field-label" htmlFor={ids.input}>
          Server address
        </label>
        <input
          id={ids.input}
          className="input mono"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? ids.error : undefined}
        />
        {error && (
          <p id={ids.error} className="field-error" role="alert">
            {SERVER_ERROR_TEXT[error]}
          </p>
        )}
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary">
          Save
        </button>
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The worker's tailnet address, entered once and remembered; its connection state and last update. */
export function ServerCard({ store = connection() }: { store?: ConnectionStore }) {
  const c = useConnection(store);
  const [editing, setEditing] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const save = (origin: string) => {
    setUnsaved(!store.setServer(origin));
    setEditing(false);
  };
  return (
    <Section title="Server" className="span-2" aside={<Badge>{STATE_LABEL[c.state]}</Badge>}>
      {c.origin === null || editing ? (
        <ServerForm initial={c.origin ?? ''} onSave={save} {...(editing ? { onCancel: () => setEditing(false) } : {})} />
      ) : (
        <ServerView c={c} onChange={() => setEditing(true)} onRemove={() => store.clear()} />
      )}
      {unsaved && <p className="small muted">Storage is blocked; the address lasts until the app closes.</p>}
    </Section>
  );
}

export function ServerView({ c, onChange, onRemove }: { c: Connection; onChange: () => void; onRemove: () => void }) {
  return (
    <>
      <dl className="kv">
        <div>
          <dt>Address</dt>
          <dd className="address">{c.origin}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd role="status">
            <Dot state={connectionDot(c)} /> {connectionLabel(c)}
          </dd>
        </div>
        <div>
          <dt>Last update</dt>
          <dd className="num">{c.lastOk ? melDateTime(c.lastOk) : '—'}</dd>
        </div>
        {(c.state === 'error' || c.state === 'update') && c.lastAnswer && (
          <div>
            <dt>Last answer</dt>
            <dd className="num">{melDateTime(c.lastAnswer)}</dd>
          </div>
        )}
        <div>
          <dt>Access</dt>
          <dd>Read only</dd>
        </div>
      </dl>
      <div className="actions">
        <button type="button" className="button" onClick={onChange}>
          Change
        </button>
        <button type="button" className="button" onClick={onRemove}>
          Remove
        </button>
      </div>
    </>
  );
}
