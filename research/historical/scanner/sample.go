package main

// Sampling rule and per-token hourly census. See docs/research/historical-data.md.

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"sort"
	"strconv"

	"github.com/mr-tron/base58"
)

// sampleRate is the share of mints whose full trade tape the scanner keeps. A mint is
// in the sample when the first 8 bytes of sha256(mint pubkey bytes), read as a
// big-endian uint64, are below sampleRate * 2^64. The rule depends only on the mint
// address, which is fixed at creation, so it is independent of every outcome.
// Narrower universes (for example 5% of launches) are nested inside it: they use a
// lower threshold on the same number.
var sampleRate = 0.25 // -sample on run/unit; recorded in each unit's stats

// mintHashFraction returns the mint's position in [0, 1).
func mintHashFraction(mint string) (float64, bool) {
	b, err := base58.Decode(mint)
	if err != nil || len(b) != 32 {
		return 0, false
	}
	h := sha256.Sum256(b)
	return float64(binary.BigEndian.Uint64(h[:8])) / math.Pow(2, 64), true
}

func inSample(mint string) bool {
	f, ok := mintHashFraction(mint)
	return ok && f < sampleRate
}

// Events that are per-user bookkeeping and never change a curve or pool: dropped.
var dropEvents = map[string]bool{
	"CloseUserVolumeAccumulatorEvent": true, "InitUserVolumeAccumulatorEvent": true, "SyncUserVolumeAccumulatorEvent": true,
	"ClaimCashbackEvent": true, "ClaimTokenIncentivesEvent": true, "CollectCreatorFeeEvent": true,
	"CollectCoinCreatorFeeEvent": true, "MinimumDistributableFeeEvent": true,
}

// Per-mint events that do not change reserves: kept only for sampled mints.
var sampledOnlyEvents = map[string]bool{
	"DistributeCreatorFeesEvent": true, "DistributeFeeToHoldersEvent": true, "MigrateBondingCurveCreatorEvent": true,
	"MigratePoolCoinCreatorEvent": true, "SetMetaplexCreatorEvent": true, "SetMetaplexCoinCreatorEvent": true,
	"SetCreatorEvent": true, "SetBondingCurveCoinCreatorEvent": true,
}

// keepEvent: universe events (creates, graduations, pool creation, liquidity changes,
// boosts, parameter changes) are kept for every mint.
func keepEvent(name string, fields map[string]string) bool {
	if dropEvents[name] {
		return false
	}
	if sampledOnlyEvents[name] {
		m := fields["mint"]
		if m == "" {
			m = fields["base_mint"]
		}
		return m != "" && inSample(m)
	}
	return true
}

// Hourly census of every mint's trading, for all mints (not only the sample).
type aggKey struct {
	hour  int64
	venue string // curve | amm
	mint  string
	pool  string
}

type aggVal struct {
	nBuy, nSell           int64
	quoteBuy, quoteSell   uint64
	baseBuy, baseSell     uint64
	firstSlot, lastSlot   uint64
	firstTx, lastTx       int64
	firstEv, lastEv       int64
	openBase, openQuote   string
	closeBase, closeQuote string
	closeVQuote           string
	highPx, lowPx         float64
	quoteMint             string
}

var aggCols = []string{"hour", "venue", "mint", "pool", "quote_mint", "n_buy", "n_sell", "quote_buy", "quote_sell", "base_buy", "base_sell",
	"first_slot", "last_slot", "open_base", "open_quote", "close_base", "close_quote", "close_virtual_quote", "high_px", "low_px"}

func atou(s string) uint64 { v, _ := strconv.ParseUint(s, 10, 64); return v }

// emitRow adds a finished trade row to the hourly census and keeps it if sampled.
//
// Curve rows: reserves are the post-trade virtual reserves from TradeEvent; price is
// virtual_sol_reserves / virtual_token_reserves (raw units).
// AMM rows: reserves are the pre-trade pool reserves from Buy/SellEvent; price is
// (pool_quote + virtual_quote_reserves) / pool_base.
func (r *blockResult) emitRow(kind string, row []string) {
	var k aggKey
	var isBuy bool
	var quote, base uint64
	var rb, rq, vq string
	var px float64
	var slot uint64
	var txIdx, evIdx int64
	slot = atou(row[0])
	txIdx, _ = strconv.ParseInt(row[2], 10, 64)
	evIdx, _ = strconv.ParseInt(row[3], 10, 64)
	hour := r.blockTime - r.blockTime%3600
	qm := ""
	if kind == "curve" {
		k = aggKey{hour, "curve", row[8], ""}
		isBuy = row[9] == "1"
		quote, base = atou(row[10]), atou(row[11])
		rq, rb = row[14], row[15]
		qm = row[32]
		if b := atou(rb); b > 0 {
			px = float64(atou(rq)) / float64(b)
		}
	} else {
		k = aggKey{hour, "amm", row[9], row[8]}
		isBuy = row[11] == "buy"
		base, quote = atou(row[12]), atou(row[13])
		rb, rq, vq = row[17], row[18], row[36]
		qm = row[10]
		if b := atou(rb); b > 0 {
			eff, _ := strconv.ParseFloat(rq, 64)
			v, _ := strconv.ParseFloat(vq, 64)
			px = (eff + v) / float64(b)
		}
	}
	a := r.agg[k]
	if a == nil {
		a = &aggVal{firstSlot: slot, firstTx: txIdx, firstEv: evIdx, openBase: rb, openQuote: rq, highPx: px, lowPx: px, quoteMint: qm}
		r.agg[k] = a
	}
	if isBuy {
		a.nBuy++
		a.quoteBuy += quote
		a.baseBuy += base
	} else {
		a.nSell++
		a.quoteSell += quote
		a.baseSell += base
	}
	a.lastSlot, a.lastTx, a.lastEv = slot, txIdx, evIdx
	a.closeBase, a.closeQuote, a.closeVQuote = rb, rq, vq
	if px > a.highPx {
		a.highPx = px
	}
	if px < a.lowPx || a.lowPx == 0 {
		a.lowPx = px
	}
	mint := k.mint
	if mint == "" || inSample(mint) {
		if kind == "curve" {
			r.curve = append(r.curve, row)
		} else {
			r.amm = append(r.amm, row)
		}
	}
}

// mergeAgg folds block aggregates (in block order) into the unit aggregate.
func mergeAgg(dst map[aggKey]*aggVal, src map[aggKey]*aggVal) {
	for k, v := range src {
		d := dst[k]
		if d == nil {
			c := *v
			dst[k] = &c
			continue
		}
		d.nBuy += v.nBuy
		d.nSell += v.nSell
		d.quoteBuy += v.quoteBuy
		d.quoteSell += v.quoteSell
		d.baseBuy += v.baseBuy
		d.baseSell += v.baseSell
		d.lastSlot, d.lastTx, d.lastEv = v.lastSlot, v.lastTx, v.lastEv
		d.closeBase, d.closeQuote, d.closeVQuote = v.closeBase, v.closeQuote, v.closeVQuote
		if v.highPx > d.highPx {
			d.highPx = v.highPx
		}
		if v.lowPx < d.lowPx {
			d.lowPx = v.lowPx
		}
	}
}

func aggRows(m map[aggKey]*aggVal) [][]string {
	keys := make([]aggKey, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.hour != b.hour {
			return a.hour < b.hour
		}
		if a.venue != b.venue {
			return a.venue < b.venue
		}
		if a.mint != b.mint {
			return a.mint < b.mint
		}
		return a.pool < b.pool
	})
	out := make([][]string, 0, len(keys))
	u := func(x uint64) string { return strconv.FormatUint(x, 10) }
	for _, k := range keys {
		v := m[k]
		out = append(out, []string{strconv.FormatInt(k.hour, 10), k.venue, k.mint, k.pool, v.quoteMint,
			strconv.FormatInt(v.nBuy, 10), strconv.FormatInt(v.nSell, 10), u(v.quoteBuy), u(v.quoteSell), u(v.baseBuy), u(v.baseSell),
			u(v.firstSlot), u(v.lastSlot), v.openBase, v.openQuote, v.closeBase, v.closeQuote, v.closeVQuote,
			strconv.FormatFloat(v.highPx, 'g', 10, 64), strconv.FormatFloat(v.lowPx, 'g', 10, 64)})
	}
	return out
}
