package main

// Canonical PumpSwap pools: the pools the pump program's migrate instruction creates
// for completed bonding curves (pump-public-docs, PUMP_SWAP_CREATOR_FEE_README). A
// pool is canonical when it is the pump_amm PDA of
//   ["pool", u16 index 0 (LE), creator, base_mint, quote_mint]
// with creator = the pump PDA ["pool-authority", base_mint]. It is decided from the
// trade alone, so retention never depends on any other day or on the future.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	bin "github.com/gagliardetto/binary"
	"github.com/gagliardetto/solana-go"
)

// retentionPolicy: units keep every curve trade, every trade in a canonical pool, and
// other pools' trades, failed rows and raw records of hash-sampled mints only.
const retentionPolicy = "curve-all,canonical-all,sample"

var canonicalCache sync.Map // pool|base|quote -> bool

func isCanonicalPool(pool, base, quote string) bool {
	if pool == "" || base == "" || quote == "" {
		return false
	}
	key := pool + "|" + base + "|" + quote
	if v, ok := canonicalCache.Load(key); ok {
		return v.(bool)
	}
	ok := canonicalPool(base, quote) == pool
	canonicalCache.Store(key, ok)
	return ok
}

// canonicalPool returns the canonical pool address for a base and quote mint ("" if
// either is not a public key).
func canonicalPool(base, quote string) string {
	b, err := solana.PublicKeyFromBase58(base)
	if err != nil {
		return ""
	}
	q, err := solana.PublicKeyFromBase58(quote)
	if err != nil {
		return ""
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("pool-authority"), b[:]}, solana.PublicKeyFromBytes(pumpProgram[:]))
	if err != nil {
		return ""
	}
	pool, _, err := solana.FindProgramAddress([][]byte{[]byte("pool"), {0, 0}, authority[:], b[:], q[:]}, solana.PublicKeyFromBytes(ammProgram[:]))
	if err != nil {
		return ""
	}
	return pool.String()
}

// ---- OF-3 ----

// OF-3 (research/z-h-estimate/OLD-FAITHFUL.md §3, §5): the archive batches' retention
// values and the config-change records (P12), all inside one frozen scanner revision.
//
// -retention "" (the default) keeps today's units exactly (retentionPolicy, no new
// files). -retention K2 or K3 records that literal as the unit's "retention" and adds:
//   raw_canonical.jsonl.zst  the raw record of every transaction with a PumpSwap trade
//                            instruction in a canonical pool (successful or failed) that
//                            raw.jsonl.zst does not already hold; its "mints" are the
//                            canonical pools' base mints. K2 keeps every one (P11). K3
//                            keeps one only when a base mint is on the pinned PM-01
//                            migration list and the block time is inside that mint's
//                            window; the same test the trim applies (k3Keep), so a
//                            trimmed K2 unit equals a K3 scan of it byte for byte.
//   config.jsonl.zst         the raw record of every transaction that writes a fee or
//                            venue config account (P12: the pump Global, the PumpSwap
//                            GlobalConfig, the pump_fees FeeConfig of each program).
//                            Trades only read them (IDLs: "writable" is false on every
//                            trade instruction); admin instructions write them.
// The migration list (-migration-list, K3 only) is a pinned input: lines
// "MINT FROM_UNIX UNTIL_UNIX" (block times, inclusive), sorted by mint, one line a
// mint. Its sha256 goes into the unit's stats (migration_list_sha256).

var (
	retentionMode string // "", "K2" or "K3"
	k3List        map[string]k3Window
	k3ListSha     string
	feeProgram    = mustPK("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ")
)

type k3Window struct{ from, until int64 }

// setRetention validates -retention and -migration-list before any request: K2 takes
// no list (it keeps every canonical pool), K3 needs one, anything else is refused.
func setRetention(mode, listPath string) error {
	switch mode {
	case "":
		if listPath != "" {
			return fmt.Errorf("-migration-list needs -retention K3")
		}
	case "K2":
		if listPath != "" {
			return fmt.Errorf("-retention K2 keeps every canonical pool and takes no -migration-list")
		}
	case "K3":
		if listPath == "" {
			return fmt.Errorf("-retention K3 needs the pinned -migration-list")
		}
		l, sum, err := loadMigrationList(listPath)
		if err != nil {
			return err
		}
		k3List, k3ListSha = l, sum
	default:
		return fmt.Errorf("-retention must be K2 or K3 (or empty), got %q", mode)
	}
	retentionMode = mode
	return nil
}

// loadMigrationList reads and checks a pinned migration list; it returns the windows
// and the sha256 of the file's bytes.
func loadMigrationList(path string) (map[string]k3Window, string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(b)
	out := map[string]k3Window{}
	prev := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	n := 0
	for sc.Scan() {
		n++
		f := strings.Split(sc.Text(), " ")
		if len(f) != 3 {
			return nil, "", fmt.Errorf("migration list line %d: want MINT FROM_UNIX UNTIL_UNIX", n)
		}
		if _, err := solana.PublicKeyFromBase58(f[0]); err != nil {
			return nil, "", fmt.Errorf("migration list line %d: bad mint %q", n, f[0])
		}
		from, err1 := strconv.ParseInt(f[1], 10, 64)
		until, err2 := strconv.ParseInt(f[2], 10, 64)
		if err1 != nil || err2 != nil || from <= 0 || until < from {
			return nil, "", fmt.Errorf("migration list line %d: bad window %q %q", n, f[1], f[2])
		}
		if f[0] <= prev {
			return nil, "", fmt.Errorf("migration list line %d: mints must be sorted and unique", n)
		}
		prev = f[0]
		out[f[0]] = k3Window{from, until}
	}
	if err := sc.Err(); err != nil {
		return nil, "", err
	}
	if len(out) == 0 {
		return nil, "", fmt.Errorf("migration list %s is empty", path)
	}
	return out, hex.EncodeToString(sum[:]), nil
}

// unitRetention is the value recorded in a unit's stats.
func unitRetention() string {
	if retentionMode == "" {
		return retentionPolicy
	}
	return retentionMode
}

// k3Keep: a canonical-pool record is kept under K3 when one of its base mints is on
// the pinned list and its block time is inside that mint's window. Decided from the
// record alone (its mints and block time), so the K3 scan and the trim agree.
func k3Keep(list map[string]k3Window, mints []string, blockTime int64) bool {
	for _, m := range mints {
		if w, ok := list[m]; ok && blockTime >= w.from && blockTime <= w.until {
			return true
		}
	}
	return false
}

// poolReserveIx (OF-3 ruling 16): the PumpSwap instructions that change a pool's reserves,
// by discriminator, read from the pinned IDL (idl/pump_amm.json): every instruction whose
// pool_base_token_account or pool_quote_token_account is writable (today buy, sell,
// buy_exact_quote_in, deposit, withdraw, boost_buy_and_burn, init_boost and create_pool).
// Each must take pool at 0, base_mint at 3 and quote_mint at 4, or the scanner does not start.
var poolReserveIx = func() map[[8]byte]string {
	var idl struct {
		Instructions []struct {
			Name          string `json:"name"`
			Discriminator []int  `json:"discriminator"`
			Accounts      []struct {
				Name     string `json:"name"`
				Writable bool   `json:"writable"`
			} `json:"accounts"`
		} `json:"instructions"`
	}
	if err := json.Unmarshal(ammIDL, &idl); err != nil {
		panic(err)
	}
	m := map[[8]byte]string{}
	for _, ix := range idl.Instructions {
		reserves := false
		for _, a := range ix.Accounts {
			if (a.Name == "pool_base_token_account" || a.Name == "pool_quote_token_account") && a.Writable {
				reserves = true
			}
		}
		if !reserves {
			continue
		}
		if len(ix.Discriminator) != 8 || len(ix.Accounts) < 5 || ix.Accounts[0].Name != "pool" || ix.Accounts[3].Name != "base_mint" || ix.Accounts[4].Name != "quote_mint" {
			panic("pump_amm " + ix.Name + ": a reserve-changing instruction without pool, base_mint, quote_mint at 0, 3, 4")
		}
		var d [8]byte
		for i, v := range ix.Discriminator {
			d[i] = byte(v)
		}
		m[d] = ix.Name
	}
	return m
}()

// canonicalTxMints: the base mints of every PumpSwap instruction that changes a canonical
// pool's reserves (poolReserveIx; top level or inner), sorted.
func canonicalTxMints(groups [][]ixRef, key func(int) [32]byte) []string {
	set := map[string]bool{}
	for _, g := range groups {
		for _, ix := range g {
			if ix.program != ammProgram || len(ix.data) < 8 || len(ix.accts) < 5 {
				continue
			}
			var d [8]byte
			copy(d[:], ix.data[:8])
			if _, ok := poolReserveIx[d]; !ok {
				continue
			}
			pool := solana.PublicKey(key(ix.accts[0])).String()
			base := solana.PublicKey(key(ix.accts[3])).String()
			quote := solana.PublicKey(key(ix.accts[4])).String()
			if isCanonicalPool(pool, base, quote) {
				set[base] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for m := range set {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// configAccounts: the fee and venue config accounts (P12), by name.
var configAccounts = func() map[[32]byte]string {
	m := map[[32]byte]string{}
	pda := func(prog [32]byte, seeds ...[]byte) [32]byte {
		k, _, err := solana.FindProgramAddress(seeds, solana.PublicKeyFromBytes(prog[:]))
		if err != nil {
			panic(err)
		}
		return k
	}
	m[pda(pumpProgram, []byte("global"))] = "pump_global"
	m[pda(ammProgram, []byte("global_config"))] = "pump_amm_global_config"
	m[pda(feeProgram, []byte("fee_config"), pumpProgram[:])] = "pump_fee_config"
	m[pda(feeProgram, []byte("fee_config"), ammProgram[:])] = "pump_amm_fee_config"
	return m
}()

// configWrites names the config accounts a transaction writes: static keys by the
// message header's rules, plus the addresses it loads writable from lookup tables.
func configWrites(tx *solana.Transaction, loadedWritable [][]byte) []string {
	var out []string
	for _, k := range tx.Message.AccountKeys {
		if name, ok := configAccounts[k]; ok && tx.Message.IsWritableStatic(k) {
			out = append(out, name)
		}
	}
	for _, k := range loadedWritable {
		var kk [32]byte
		copy(kk[:], k)
		if name, ok := configAccounts[kk]; ok {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// mayWriteConfig is the cheap pre-filter for transactions that run no pump or PumpSwap
// instruction: a pump_fees admin transaction names the fee program.
func mayWriteConfig(txBytes []byte) bool {
	return retentionMode != "" && bytes.Contains(txBytes, feeProgram[:])
}

// addConfig writes the raw record of a transaction that writes a config account (K2
// and K3 only).
func (r *blockResult) addConfig(st *UnitStats, b *blockData, txIdx int, tx *solana.Transaction, txBytes, metaRaw []byte, loadedWritable [][]byte) {
	if retentionMode == "" || len(configWrites(tx, loadedWritable)) == 0 {
		return
	}
	full, err := fullMeta(metaRaw)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: config full meta: %v", b.slot, txIdx, err))
		return
	}
	r.config = append(r.config, buildRawRecord(b.slot, b.blockTime, txIdx, tx.Signatures[0].String(), txBytes, full, []string{}))
}

// configOnlyTx: a transaction with no pump or PumpSwap instruction that names the fee
// program (a pump_fees admin change).
func configOnlyTx(r *blockResult, st *UnitStats, b *blockData, txIdx int, txBytes, metaBuf []byte) {
	if len(metaBuf) == 0 {
		st.missingMeta(b.slot, txIdx)
		return
	}
	metaRaw, err := zstdDec.DecodeAll(metaBuf, nil)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d: meta zstd: %v", b.slot, err))
		return
	}
	configOnlyTxRaw(r, st, b, txIdx, txBytes, metaRaw)
}

func configOnlyTxRaw(r *blockResult, st *UnitStats, b *blockData, txIdx int, txBytes, metaRaw []byte) {
	var tx solana.Transaction
	if err := tx.UnmarshalWithDecoder(bin.NewBinDecoder(txBytes)); err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: tx: %v", b.slot, txIdx, err))
		return
	}
	meta, err := leanMeta(metaRaw)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: config meta: %v", b.slot, txIdx, err))
		return
	}
	r.addConfig(st, b, txIdx, &tx, txBytes, metaRaw, meta.LoadedWritableAddresses)
}

// addCanonical writes the raw record of a canonical-pool transaction that raw.jsonl.zst
// does not hold already (K2: every one; K3: k3Keep).
func (r *blockResult) addCanonical(st *UnitStats, b *blockData, txIdx int, sig string, txBytes, metaRaw []byte, groups [][]ixRef, key func(int) [32]byte, inRaw bool) {
	if retentionMode == "" || inRaw {
		return
	}
	mints := canonicalTxMints(groups, key)
	if len(mints) == 0 || (retentionMode == "K3" && !k3Keep(k3List, mints, b.blockTime)) {
		return
	}
	full, err := fullMeta(metaRaw)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: canonical full meta: %v", b.slot, txIdx, err))
		return
	}
	r.rawCanon = append(r.rawCanon, buildRawRecord(b.slot, b.blockTime, txIdx, sig, txBytes, full, mints))
}
