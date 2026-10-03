package main

import (
	"testing"

	"github.com/gagliardetto/solana-go"
	"google.golang.org/protobuf/encoding/protowire"
)

// swapFixture builds a transaction with one swap instruction (program prog, discriminator
// ixDisc, nAccts accounts, the user's token account at userPos) that emits one event
// (eventDisc + body) as a self-CPI, optionally preceded by other top-level instructions.
// pre and post map an account to its token-balance owner (absent = not in the balances).
type swapFixture struct {
	prog      [32]byte
	ixDisc    []byte
	nAccts    int
	userPos   int
	mintPos   int // the mint's account position (pump v1 2, v2 1, PumpSwap base 3)
	eventDisc []byte
	body      []byte
	before    []solana.Instruction
	signer    solana.PublicKey
	userAcct  solana.PublicKey
	mint      string
	pre, post map[solana.PublicKey]string
}

func (f swapFixture) run(t *testing.T) (*blockResult, *UnitStats) {
	t.Helper()
	progPK := solana.PublicKeyFromBytes(f.prog[:])
	accts := solana.AccountMetaSlice{}
	for i := 0; i < f.nAccts; i++ {
		switch i {
		case f.userPos:
			accts = append(accts, solana.Meta(f.userAcct).WRITE())
		case f.mintPos:
			accts = append(accts, solana.Meta(mustPKpub(f.mint)))
		default:
			accts = append(accts, solana.Meta(solana.NewWallet().PublicKey()).WRITE())
		}
	}
	ixs := append(append([]solana.Instruction{}, f.before...), solana.NewInstruction(progPK, accts, append(append([]byte{}, f.ixDisc...), make([]byte, 16)...)))
	tx, err := solana.NewTransaction(ixs, solana.Hash{}, solana.TransactionPayer(f.signer))
	if err != nil {
		t.Fatal(err)
	}
	tx.Signatures = []solana.Signature{{1}}
	txBytes, _ := tx.MarshalBinary()
	keys := tx.Message.AccountKeys
	idx := func(k solana.PublicKey) uint64 {
		for i, kk := range keys {
			if kk.Equals(k) {
				return uint64(i)
			}
		}
		t.Fatalf("fixture: key %s not in the transaction", k)
		return 0
	}
	var b []byte
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, 5000)
	var packed []byte
	for range keys {
		packed = protowire.AppendVarint(packed, 1000)
	}
	for _, fn := range []protowire.Number{3, 4} {
		b = protowire.AppendTag(b, fn, protowire.BytesType)
		b = protowire.AppendBytes(b, packed)
	}
	// inner instruction: the event self-CPI under the swap (the last top-level instruction)
	var ii []byte
	ii = protowire.AppendTag(ii, 1, protowire.VarintType)
	ii = protowire.AppendVarint(ii, idx(progPK))
	ii = protowire.AppendTag(ii, 2, protowire.BytesType)
	ii = protowire.AppendBytes(ii, []byte{byte(idx(progPK))})
	ii = protowire.AppendTag(ii, 3, protowire.BytesType)
	ii = protowire.AppendBytes(ii, append(append(append([]byte{}, eventIxTag...), f.eventDisc...), f.body...))
	ii = protowire.AppendTag(ii, 4, protowire.VarintType)
	ii = protowire.AppendVarint(ii, 2)
	var inner []byte
	inner = protowire.AppendTag(inner, 1, protowire.VarintType)
	inner = protowire.AppendVarint(inner, uint64(len(ixs)-1))
	inner = protowire.AppendTag(inner, 2, protowire.BytesType)
	inner = protowire.AppendBytes(inner, ii)
	b = protowire.AppendTag(b, 5, protowire.BytesType)
	b = protowire.AppendBytes(b, inner)
	for fn, m := range map[protowire.Number]map[solana.PublicKey]string{7: f.pre, 8: f.post} {
		for k, owner := range m {
			var tb []byte
			tb = protowire.AppendTag(tb, 1, protowire.VarintType)
			tb = protowire.AppendVarint(tb, idx(k))
			tb = protowire.AppendTag(tb, 2, protowire.BytesType)
			tb = protowire.AppendString(tb, f.mint)
			tb = protowire.AppendTag(tb, 4, protowire.BytesType)
			tb = protowire.AppendString(tb, owner)
			b = protowire.AppendTag(b, fn, protowire.BytesType)
			b = protowire.AppendBytes(b, tb)
		}
	}
	r := &blockResult{agg: map[aggKey]*aggVal{}}
	st := &UnitStats{EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}}
	var n int
	processTx(r, st, &blockData{slot: 7, blockTime: 9}, "7", "9", 0, txBytes, b, &n)
	if len(st.DecodeErrors) > 0 {
		t.Fatalf("decode errors: %v", st.DecodeErrors)
	}
	return r, st
}

var (
	tradeEventDisc = []byte{189, 219, 127, 211, 78, 230, 97, 238}
	ammBuyDisc     = []byte{103, 244, 82, 31, 44, 245, 119, 119}
	pumpBuyIx      = []byte{102, 6, 61, 18, 1, 218, 235, 234}
	pumpSellIx     = []byte{51, 230, 133, 164, 1, 127, 131, 173}
	pumpBuyV2Ix    = []byte{184, 23, 238, 97, 103, 197, 211, 61}
)

const attrMint = "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"

// tradeBody: TradeEvent mint, sol, token, is_buy, user.
func tradeBody(buy bool, user solana.PublicKey) []byte {
	return append(tradeEventPrefix(mustPK(attrMint), 1000, 5000, buy), user[:]...)
}

// rowOf returns the only emitted row of kind ("curve" or "amm") as a column map.
func rowOf(t *testing.T, r *blockResult, cols []string) map[string]string {
	t.Helper()
	rows := r.curve
	if len(cols) == len(ammCols) && len(cols) != len(curveCols) {
		rows = r.amm
	}
	if len(rows) != 1 {
		t.Fatalf("want one row, got %d", len(rows))
	}
	if len(rows[0]) != len(cols) {
		t.Fatalf("row has %d values for %d columns", len(rows[0]), len(cols))
	}
	m := map[string]string{}
	for i, c := range cols {
		m[c] = rows[0][i]
	}
	return m
}

func hasMark(r *blockResult, mint, reason string) bool {
	for _, m := range r.marks {
		if m.mint == mint && m.scope == "unresolved" && m.reason == reason {
			return true
		}
	}
	return false
}

func TestSwapBuyIntoAccountOwnedByAnotherWallet(t *testing.T) {
	signer, other, acct := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	f := swapFixture{prog: pumpProgram, ixDisc: pumpBuyIx, nAccts: 16, userPos: 5, mintPos: 2, eventDisc: tradeEventDisc, body: tradeBody(true, signer),
		signer: signer, userAcct: acct, mint: attrMint, post: map[solana.PublicKey]string{acct: other.String()}}
	r, _ := f.run(t)
	row := rowOf(t, r, curveCols)
	if row["user_token_account"] != acct.String() || row["user_token_owner"] != other.String() || row["user"] != signer.String() {
		t.Fatalf("buy credits the account's owner %s, got account %q owner %q user %q", other, row["user_token_account"], row["user_token_owner"], row["user"])
	}
	if hasMark(r, attrMint, "swap_owner_unknown") {
		t.Fatalf("a resolved owner must not mark the mint")
	}
}

func TestSwapSellFromDelegatedAccount(t *testing.T) {
	// The signer is the account's delegate; the tokens leave the owner's account, which
	// is closed by the sell (only in the pre-transaction balances).
	delegate, owner, acct := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	f := swapFixture{prog: pumpProgram, ixDisc: pumpSellIx, nAccts: 14, userPos: 5, mintPos: 2, eventDisc: tradeEventDisc, body: tradeBody(false, delegate),
		signer: delegate, userAcct: acct, mint: attrMint, pre: map[solana.PublicKey]string{acct: owner.String()}}
	r, _ := f.run(t)
	row := rowOf(t, r, curveCols)
	if row["user_token_account"] != acct.String() || row["user_token_owner"] != owner.String() {
		t.Fatalf("sell debits the owner %s, got account %q owner %q", owner, row["user_token_account"], row["user_token_owner"])
	}
}

func TestSwapV2UsesAssociatedBaseUserAtPosition14(t *testing.T) {
	signer, acct := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	f := swapFixture{prog: pumpProgram, ixDisc: pumpBuyV2Ix, nAccts: 20, userPos: 14, mintPos: 1, eventDisc: tradeEventDisc, body: tradeBody(true, signer),
		signer: signer, userAcct: acct, mint: attrMint, post: map[solana.PublicKey]string{acct: signer.String()}}
	r, _ := f.run(t)
	row := rowOf(t, r, curveCols)
	if row["user_token_account"] != acct.String() || row["user_token_owner"] != signer.String() {
		t.Fatalf("v2 account at 14 %s, got account %q owner %q", acct, row["user_token_account"], row["user_token_owner"])
	}
}

func TestSwapTempAccountOwnerFromInitializeAccount3(t *testing.T) {
	signer, owner, temp := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	tokenPK := solana.PublicKeyFromBytes(tokenProgram[:])
	init3 := solana.NewInstruction(tokenPK, solana.AccountMetaSlice{solana.Meta(temp).WRITE(), solana.Meta(mustPKpub(attrMint))}, append([]byte{18}, owner[:]...))
	// PumpSwap buy: the user's base account is position 5; the temp account is opened and
	// closed in the transaction, so it is absent from the token balances.
	f := swapFixture{prog: ammProgram, ixDisc: pumpBuyIx, nAccts: 9, userPos: 5, mintPos: 3, eventDisc: ammBuyDisc, body: le64(1),
		before: []solana.Instruction{init3}, signer: signer, userAcct: temp, mint: attrMint}
	r, _ := f.run(t)
	row := rowOf(t, r, ammCols)
	if row["user_token_account"] != temp.String() || row["user_token_owner"] != owner.String() {
		t.Fatalf("temp account owner %s from InitializeAccount3, got account %q owner %q", owner, row["user_token_account"], row["user_token_owner"])
	}
	if hasMark(r, row["base_mint"], "swap_owner_unknown") {
		t.Fatalf("a resolved temp owner must not mark the mint")
	}
}

func TestSwapUnknownOwnerMarksMint(t *testing.T) {
	signer, acct := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	f := swapFixture{prog: pumpProgram, ixDisc: pumpBuyIx, nAccts: 16, userPos: 5, mintPos: 2, eventDisc: tradeEventDisc, body: tradeBody(true, signer),
		signer: signer, userAcct: acct, mint: attrMint}
	r, _ := f.run(t)
	row := rowOf(t, r, curveCols)
	if row["user_token_account"] != acct.String() || row["user_token_owner"] != "" {
		t.Fatalf("unknown owner stays empty, got account %q owner %q", row["user_token_account"], row["user_token_owner"])
	}
	if !hasMark(r, attrMint, "swap_owner_unknown") {
		t.Fatalf("an unknown swap owner must mark (mint, unresolved, swap_owner_unknown): %v", r.marks)
	}
}

func mustPKpub(s string) solana.PublicKey { return solana.MustPublicKeyFromBase58(s) }
