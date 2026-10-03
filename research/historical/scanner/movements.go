package main

// Token movements (supervisor ruling, 2026-10-04): SPL Token and Token-2022 Transfer,
// TransferChecked, Burn, BurnChecked, MintTo and MintToChecked that do not run inside a
// pump or PumpSwap instruction (those are the swaps and creates the trade and event
// rows already carry), with owners resolved from the transaction's token balances.
//
// Which mints:
//   - mints ending in "pump": every movement in every successful transaction
//     (complete coverage);
//   - other mints: movements inside successful transactions that also carry a pump or
//     PumpSwap event of that mint. Their plain transfers elsewhere are not seen, so
//     each unit lists them in movement_coverage with scope "pump_transactions" and the
//     backtest treats their ownership outside those rows as unresolved.

import (
	"encoding/binary"
	"sort"
	"strconv"
	"strings"

	"github.com/mr-tron/base58"
)

var (
	tokenProgram     = mustPK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	token2022Program = mustPK("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
)

var movementCols = []string{"slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind",
	"from_owner", "to_owner", "amount", "from_account", "to_account"}

// movementCoverageCols: one row per mint and kind of coverage note in a unit.
//
//	scope pump_transactions: a mint not ending in "pump", searched only in its pump
//	  transactions;
//	scope unresolved: a token instruction this table does not decode for the mint
//	  (reason transfer_fee: Token-2022 TransferCheckedWithFee; owner_change:
//	  SetAuthority of an account owner; account_reused: one account index holding two
//	  mints in a transaction), so its ownership is unresolved from slot on;
//	scope empty_owner: movements whose owner could not be resolved (an account opened
//	  and closed inside one transaction), with their count.
var movementCoverageCols = []string{"mint", "scope", "slot", "reason", "count"}

// coverageMark is one unresolved-ownership note found in a transaction.
type coverageMark struct {
	mint, scope, reason string
	slot                uint64
}

// movementKind returns the movement kind and the source, destination and mint account
// positions of a token instruction (-1 when absent), or ok=false for other instructions.
func movementKind(data []byte) (kind string, src, dst, mintPos int, ok bool) {
	if len(data) < 9 {
		return "", 0, 0, 0, false
	}
	switch data[0] {
	case 3:
		return "transfer", 0, 1, -1, true
	case 12:
		return "transfer", 0, 2, 1, true
	case 8, 15:
		return "burn", 0, -1, 1, true
	case 7, 14:
		return "mint", -1, 1, 0, true
	}
	return "", 0, 0, 0, false
}

// hasMovementOutsideSwaps reports whether any token movement instruction runs outside
// pump and PumpSwap (a cheap check before parsing the full meta).
func hasMovementOutsideSwaps(groups [][]ixRef) bool {
	found := false
	walkOutsideSwaps(groups, func(gi, k int, ix ixRef) {
		if _, _, _, _, ok := movementKind(ix.data); ok {
			found = true
		}
	})
	return found
}

// walkOutsideSwaps calls fn for every token-program instruction with no pump or
// PumpSwap instruction among its callers (by stack height).
func walkOutsideSwaps(groups [][]ixRef, fn func(gi, k int, ix ixRef)) {
	for gi, g := range groups {
		var stack [][32]byte
		for k, ix := range g {
			h := ix.height
			if k == 0 {
				h = 1
			} else if h == 0 {
				h = 2 // older metas: no stack height; treat as called by the top-level instruction
			}
			if h-1 < len(stack) {
				stack = stack[:h-1]
			}
			inSwap := false
			for _, p := range stack {
				if p == pumpProgram || p == ammProgram {
					inSwap = true
				}
			}
			stack = append(stack, ix.program)
			if inSwap || (ix.program != tokenProgram && ix.program != token2022Program) {
				continue
			}
			fn(gi, k, ix)
		}
	}
}

// movementRows returns the movement rows of a successful transaction for the mints
// want accepts. k = 0 is the top-level instruction (inner_ix empty).
func movementRows(slot, bt string, txIdx int, keys [][32]byte, groups [][]ixRef, m *TransactionStatusMeta, want func(string) bool) ([][]string, []coverageMark) {
	type bal struct{ mint, owner string }
	acct := map[int]bal{}
	var marks []coverageMark
	slotN, _ := strconv.ParseUint(slot, 10, 64)
	mark := func(mint, scope, reason string) {
		if mint != "" && want(mint) {
			marks = append(marks, coverageMark{mint: mint, scope: scope, reason: reason, slot: slotN})
		}
	}
	for _, tb := range m.PreTokenBalances {
		acct[int(tb.AccountIndex)] = bal{tb.Mint, tb.Owner}
	}
	for _, tb := range m.PostTokenBalances {
		if pre, ok := acct[int(tb.AccountIndex)]; ok && pre.mint != tb.Mint {
			// one account index, two mints in one transaction: closed and reopened
			mark(pre.mint, "unresolved", "account_reused")
			mark(tb.Mint, "unresolved", "account_reused")
		}
		acct[int(tb.AccountIndex)] = bal{tb.Mint, tb.Owner}
	}
	key := func(i int) string {
		if i >= 0 && i < len(keys) {
			return base58.Encode(keys[i][:])
		}
		return ""
	}
	at := func(ix ixRef, pos int) int {
		if pos >= 0 && pos < len(ix.accts) {
			return ix.accts[pos]
		}
		return -1
	}
	var rows [][]string
	tidx := strconv.Itoa(txIdx)
	walkOutsideSwaps(groups, func(gi, k int, ix ixRef) {
		// Known instructions this table does not decode: the mint's ownership becomes
		// unresolved from this slot (counted in movement_coverage, not a failure).
		if len(ix.data) >= 2 && ix.data[0] == 26 && ix.data[1] == 1 && ix.program == token2022Program {
			mark(key(at(ix, 1)), "unresolved", "transfer_fee")
			return
		}
		if len(ix.data) >= 2 && ix.data[0] == 6 && ix.data[1] == 2 {
			mark(acct[at(ix, 0)].mint, "unresolved", "owner_change")
			return
		}
		kind, sp, dp, mp, ok := movementKind(ix.data)
		if !ok {
			return
		}
		src, dst := at(ix, sp), at(ix, dp)
		mint := ""
		if mp >= 0 {
			mint = key(at(ix, mp))
		}
		if mint == "" {
			if b, ok := acct[src]; ok && sp >= 0 {
				mint = b.mint
			} else if b, ok := acct[dst]; ok && dp >= 0 {
				mint = b.mint
			}
		}
		if mint == "" || !want(mint) {
			return
		}
		owner := func(i, pos int) string {
			if pos < 0 {
				return ""
			}
			return acct[i].owner
		}
		account := func(i, pos int) string {
			if pos < 0 {
				return ""
			}
			return key(i)
		}
		inner := ""
		if k > 0 {
			inner = strconv.Itoa(k - 1)
		}
		amount := strconv.FormatUint(binary.LittleEndian.Uint64(ix.data[1:9]), 10)
		fo, to := owner(src, sp), owner(dst, dp)
		if (sp >= 0 && fo == "") || (dp >= 0 && to == "") {
			mark(mint, "empty_owner", "")
		}
		rows = append(rows, []string{slot, bt, tidx, strconv.Itoa(gi), inner, mint, kind,
			fo, to, amount, account(src, sp), account(dst, dp)})
	})
	return rows, marks
}

// coverageRows folds a unit's marks into movement_coverage rows: per mint and
// (scope, reason), the first slot and the count, in mint order.
func coverageRows(partial map[string]bool, marks []coverageMark) [][]string {
	type k struct{ mint, scope, reason string }
	first := map[k]uint64{}
	count := map[k]int{}
	for _, m := range marks {
		kk := k{m.mint, m.scope, m.reason}
		if s, ok := first[kk]; !ok || m.slot < s {
			first[kk] = m.slot
		}
		count[kk]++
	}
	var rows [][]string
	for m := range partial {
		rows = append(rows, []string{m, "pump_transactions", "", "", ""})
	}
	for kk, s := range first {
		rows = append(rows, []string{kk.mint, kk.scope, strconv.FormatUint(s, 10), kk.reason, strconv.Itoa(count[kk])})
	}
	sort.Slice(rows, func(i, j int) bool { return strings.Join(rows[i], ",") < strings.Join(rows[j], ",") })
	return rows
}

func pumpSuffix(mint string) bool { return strings.HasSuffix(mint, "pump") }
