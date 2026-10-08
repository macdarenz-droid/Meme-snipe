package main

// Research extras from one getBlock result (research/SHARED_TAPE_PLAN.md, SCHEMA):
// the F (failed pump or PumpSwap transaction) and W (SOL transfer) rows, the S
// additions (owner token and signer SOL balances before and after) and the decoder
// counts. Everything here reads the same JSON the scanner's processBlock reads; the
// scanner's files are used unchanged.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/mr-tron/base58"
)

var (
	systemProgram    = mustPK("11111111111111111111111111111111")
	ataProgram       = mustPK("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
	buybackAuthority = "GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG" // research/buyback-probe/PREREG_DRAFT.md
)

const minTransferLamports = 50_000_000 // W: at least 0.05 SOL

var tapeFailedCols = []string{"slot", "block_time", "tx_idx", "signature", "signer", "venue", "pool_or_curve", "mint",
	"ix_name", "side", "amount_arg", "limit_arg", "err_ix", "err_code", "err_program", "err_source_path", "err_class",
	"err_line", "meta_err", "n_swap_legs", "top_program", "tx_fee", "cu", "jito_tip"}

var transferCols = []string{"slot", "block_time", "tx_idx", "outer_ix", "inner_ix", "from", "to", "lamports", "signer", "signature"}

// sAddCols are appended to the scanner's curve and AMM trade columns.
var sAddCols = []string{"owner_token_pre", "owner_token_post", "signer_sol_pre", "signer_sol_post", "canonical", "protocol"}

// Error classes (err_class). Per-program code tables: a code not listed for its
// program is "state" (a program's own refusal); Anchor's framework codes (below 6000)
// are "account or constraint".
const (
	clsSlippage     = "slippage"
	clsFunds        = "insufficient funds"
	clsLiquidity    = "liquidity"
	clsArithmetic   = "arithmetic"
	clsAccount      = "account or constraint"
	clsState        = "state"
	clsCompute      = "compute"
	clsCyclic       = "cyclic arbitrage"
	clsOther        = "other program"
	clsUnclassified = "unclassified"
)

// From the IDLs in idl/ (pump.json, pump_amm.json).
var pumpCodeClass = map[int]string{
	6002: clsSlippage, 6003: clsSlippage, 6042: clsSlippage, // TooMuchSolRequired, TooLittleSolReceived, BuySlippageBelowMinTokensOut
	6040: clsFunds, 6041: clsFunds, // BuyNotEnoughSolToCoverRent, BuyNotEnoughSolToCoverFees
	6005: clsLiquidity, 6021: clsLiquidity, 6023: clsLiquidity, // BondingCurveComplete, NotEnoughTokensToBuy, NotEnoughTokensToSell
	6024: clsArithmetic, 6025: clsArithmetic, 6026: clsArithmetic, // Overflow, Truncation, DivisionByZero
	6000: clsAccount, 6004: clsAccount, 6019: clsAccount, 6027: clsAccount, 6064: clsAccount, 6065: clsAccount,
	6072: clsAccount, 6073: clsAccount, 6074: clsAccount, 6076: clsAccount, // authority, mint, creator, account lists
}

var ammCodeClass = map[int]string{
	6004: clsSlippage, 6040: clsSlippage, // ExceededSlippage, BuySlippageBelowMinBaseAmountOut
	6039: clsFunds,                                             // BuyNotEnoughQuoteTokensToCoverFees
	6003: clsLiquidity, 6016: clsLiquidity, 6063: clsLiquidity, // TooLittlePoolTokenLiquidity, BuyMoreBaseAmountThanPoolReserves, InsufficientRealQuoteReserves
	6023: clsArithmetic, 6024: clsArithmetic, 6025: clsArithmetic, // Overflow, Truncation, DivisionByZero
	6005: clsAccount, 6008: clsAccount, 6009: clsAccount, 6010: clsAccount, 6013: clsAccount, 6014: clsAccount, 6015: clsAccount,
	6044: clsAccount, 6059: clsAccount, 6060: clsAccount, 6061: clsAccount, 6062: clsAccount, 6073: clsAccount,
}

type idlIx struct {
	name     string
	u64Args  bool // the first two arguments are u64 (amount and limit)
	accounts map[string]int
}

var pumpIx, ammIx = loadIx(pumpIDL), loadIx(ammIDL)

func loadIx(raw []byte) map[[8]byte]*idlIx {
	var d struct {
		Instructions []struct {
			Name          string `json:"name"`
			Discriminator []byte `json:"discriminator"`
			Args          []struct {
				Type json.RawMessage `json:"type"`
			} `json:"args"`
			Accounts []struct {
				Name string `json:"name"`
			} `json:"accounts"`
		} `json:"instructions"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		panic(err)
	}
	m := map[[8]byte]*idlIx{}
	for _, ix := range d.Instructions {
		var k [8]byte
		copy(k[:], ix.Discriminator)
		x := &idlIx{name: ix.Name, accounts: map[string]int{}}
		x.u64Args = len(ix.Args) >= 2 && string(ix.Args[0].Type) == `"u64"` && string(ix.Args[1].Type) == `"u64"`
		for i, a := range ix.Accounts {
			if _, dup := x.accounts[a.Name]; !dup {
				x.accounts[a.Name] = i
			}
		}
		m[k] = x
	}
	return m
}

func lookupIx(program [32]byte, data []byte) *idlIx {
	if len(data) < 8 {
		return nil
	}
	var k [8]byte
	copy(k[:], data[:8])
	switch program {
	case pumpProgram:
		return pumpIx[k]
	case ammProgram:
		return ammIx[k]
	}
	return nil
}

func isTradeIx(program [32]byte, data []byte) bool {
	if len(data) < 8 {
		return false
	}
	switch program {
	case pumpProgram:
		return isCurveTradeIx(data[:8]) || isCurveTradeV2Ix(data[:8])
	case ammProgram:
		return isAmmTradeIx(data[:8])
	}
	return false
}

// xIx is one instruction in execution order with its stack height (1: top level).
type xIx struct {
	program [32]byte
	accts   []int
	data    []byte
	height  int
	outer   int
	inner   int // -1 for the top-level instruction
}

type blockExtras struct {
	failed    [][]string
	transfers [][]string
	sAdd      map[int]*txBalances // by tx index
	counts    decodeCounts
}

type txBalances struct {
	pre, post  map[string]uint64 // owner|mint -> raw amount (summed over the owner's accounts)
	overflow   bool
	signerPre  string
	signerPost string
	signer     string
}

type decodeCounts struct {
	Txs           int64            `json:"txs"`
	VoteTxs       int64            `json:"vote_txs"`
	Failed        int64            `json:"failed"`
	PumpTxs       int64            `json:"pump_txs"` // a pump or PumpSwap instruction, top level or inner
	PumpFailed    int64            `json:"pump_failed"`
	Truncated     int64            `json:"truncated_logs"` // any transaction whose log says "Log truncated"
	PumpTruncated int64            `json:"pump_truncated_logs"`
	Classes       map[string]int64 `json:"err_class"`
	Transfers     int64            `json:"w_rows"`
	DecodeErrors  int64            `json:"decode_errors"`
	FirstErrors   []string         `json:"first_errors,omitempty"`
}

func (c *decodeCounts) add(o decodeCounts) {
	c.Txs += o.Txs
	c.VoteTxs += o.VoteTxs
	c.Failed += o.Failed
	c.PumpTxs += o.PumpTxs
	c.PumpFailed += o.PumpFailed
	c.Truncated += o.Truncated
	c.PumpTruncated += o.PumpTruncated
	c.Transfers += o.Transfers
	c.DecodeErrors += o.DecodeErrors
	if c.Classes == nil {
		c.Classes = map[string]int64{}
	}
	for k, v := range o.Classes {
		c.Classes[k] += v
	}
	for _, e := range o.FirstErrors {
		if len(c.FirstErrors) < 20 {
			c.FirstErrors = append(c.FirstErrors, e)
		}
	}
}

func (c *decodeCounts) fail(msg string) {
	c.DecodeErrors++
	if len(c.FirstErrors) < 20 {
		c.FirstErrors = append(c.FirstErrors, msg)
	}
}

var (
	reFailed = regexp.MustCompile(`^Program (\S+) failed: (.*)$`)
	reInvoke = regexp.MustCompile(`^Program (\S+) invoke \[(\d+)\]$`)
	reDone   = regexp.MustCompile(`^Program (\S+) (success|failed)`)
	reCustom = regexp.MustCompile(`custom program error: 0x([0-9a-fA-F]+)`)
)

func blockExtrasOf(slot uint64, result []byte) (*blockExtras, error) {
	var bj rpcBlockJSON
	if err := json.Unmarshal(result, &bj); err != nil {
		return nil, fmt.Errorf("slot %d: block json: %w", slot, err)
	}
	if bj.BlockTime == nil {
		return nil, fmt.Errorf("slot %d: block has no blockTime", slot)
	}
	ex := &blockExtras{sAdd: map[int]*txBalances{}, counts: decodeCounts{Classes: map[string]int64{}}}
	bt := strconv.FormatInt(*bj.BlockTime, 10)
	sl := strconv.FormatUint(slot, 10)
	for i, t := range bj.Transactions {
		ex.counts.Txs++
		raw, err := rpcTxBytes(t.Transaction)
		if err != nil {
			ex.counts.fail(fmt.Sprintf("slot %d tx %d: %v", slot, i, err))
			continue
		}
		if bytes.Contains(raw, voteProgram[:]) && isVoteTx(raw) {
			ex.counts.VoteTxs++
			continue
		}
		var tx solana.Transaction
		if err := tx.UnmarshalWithDecoder(bin.NewBinDecoder(raw)); err != nil {
			ex.counts.fail(fmt.Sprintf("slot %d tx %d: tx: %v", slot, i, err))
			continue
		}
		m := t.Meta
		if m == nil {
			ex.counts.fail(fmt.Sprintf("slot %d tx %d: no meta", slot, i))
			continue
		}
		failed := len(m.Err) > 0 && string(m.Err) != "null"
		if failed {
			ex.counts.Failed++
		}
		keys := make([][32]byte, 0, len(tx.Message.AccountKeys)+8)
		for _, k := range tx.Message.AccountKeys {
			keys = append(keys, k)
		}
		if m.LoadedAddresses != nil {
			for _, list := range [][]string{m.LoadedAddresses.Writable, m.LoadedAddresses.Readonly} {
				for _, s := range list {
					b, err := base58.Decode(s)
					var k [32]byte
					if err != nil || len(b) != 32 {
						ex.counts.fail(fmt.Sprintf("slot %d tx %d: loaded address", slot, i))
					}
					copy(k[:], b)
					keys = append(keys, k)
				}
			}
		}
		key := func(j int) [32]byte {
			if j >= 0 && j < len(keys) {
				return keys[j]
			}
			return [32]byte{}
		}
		ixs, err := flatIxs(&tx, m)
		if err != nil {
			ex.counts.fail(fmt.Sprintf("slot %d tx %d: %v", slot, i, err))
			continue
		}
		// pump: a pump or PumpSwap instruction ran. Inner instructions are recorded only
		// when they ran; a top-level instruction ran unless an earlier one failed (or the
		// transaction failed before any instruction).
		errIx := txErrIx(m.Err)
		pump := false
		legs := 0
		for k := range ixs {
			ixs[k].program = key(int(binary.LittleEndian.Uint32(ixs[k].program[:4])))
			if ixs[k].program == pumpProgram || ixs[k].program == ammProgram {
				if isTradeIx(ixs[k].program, ixs[k].data) {
					legs++
				}
				if !failed || ixs[k].inner >= 0 || ixs[k].outer <= errIx {
					pump = true
				}
			}
		}
		truncated := false
		if m.LogMessages != nil {
			for _, l := range *m.LogMessages {
				if l == "Log truncated" {
					truncated = true
					break
				}
			}
		}
		if truncated {
			ex.counts.Truncated++
		}
		var sig, signer string
		if len(tx.Signatures) > 0 {
			sig = tx.Signatures[0].String()
		}
		signer = solana.PublicKey(key(0)).String()
		if pump {
			ex.counts.PumpTxs++
			if truncated {
				ex.counts.PumpTruncated++
			}
			if failed {
				ex.counts.PumpFailed++
				row, cls := failedRow(sl, bt, i, sig, signer, &tx, m, ixs, key, keys, legs, truncated)
				ex.counts.Classes[cls]++
				ex.failed = append(ex.failed, row)
			} else {
				ex.sAdd[i] = balancesOf(m, signer)
			}
		}
		if !failed {
			for _, row := range transferRows(sl, bt, i, sig, signer, ixs, key) {
				ex.transfers = append(ex.transfers, row)
				ex.counts.Transfers++
			}
		}
	}
	return ex, nil
}

// flatIxs lists a transaction's instructions in execution order: each top-level
// instruction, then its inner instructions. program holds the account index (little
// endian in the first 4 bytes) until the caller resolves it against the full key list.
func flatIxs(tx *solana.Transaction, m *rpcMetaJSON) ([]xIx, error) {
	inner := map[int][]xIx{}
	if m.InnerInstructions != nil {
		for _, g := range *m.InnerInstructions {
			for j, ii := range g.Instructions {
				var d []byte
				var err error
				if ii.Data != "" { // base58 of no bytes is the empty string
					d, err = base58.Decode(ii.Data)
				}
				if err != nil {
					return nil, fmt.Errorf("inner instruction data: %w", err)
				}
				acc := make([]int, len(ii.Accounts))
				for a, v := range ii.Accounts {
					acc[a] = int(v)
				}
				h := 0
				if ii.StackHeight != nil {
					h = int(*ii.StackHeight)
				}
				x := xIx{accts: acc, data: d, height: h, outer: int(g.Index), inner: j}
				binary.LittleEndian.PutUint32(x.program[:4], ii.ProgramIDIndex)
				inner[int(g.Index)] = append(inner[int(g.Index)], x)
			}
		}
	}
	var out []xIx
	for i, ix := range tx.Message.Instructions {
		acc := make([]int, len(ix.Accounts))
		for a, v := range ix.Accounts {
			acc[a] = int(v)
		}
		x := xIx{accts: acc, data: ix.Data, height: 1, outer: i, inner: -1}
		binary.LittleEndian.PutUint32(x.program[:4], uint32(ix.ProgramIDIndex))
		out = append(out, x)
		out = append(out, inner[i]...)
	}
	return out, nil
}

// transferRows: system-program transfers of at least 0.05 SOL that no pump or
// PumpSwap instruction invoked (no such instruction on the call stack above them).
// An inner instruction without a stack height is taken as called by its top-level
// instruction.
func transferRows(sl, bt string, txIdx int, sig, signer string, ixs []xIx, key func(int) [32]byte) [][]string {
	var rows [][]string
	var stack [][32]byte
	for _, x := range ixs {
		h := x.height
		if h <= 0 {
			h = 2
		}
		if h-1 < len(stack) {
			stack = stack[:h-1]
		}
		underPump := false
		for _, p := range stack {
			if p == pumpProgram || p == ammProgram {
				underPump = true
			}
		}
		stack = append(stack, x.program)
		if x.program != systemProgram || underPump || len(x.data) < 12 || len(x.accts) < 2 {
			continue
		}
		if binary.LittleEndian.Uint32(x.data[:4]) != 2 { // SystemInstruction::Transfer
			continue
		}
		lamports := binary.LittleEndian.Uint64(x.data[4:12])
		if lamports < minTransferLamports {
			continue
		}
		inner := ""
		if x.inner >= 0 {
			inner = strconv.Itoa(x.inner)
		}
		rows = append(rows, []string{sl, bt, strconv.Itoa(txIdx), strconv.Itoa(x.outer), inner,
			solana.PublicKey(key(x.accts[0])).String(), solana.PublicKey(key(x.accts[1])).String(),
			strconv.FormatUint(lamports, 10), signer, sig})
	}
	return rows
}

func balancesOf(m *rpcMetaJSON, signer string) *txBalances {
	b := &txBalances{pre: map[string]uint64{}, post: map[string]uint64{}, signer: signer}
	add := func(dst map[string]uint64, list []rpcTokenBalJSON) {
		for _, tb := range list {
			if tb.Owner == "" {
				continue
			}
			v, err := strconv.ParseUint(tb.UITokenAmount.Amount, 10, 64)
			if err != nil {
				b.overflow = true
				continue
			}
			k := tb.Owner + "|" + tb.Mint
			if dst[k]+v < dst[k] {
				b.overflow = true
			}
			dst[k] += v
		}
	}
	add(b.pre, m.PreTokenBalances)
	add(b.post, m.PostTokenBalances)
	if len(m.PreBalances) > 0 && len(m.PostBalances) > 0 {
		b.signerPre = strconv.FormatUint(m.PreBalances[0], 10)
		b.signerPost = strconv.FormatUint(m.PostBalances[0], 10)
	}
	return b
}

// sAdd returns the S additions for one trade row: the owner's balance of the mint
// before and after the transaction (raw units, summed over the owner's accounts; 0
// when the owner held no account of it), the signer's lamports before and after, and
// the flags.
func sAdd(b *txBalances, owner, mint, canonical, protocol string) []string {
	out := []string{"", "", "", "", canonical, protocol}
	if b == nil {
		return out
	}
	if owner != "" && mint != "" && !b.overflow {
		out[0] = strconv.FormatUint(b.pre[owner+"|"+mint], 10)
		out[1] = strconv.FormatUint(b.post[owner+"|"+mint], 10)
	}
	out[2], out[3] = b.signerPre, b.signerPost
	return out
}

func failedRow(sl, bt string, txIdx int, sig, signer string, tx *solana.Transaction, m *rpcMetaJSON, ixs []xIx,
	key func(int) [32]byte, keys [][32]byte, legs int, truncated bool) ([]string, string) {
	errIx := txErrIx(m.Err)
	// The innermost failure: the first "Program X failed: ..." line, with the invoke
	// stack at that point.
	errProgram, errLine, path := "", "", ""
	if m.LogMessages != nil && !truncated {
		var stack []string
		for _, l := range *m.LogMessages {
			if mm := reInvoke.FindStringSubmatch(l); mm != nil {
				d, _ := strconv.Atoi(mm[2])
				if d-1 < len(stack) {
					stack = stack[:d-1]
				}
				stack = append(stack, mm[1])
				continue
			}
			if mm := reFailed.FindStringSubmatch(l); mm != nil {
				errProgram, errLine = mm[1], mm[2]
				path = strings.Join(stack, ">")
				break
			}
			if mm := reDone.FindStringSubmatch(l); mm != nil && len(stack) > 0 && stack[len(stack)-1] == mm[1] {
				stack = stack[:len(stack)-1]
			}
		}
	}
	code := ""
	if mm := reCustom.FindStringSubmatch(errLine); mm != nil {
		if v, err := strconv.ParseUint(mm[1], 16, 32); err == nil {
			code = strconv.FormatUint(v, 10)
		}
	}
	cls := classify(errProgram, errLine, code, legs)

	// The failing pump or PumpSwap instruction: the last one in the failing top-level
	// instruction's group, else the transaction's first.
	var pick *xIx
	for k := range ixs {
		x := &ixs[k]
		if x.program != pumpProgram && x.program != ammProgram {
			continue
		}
		if errIx >= 0 && x.outer == errIx {
			pick = x
		} else if pick == nil && errIx < 0 {
			pick = x
		}
	}
	if pick == nil {
		for k := range ixs {
			if ixs[k].program == pumpProgram || ixs[k].program == ammProgram {
				pick = &ixs[k]
				break
			}
		}
	}
	venue, pool, mint, name, side, amount, limit := "", "", "", "", "", "", ""
	if pick != nil {
		venue = "pump"
		if pick.program == ammProgram {
			venue = "pumpswap"
		}
		acct := func(names ...string) string {
			ix := lookupIx(pick.program, pick.data)
			if ix == nil {
				return ""
			}
			for _, n := range names {
				if j, ok := ix.accounts[n]; ok && j < len(pick.accts) {
					return solana.PublicKey(key(pick.accts[j])).String()
				}
			}
			return ""
		}
		if ix := lookupIx(pick.program, pick.data); ix != nil {
			name = ix.name
			switch {
			case strings.HasPrefix(name, "buy"):
				side = "buy"
			case strings.HasPrefix(name, "sell"):
				side = "sell"
			}
			if ix.u64Args && len(pick.data) >= 24 {
				amount = strconv.FormatUint(binary.LittleEndian.Uint64(pick.data[8:16]), 10)
				limit = strconv.FormatUint(binary.LittleEndian.Uint64(pick.data[16:24]), 10)
			}
		}
		mint = acct("mint", "base_mint")
		if venue == "pump" {
			pool = acct("bonding_curve")
			if pool == "" && mint != "" {
				pool = bondingCurvePDA(mint)
			}
		} else {
			pool = acct("pool")
		}
	}
	top := ""
	if errIx >= 0 && errIx < len(tx.Message.Instructions) {
		top = solana.PublicKey(key(int(tx.Message.Instructions[errIx].ProgramIDIndex))).String()
	}
	cu := ""
	if m.ComputeUnitsConsumed != nil {
		cu = strconv.FormatUint(*m.ComputeUnitsConsumed, 10)
	}
	tip := strconv.FormatUint(jitoTip(keys, m.PreBalances, m.PostBalances), 10)
	errIxS := ""
	if errIx >= 0 {
		errIxS = strconv.Itoa(errIx)
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, m.Err)
	return []string{sl, bt, strconv.Itoa(txIdx), sig, signer, venue, pool, mint, name, side, amount, limit,
		errIxS, code, errProgram, path, cls, errLine, compact.String(), strconv.Itoa(legs), top,
		strconv.FormatUint(m.Fee, 10), cu, tip}, cls
}

// txErrIx is the failing instruction's index from {"InstructionError":[index, detail]},
// or -1 for a transaction-level error (no instruction ran) or none.
func txErrIx(raw json.RawMessage) int {
	errIx := -1
	var ie []json.RawMessage
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		if v, ok := obj["InstructionError"]; ok && json.Unmarshal(v, &ie) == nil && len(ie) == 2 {
			if json.Unmarshal(ie[0], &errIx) != nil {
				errIx = -1
			}
		}
	}
	return errIx
}

// classify gives the failure's class from the innermost failing program and its log line.
func classify(program, line, code string, legs int) string {
	if program == "" {
		return clsUnclassified // log truncated, missing, or without a failure line
	}
	low := strings.ToLower(line)
	if strings.Contains(low, "exceeded cus meter") || strings.Contains(low, "computational budget exceeded") {
		return clsCompute
	}
	pk, err := solana.PublicKeyFromBase58(program)
	if err != nil {
		return clsOther
	}
	c := -1
	if code != "" {
		c, _ = strconv.Atoi(code)
	}
	switch [32]byte(pk) {
	case pumpProgram, ammProgram:
		if c < 0 {
			if strings.Contains(low, "insufficient") {
				return clsFunds
			}
			return clsAccount
		}
		if c < 6000 {
			return clsAccount // Anchor framework codes
		}
		table := pumpCodeClass
		if [32]byte(pk) == ammProgram {
			table = ammCodeClass
		}
		if cls, ok := table[c]; ok {
			return cls
		}
		return clsState
	case tokenProgram, token2022Program:
		if c == 1 || strings.Contains(low, "insufficient funds") {
			return clsFunds
		}
		return clsAccount
	case systemProgram:
		if c == 1 || strings.Contains(low, "insufficient lamports") || strings.Contains(low, "insufficient funds") {
			return clsFunds
		}
		return clsAccount
	case ataProgram, computeBudgetProgram:
		return clsAccount
	}
	if legs >= 2 {
		return clsCyclic // another program failed a transaction with two or more pump or PumpSwap legs
	}
	return clsOther
}
