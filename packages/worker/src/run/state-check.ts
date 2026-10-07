// RC-FIXES (red team C, items 5 and R2-1/R2-2/R2-4): the saved state is checked against itself at start, before anything
// writes a default over a lost file. The ledger is the record of what the bot did; the JSON state files are what it knew
// besides (the owner's pause and the risk latches, the paper wallet, the paper attempts). A start whose files disagree
// about whether anything happened never starts on defaults: it refuses (a ledger lost or emptied while the other files
// hold trades; the paper wallet or the paper attempts lost while the ledger holds trades), or, when only the owner's
// controls are lost, starts with the kill switch latched and entries paused, with a critical alert.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTyped } from './json.ts';

/** The ledger's file name (core's `Ledger.FILE`), checked before the ledger is opened. */
const LEDGER = 'ledger.sqlite';
/** The state files that say the bot traded, and what they hold when it did. */
export const TRADE_EVIDENCE_FILES = ['account.json', 'paper.json', 'exits.json'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The ledger file is there and not empty (a 0-byte file is a lost ledger: SQLite would open it as a new one). */
export const ledgerPresent = (dir: string): boolean => {
  const p = join(dir, LEDGER);
  return existsSync(p) && statSync(p).size > 0;
};

/** What a JSON state file says about past trading: null when it does not exist; unreadable files count as evidence. */
const traded = (dir: string, name: (typeof TRADE_EVIDENCE_FILES)[number]): string | null => {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  let v: unknown;
  try {
    v = parseTyped(readFileSync(p, 'utf8'));
  } catch {
    return `${name} unreadable`;
  }
  if (!isObj(v)) return `${name} unreadable`;
  if (name === 'account.json') {
    const n = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).length : 0);
    return n('trades') + n('entries') > 0 ? `${name} holds ${n('trades')} trades and ${n('entries')} entries` : null;
  }
  if (name === 'paper.json') return isObj(v['attempts']) && Object.keys(v['attempts']).length > 0 ? `${name} holds ${Object.keys(v['attempts']).length} paper attempts` : null;
  return Object.keys(v).length > 0 ? `${name} holds ${Object.keys(v).length} exit plans` : null;
};

/**
 * Before the ledger is opened: a missing or empty ledger with state files that say the bot traded is a lost ledger,
 * never a cold start (its open positions would be dropped with no stop). Returns why it refuses, or null.
 */
export const ledgerLost = (dir: string): string | null => {
  if (ledgerPresent(dir)) return null;
  const why = TRADE_EVIDENCE_FILES.map((f) => traded(dir, f)).filter((x): x is string => x !== null);
  if (why.length === 0) return null;
  const p = join(dir, LEDGER);
  return `${LEDGER} is ${existsSync(p) ? 'empty' : 'missing'} but ${why.join(', ')}: refusing to start on a lost ledger (restore it from the backup)`;
};

/** What the ledger holds that the other state files must agree with. */
export interface LedgerEvidence {
  /** The ledger was there before this start opened it (not a cold start). */
  readonly existed: boolean;
  /** Book events (positions or intents): the bot has traded. */
  readonly traded: boolean;
  /** The signatures of every attempt the ledger holds. */
  readonly attempts: readonly string[];
}

/** After the ledger is opened: the files a ledger with trades needs. */
export interface StateVerdict {
  /** Why the start is refused; empty when it may go on. */
  readonly refuse: readonly string[];
  /**
   * control.json is gone after an earlier start (every start writes it): start latched and paused, with a critical
   * alert. An R10 latch can trip on a price move with no trade, so this does not wait for trades.
   */
  readonly controlLost: boolean;
}

export const checkState = (dir: string, ledger: LedgerEvidence): StateVerdict => {
  const refuse: string[] = [];
  if (!ledger.traded) {
    // An empty ledger: nothing else may say the bot traded (a ledger restored older than the files, or emptied).
    for (const f of TRADE_EVIDENCE_FILES) {
      const why = traded(dir, f);
      if (why !== null) refuse.push(`the ledger holds no trades but ${why}`);
    }
    return { refuse, controlLost: ledger.existed && !existsSync(join(dir, 'control.json')) };
  }
  if (!existsSync(join(dir, 'account.json'))) refuse.push('account.json is missing while the ledger holds trades (the paper wallet, NAV peak, day and week marks and entry count would start again)');
  const paper = join(dir, 'paper.json');
  let known = new Set<string>();
  if (existsSync(paper)) {
    try {
      const v = parseTyped(readFileSync(paper, 'utf8'));
      if (isObj(v) && isObj(v['attempts'])) known = new Set(Object.keys(v['attempts']));
    } catch {
      // The paper world's own read refuses it.
    }
  }
  const lost = ledger.attempts.filter((s) => !known.has(s));
  if (lost.length > 0) refuse.push(`paper.json ${existsSync(paper) ? `lacks ${lost.length} of the ledger's ${ledger.attempts.length} attempts` : 'is missing while the ledger holds attempts'} (their fees and fills would be counted again)`);
  return { refuse, controlLost: ledger.existed && !existsSync(join(dir, 'control.json')) };
};
