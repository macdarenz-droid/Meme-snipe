package main

import (
	"encoding/binary"
	"strconv"

	"github.com/mr-tron/base58"
)

// Delegations and token-account authority changes (GATE-1e: a delegate or a new close
// authority is control over the holder's tokens). One row per SPL Token or Token-2022
// instruction outside pump and PumpSwap, under the coverage rule of movements: every
// mint ending in "pump", other mints only in their pump transactions.
//
//	approve / approve_checked: Approve (4: account 0, delegate 1) and ApproveChecked (13:
//	  account 0, mint 1, delegate 2); authority = the delegate, amount = the approved amount;
//	revoke: Revoke (5: account 0); authority and amount empty;
//	set_owner / set_close_authority: SetAuthority (6) of type AccountOwner (2) or
//	  CloseAccount (3) on account 0; authority = the new one (empty when cleared).
//
// owner and mint come from the token balances, else from the instruction that initialised
// the account in the transaction (else empty: no row without a mint); owner is the
// account's owner, never the signer.
var delegationCols = []string{"slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "mint", "kind",
	"account", "owner", "authority", "amount"}

// delegationKind returns the kind and the account, mint and delegate positions (-1 when
// absent) of a delegation instruction, or ok=false.
func delegationKind(data []byte) (kind string, acct, mintPos, delegate int, ok bool) {
	if len(data) == 0 {
		return "", 0, 0, 0, false
	}
	switch data[0] {
	case 4:
		if len(data) >= 9 {
			return "approve", 0, -1, 1, true
		}
	case 13:
		if len(data) >= 10 {
			return "approve_checked", 0, 1, 2, true
		}
	case 5:
		return "revoke", 0, -1, -1, true
	case 6:
		if len(data) >= 3 && (data[1] == 2 || data[1] == 3) && (data[2] == 0 || len(data) >= 35) {
			if data[1] == 2 {
				return "set_owner", 0, -1, -1, true
			}
			return "set_close_authority", 0, -1, -1, true
		}
	}
	return "", 0, 0, 0, false
}

// delegationRows returns the delegation rows of a successful transaction for the mints
// `want` accepts.
func delegationRows(slot, bt string, txIdx int, keys [][32]byte, groups [][]ixRef, m *TransactionStatusMeta, want func(string) bool) [][]string {
	type bal struct{ mint, owner string }
	acct := map[int]bal{}
	for _, tb := range m.PreTokenBalances {
		acct[int(tb.AccountIndex)] = bal{tb.Mint, tb.Owner}
	}
	for _, tb := range m.PostTokenBalances {
		acct[int(tb.AccountIndex)] = bal{tb.Mint, tb.Owner}
	}
	key := func(i int) string {
		if i >= 0 && i < len(keys) {
			return base58.Encode(keys[i][:])
		}
		return ""
	}
	var temp map[int]string
	var rows [][]string
	tidx := strconv.Itoa(txIdx)
	walkOutsideSwaps(groups, func(gi, k int, ix ixRef) {
		kind, ap, mp, dp, ok := delegationKind(ix.data)
		if !ok || ap >= len(ix.accts) || mp >= len(ix.accts) || dp >= len(ix.accts) {
			return
		}
		a := ix.accts[ap]
		mint := ""
		if mp >= 0 {
			mint = key(ix.accts[mp])
		} else if b, ok := acct[a]; ok {
			mint = b.mint
		} else {
			mint = initMint(groups, a, key)
		}
		if mint == "" || !want(mint) {
			return
		}
		owner := ""
		if b, ok := acct[a]; ok {
			owner = b.owner
		} else {
			if temp == nil {
				temp = tempOwners(groups, key)
			}
			owner = temp[a]
		}
		authority, amount := "", ""
		switch {
		case kind == "approve" || kind == "approve_checked":
			authority = key(ix.accts[dp])
			amount = strconv.FormatUint(binary.LittleEndian.Uint64(ix.data[1:9]), 10)
		case kind == "set_owner" || kind == "set_close_authority":
			if ix.data[2] == 1 {
				authority = base58.Encode(ix.data[3:35])
			}
		}
		inner := ""
		if k > 0 {
			inner = strconv.Itoa(k - 1)
		}
		rows = append(rows, []string{slot, bt, tidx, strconv.Itoa(gi), inner, mint, kind, key(a), owner, authority, amount})
	})
	return rows
}

// initMint is the mint of a token account initialised in the transaction (absent from the
// token balances): InitializeAccount, InitializeAccount2 and InitializeAccount3 all name
// the mint as account 1.
func initMint(groups [][]ixRef, a int, key func(int) string) string {
	mint := ""
	for _, g := range groups {
		for _, ix := range g {
			if (ix.program == tokenProgram || ix.program == token2022Program) && len(ix.data) > 0 &&
				(ix.data[0] == 1 || ix.data[0] == 16 || ix.data[0] == 18) && len(ix.accts) > 1 && ix.accts[0] == a {
				mint = key(ix.accts[1])
			}
		}
	}
	return mint
}
