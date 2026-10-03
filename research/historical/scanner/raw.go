package main

// Raw transaction records (schema 2) in the shape agreed with the chain decoders
// (DEC-1's TransactionRecord): the wire transaction plus the meta fields a decoder
// needs, so live and backtest decode with the same code. Written for every pump or
// PumpSwap transaction (successful or failed) that references a sampled mint.

import (
	"encoding/base64"
	"encoding/json"
	"sort"

	"github.com/mr-tron/base58"
)

// Jito tip accounts (bundle detection): lamports a transaction moves into them.
var jitoTipAccounts = func() map[[32]byte]bool {
	m := map[[32]byte]bool{}
	for _, a := range []string{
		"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
		"Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
		"DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
		"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
	} {
		m[mustPK(a)] = true
	}
	return m
}()

// jitoTip returns the lamports the transaction added to Jito tip accounts.
func jitoTip(keys [][32]byte, pre, post []uint64) uint64 {
	var tip uint64
	for i, k := range keys {
		if jitoTipAccounts[k] && i < len(pre) && i < len(post) && post[i] > pre[i] {
			tip += post[i] - pre[i]
		}
	}
	return tip
}

type rawTokenBalance struct {
	AccountIndex  uint32 `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner,omitempty"`
	ProgramID     string `json:"programId,omitempty"`
	UITokenAmount struct {
		Amount   string `json:"amount"`
		Decimals uint32 `json:"decimals"`
	} `json:"uiTokenAmount"`
}

type rawInner struct {
	ProgramIDIndex uint32  `json:"programIdIndex"`
	Accounts       []int   `json:"accounts"`
	Data           string  `json:"data"` // base64
	StackHeight    *uint32 `json:"stackHeight"`
}

type rawRecord struct {
	Slot        uint64   `json:"slot"`
	BlockTime   int64    `json:"blockTime"`
	TxIndex     int      `json:"txIndex"`
	Signature   string   `json:"signature"`
	Transaction string   `json:"transaction"` // base64 wire bytes (legacy, v0 or v1)
	Err         *rawErr  `json:"err"`
	Mints       []string `json:"mints"` // sampled mints the transaction references
	Meta        rawMeta  `json:"meta"`
}

// rawErr carries the stored TransactionError bytes (bincode, as the validator
// stores them); the RPC JSON form is derived from these.
type rawErr struct {
	Hex string `json:"hex"`
}

type rawMeta struct {
	Fee                  uint64   `json:"fee"`
	ComputeUnitsConsumed *uint64  `json:"computeUnitsConsumed"`
	PreBalances          []uint64 `json:"preBalances"`
	PostBalances         []uint64 `json:"postBalances"`
	LoadedAddresses      struct {
		Writable []string `json:"writable"`
		Readonly []string `json:"readonly"`
	} `json:"loadedAddresses"`
	InnerInstructions []struct {
		Index        uint32     `json:"index"`
		Instructions []rawInner `json:"instructions"`
	} `json:"innerInstructions"`
	LogMessages       []string          `json:"logMessages"`
	PreTokenBalances  []rawTokenBalance `json:"preTokenBalances"`
	PostTokenBalances []rawTokenBalance `json:"postTokenBalances"`
}

func rawBalances(in []*TokenBalance) []rawTokenBalance {
	out := make([]rawTokenBalance, 0, len(in))
	for _, tb := range in {
		r := rawTokenBalance{AccountIndex: tb.AccountIndex, Mint: tb.Mint, Owner: tb.Owner, ProgramID: tb.ProgramId}
		if tb.UiTokenAmount != nil {
			r.UITokenAmount.Amount = tb.UiTokenAmount.Amount
			r.UITokenAmount.Decimals = tb.UiTokenAmount.Decimals
		}
		out = append(out, r)
	}
	return out
}

func buildRawRecord(slot uint64, blockTime int64, txIdx int, sig string, txBytes []byte, m *TransactionStatusMeta, mints []string) string {
	r := rawRecord{Slot: slot, BlockTime: blockTime, TxIndex: txIdx, Signature: sig,
		Transaction: base64.StdEncoding.EncodeToString(txBytes), Mints: mints}
	if m.Err != nil && len(m.Err.Err) > 0 {
		r.Err = &rawErr{Hex: hexs(m.Err.Err)}
	}
	r.Meta.Fee = m.Fee
	r.Meta.ComputeUnitsConsumed = m.ComputeUnitsConsumed
	r.Meta.PreBalances = m.PreBalances
	r.Meta.PostBalances = m.PostBalances
	r.Meta.LoadedAddresses.Writable = make([]string, 0, len(m.LoadedWritableAddresses))
	for _, k := range m.LoadedWritableAddresses {
		r.Meta.LoadedAddresses.Writable = append(r.Meta.LoadedAddresses.Writable, base58.Encode(k))
	}
	r.Meta.LoadedAddresses.Readonly = make([]string, 0, len(m.LoadedReadonlyAddresses))
	for _, k := range m.LoadedReadonlyAddresses {
		r.Meta.LoadedAddresses.Readonly = append(r.Meta.LoadedAddresses.Readonly, base58.Encode(k))
	}
	for _, ii := range m.InnerInstructions {
		g := struct {
			Index        uint32     `json:"index"`
			Instructions []rawInner `json:"instructions"`
		}{Index: ii.Index}
		for _, ix := range ii.Instructions {
			acc := make([]int, len(ix.Accounts))
			for j, a := range ix.Accounts {
				acc[j] = int(a)
			}
			g.Instructions = append(g.Instructions, rawInner{ProgramIDIndex: ix.ProgramIdIndex, Accounts: acc,
				Data: base64.StdEncoding.EncodeToString(ix.Data), StackHeight: ix.StackHeight})
		}
		r.Meta.InnerInstructions = append(r.Meta.InnerInstructions, g)
	}
	r.Meta.LogMessages = m.LogMessages
	if r.Meta.LogMessages == nil {
		r.Meta.LogMessages = []string{}
	}
	r.Meta.PreTokenBalances = rawBalances(m.PreTokenBalances)
	r.Meta.PostTokenBalances = rawBalances(m.PostTokenBalances)
	b, _ := json.Marshal(r)
	return string(b)
}

// sampledMints lists the sampled mints a transaction touches: every mint that appears
// in its token balances (so plain transfers and burns of the mint count too) or in
// the extra list (event mints, failed-trade mint).
func sampledMints(m *TransactionStatusMeta, extra ...string) []string {
	set := map[string]bool{}
	add := func(x string) {
		if x != "" && x != wsolMint && !set[x] && inSample(x) {
			set[x] = true
		}
	}
	for _, tb := range m.PostTokenBalances {
		add(tb.Mint)
	}
	for _, tb := range m.PreTokenBalances {
		add(tb.Mint)
	}
	for _, x := range extra {
		add(x)
	}
	out := make([]string, 0, len(set))
	for x := range set {
		out = append(out, x)
	}
	sort.Strings(out)
	return out
}
