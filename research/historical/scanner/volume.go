package main

import (
	"sort"
	"strconv"
)

// Regime volume per hour (§6.4, DECISIONS "Regime volume from the chain"; DATA-1c):
// SOL-quoted volume only, in lamports, buys plus sells, quote side:
//   - pump curve trades quoted in SOL (quote_mint empty, the system program or WSOL);
//   - trades in canonical PumpSwap pools with a WSOL quote.
//
// Non-SOL-quoted volume is excluded, not converted. covered is 1 only when the whole
// hour lies inside the gap-free, parent-linked scanned coverage; an uncovered hour is
// unknown, never zero, and FACTS-1 then leaves its day out (dailyChainVolume).
var volumeHourCols = []string{"hour_start_ms", "lamports", "covered"}

const systemProgramID = "11111111111111111111111111111111"

func solQuoted(quoteMint string) bool {
	return quoteMint == "" || quoteMint == systemProgramID || quoteMint == wsolMint
}

// volumeHourRows returns the 24 rows of UTC day dayStart (unix s) from the merged hourly
// census of that day. covered(hourStart) says whether the hour is fully covered.
func volumeHourRows(dayStart int64, census map[aggKey]*aggVal, covered func(int64) bool) [][]string {
	sum := map[int64]uint64{}
	for k, v := range census {
		switch {
		case k.venue == "curve" && solQuoted(v.quoteMint):
		case k.venue == "amm" && v.quoteMint == wsolMint && isCanonicalPool(k.pool, k.mint, v.quoteMint):
		default:
			continue
		}
		sum[k.hour] += v.quoteBuy + v.quoteSell
	}
	hours := make([]int64, 0, 24)
	for h := dayStart; h < dayStart+86400; h += 3600 {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })
	rows := make([][]string, 0, 24)
	for _, h := range hours {
		c := "0"
		if covered(h) {
			c = "1"
		}
		rows = append(rows, []string{strconv.FormatInt(h*1000, 10), strconv.FormatUint(sum[h], 10), c})
	}
	return rows
}
