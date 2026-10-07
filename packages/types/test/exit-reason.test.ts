// Contract test (B-M19-01 logic 4): the ExitReason union equals the VM-06 exit_reason enum after UC-01.
// The type tests (types.test-d.ts) prove EXIT_REASONS holds exactly the members of the ExitReason union.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { EXIT_REASONS } from '@bot/types';

// The list as written in the ticket (SPEC-B B-M19-01 logic 4).
const TICKET_LIST = ['stop', 'target', 'trailing_stop', 'time_stop', 'manual_close', 'flatten_all', 'risk_breach', 'halt_flatten',
  'liquidity_collapse', 'authority_change', 'venue_disabled', 'sentinel_flatten', 'orphan_close', 'written_off', 'other'];

/** Reads the VM-06 `items[].exit_reason` row of docs/UI.md, the dashboard contract's source of truth. */
function vm06ExitReasons(): string[] {
  const ui = readFileSync(new URL('../../../docs/blueprint/UI.md', import.meta.url), 'utf8');
  const row = ui.split('\n').find((line) => line.startsWith('| `items[].exit_reason` |'));
  assert.ok(row, 'VM-06 items[].exit_reason row not found in docs/blueprint/UI.md');
  const enumCell = row.split(' | ')[1];
  assert.ok(enumCell, 'VM-06 exit_reason row has no enum cell');
  return [...enumCell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('ExitReason contract', () => {
  it('has no duplicates', () => {
    assert.equal(new Set(EXIT_REASONS).size, EXIT_REASONS.length);
  });
  it('equals the VM-06 exit_reason enum in docs/blueprint/UI.md', () => {
    assert.deepEqual(sorted(EXIT_REASONS), sorted(vm06ExitReasons()));
  });
  it('equals the list in the ticket', () => {
    assert.deepEqual(sorted(EXIT_REASONS), sorted(TICKET_LIST));
  });
});
