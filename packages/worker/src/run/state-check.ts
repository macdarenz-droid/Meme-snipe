// RC-FIXES (red team C, items 5 and R2-1/R2-2/R2-4): the saved state is checked against itself at start, before anything
// writes a default over a lost file. The ledger is the record of what the bot did; the JSON state files are what it knew
// besides (the owner's pause and the risk latches, the paper wallet, the paper attempts). A start whose files disagree
// about whether anything happened never starts on defaults: it refuses (a ledger lost or emptied while the other files
// hold trades; the paper wallet or the paper attempts lost while the ledger holds trades), or, when only the owner's
// controls are lost, starts with the kill switch latched and entries paused, with a critical alert.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTyped } from './json.ts';

/** The state files that say the bot traded, and what they hold when it did. */
export const TRADE_EVIDENCE_FILES = ['account.json', 'paper.json', 'exits.json'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The ledger file (`ledger`: its name, core's `Ledger.FILE`) is there and not empty: a 0-byte file is a lost ledger, which
 * the database would open as a new one.
 */
export const ledgerPresent = (dir: string, ledger: string): boolean => {
  const p = join(dir, ledger);
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
export const ledgerLost = (dir: string, ledger: string): string | null => {
  if (ledgerPresent(dir, ledger)) return null;
  const why = TRADE_EVIDENCE_FILES.map((f) => traded(dir, f)).filter((x): x is string => x !== null);
  if (why.length === 0) return null;
  const p = join(dir, ledger);
  return `${ledger} is ${existsSync(p) ? 'empty' : 'missing'} but ${why.join(', ')}: refusing to start on a lost ledger (restore it from the backup)`;
};

/** What the ledger holds that the other state files must agree with. */
/**
 * RC-STATE review R4-1: written by the first start of this code. Releases before it wrote control.json only on a latch
 * trip or an owner pause, so before this marker exists a missing control.json means never written, not lost.
 */
export const STATE_VERSION_FILE = 'state-version.json';
/** RC-STATE review R4-3: why the last start was refused (removed by the next start that is not). */
export const REFUSED_FILE = 'refused.json';

export interface LedgerEvidence {
  /** The ledger was there before this start opened it (not a cold start). */
  readonly existed: boolean;
  /** Book events (positions or intents): the bot has traded. */
  readonly traded: boolean;
  /** Positions the ledger holds (any status). */
  readonly positions: number;
  /**
   * The signatures of every fill the ledger holds: each was a paper attempt that landed, so paper.json must hold it. (An
   * attempt signed but never sent is in the ledger and not in paper.json: a death between the two.)
   */
  readonly fills: readonly string[];
}

/** After the ledger is opened: the files a ledger with trades needs. */
export interface StateVerdict {
  /** Why the start is refused; empty when it may go on. */
  readonly refuse: readonly string[];
  /**
   * control.json is gone after a start of this code (every start writes it, and the state-version marker says one ran):
   * start latched and paused, with a critical alert. An R10 latch can trip on a price move with no trade, so this does
   * not wait for trades.
   */
  readonly controlLost: boolean;
}

/** Trades account.json holds still open (no close time), or 0 when it cannot say. */
const openTrades = (dir: string): number => {
  const p = join(dir, 'account.json');
  if (!existsSync(p)) return 0;
  try {
    const v = parseTyped(readFileSync(p, 'utf8'));
    return isObj(v) && Array.isArray(v['trades']) ? v['trades'].filter((t) => isObj(t) && t['closedAtMs'] === null).length : 0;
  } catch {
    return 0;
  }
};

export const checkState = (dir: string, ledger: LedgerEvidence): StateVerdict => {
  const refuse: string[] = [];
  // A trade account.json holds open is a position the ledger must hold (review of #280): with none there, its exit
  // and its stop are gone.
  const open = ledger.positions === 0 ? openTrades(dir) : 0;
  if (open > 0) refuse.push(`account.json holds ${open} open trades but the ledger holds no position (their exits would never run)`);
  if (!ledger.traded) {
    // An empty ledger: no paper attempt or exit plan may say the bot traded (a ledger restored older than the files, or
    // emptied). account.json is left out here: tests and tools seed its trades alone, and a lost or empty ledger file
    // with account trades is refused before the ledger is opened (`ledgerLost`).
    for (const f of ['paper.json', 'exits.json'] as const) {
      const why = traded(dir, f);
      if (why !== null) refuse.push(`the ledger holds no trades but ${why}`);
    }
    return { refuse, controlLost: controlLost(dir, ledger.existed) };
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
  const lost = ledger.fills.filter((s) => !known.has(s));
  if (lost.length > 0) refuse.push(`paper.json ${existsSync(paper) ? `lacks ${lost.length} of the ledger's ${ledger.fills.length} filled attempts` : 'is missing while the ledger holds fills'} (their fees and fills would be counted again)`);
  return { refuse, controlLost: controlLost(dir, ledger.existed) };
};

/** control.json is gone after a start of this code wrote it (the marker); before the marker it was never written. */
const controlLost = (dir: string, existed: boolean): boolean => existed && existsSync(join(dir, STATE_VERSION_FILE)) && !existsSync(join(dir, 'control.json'));
