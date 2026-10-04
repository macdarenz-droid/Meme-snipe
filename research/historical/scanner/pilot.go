package main

// The Helius pilot (DATA-2): before any spend, measure what the full pull would get
// and cost on the free plan.
//
//  1. History depth: getFirstAvailableBlock, and the first slots of epoch 1004
//     (19 Jul 2026, the window's start) read as a unit.
//  2. The newest end: the last slots of epoch 1047 read as a unit.
//  3. Parity: the comparison unit (an archive unit whose digest is committed, see
//     digest.go) read over RPC, digested and compared table by table.
//  4. Usage: credits, requests, 429s, response sizes, latency and the achieved rate,
//     projected onto the window (2026-07-19 to 2026-10-03).
//
// It writes only its report; the units it reads stay on the runner.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

type pilotProbe struct {
	Name         string `json:"name"`
	Epoch        uint64 `json:"epoch"`
	FromSlot     uint64 `json:"from_slot"`
	ToSlot       uint64 `json:"to_slot"`
	OK           bool   `json:"ok"`
	Error        string `json:"error,omitempty"`
	Blocks       int    `json:"blocks"`
	SkippedSlots int64  `json:"skipped_slots"`
	FirstTime    string `json:"first_block_time,omitempty"`
	LastTime     string `json:"last_block_time,omitempty"`
	firstSlot    uint64
	lastSlot     uint64
	firstUnix    int64
	lastUnix     int64
	PumpTxs      int64   `json:"pump_txs"`
	CurveTrades  int64   `json:"curve_trades"`
	AmmTrades    int64   `json:"amm_trades"`
	DecodeFails  int64   `json:"decode_failures"`
	MissingMeta  int64   `json:"missing_meta"`
	LegacyMeta   int64   `json:"legacy_meta"`
	Seconds      float64 `json:"seconds"`
	BlocksPerSec float64 `json:"blocks_per_second"`
}

type pilotProjection struct {
	WindowFrom          string  `json:"window_from"`
	WindowToExclusive   string  `json:"window_to_exclusive"`
	SecondsPerSlot      float64 `json:"seconds_per_slot"`
	SlotsEstimate       int64   `json:"slots_estimate"`
	ProducedRatio       float64 `json:"produced_ratio"`
	BlocksEstimate      int64   `json:"blocks_estimate"`
	CreditsEstimate     int64   `json:"credits_estimate"` // one getBlock per block plus one getBlocks per unit
	BytesEstimate       int64   `json:"response_bytes_estimate"`
	MeanBlockBytes      float64 `json:"mean_block_bytes"`
	HoursAtMeasuredRate float64 `json:"hours_at_measured_rate"`
	HoursAt50RPS        float64 `json:"hours_at_50_rps"` // Developer plan limit, if latency allows (see conc)
	Note                string  `json:"note"`
}

type pilotReport struct {
	StartedAt           string            `json:"started_at"`
	FinishedAt          string            `json:"finished_at"`
	ScannerRevision     string            `json:"scanner_revision"`
	FirstAvailableBlock *uint64           `json:"first_available_block,omitempty"`
	FirstAvailableError string            `json:"first_available_error,omitempty"`
	Probes              []*pilotProbe     `json:"probes"`
	Comparison          *digestComparison `json:"comparison,omitempty"`
	ComparisonError     string            `json:"comparison_error,omitempty"`
	Usage               heliusUsage       `json:"usage"`
	Projection          *pilotProjection  `json:"projection,omitempty"`
	Verdict             string            `json:"verdict"`
}

type pilotUnit struct {
	name     string
	epoch    uint64
	from, to uint64
	compare  bool
}

// runPilot runs the probes and the comparison against baselinePath and writes the
// report to reportPath. It returns an error only when the report itself cannot be
// written; the verdict carries the result.
func runPilot(ctx context.Context, h *heliusClient, conc, workers int, units []pilotUnit, baselinePath, work, reportPath string) (*pilotReport, error) {
	rep := &pilotReport{StartedAt: time.Now().UTC().Format(time.RFC3339), ScannerRevision: scannerRevision}
	if res, err := h.call(ctx, "getFirstAvailableBlock", []any{}); err != nil {
		rep.FirstAvailableError = h.scrub(err.Error())
	} else {
		var s uint64
		if json.Unmarshal(res, &s) == nil {
			rep.FirstAvailableBlock = &s
		}
	}
	var base *unitDigest
	var baseErr error
	if baselinePath != "" {
		base, baseErr = readDigest(baselinePath)
	}
	var blocksRead int
	var compareSecs float64
	var compareBlocks int
	for _, u := range units {
		p := &pilotProbe{Name: u.name, Epoch: u.epoch, FromSlot: u.from, ToSlot: u.to}
		rep.Probes = append(rep.Probes, p)
		dir := unitSpec{u.epoch, u.from, u.to}.dir(work)
		st, err := RPCUnit(ctx, h, u.epoch, u.from, u.to, dir, conc, workers)
		if err != nil {
			p.Error = h.scrub(err.Error())
			if errors.Is(err, errCreditCap) || ctx.Err() != nil {
				break
			}
			continue
		}
		p.OK = true
		p.Blocks, p.SkippedSlots, p.Seconds = st.Blocks, st.SkippedSlots, st.Seconds
		p.PumpTxs, p.CurveTrades, p.AmmTrades = st.PumpTxs, st.CurveTrades, st.AmmTrades
		p.DecodeFails, p.MissingMeta, p.LegacyMeta = st.DecodeFailures, st.MissingMeta, st.LegacyMeta
		if st.Blocks > 0 {
			p.firstSlot, p.lastSlot, p.firstUnix, p.lastUnix = st.FirstBlockSlot, st.LastBlockSlot, st.FirstBlockTime, st.LastBlockTime
			p.FirstTime = time.Unix(st.FirstBlockTime, 0).UTC().Format(time.RFC3339)
			p.LastTime = time.Unix(st.LastBlockTime, 0).UTC().Format(time.RFC3339)
		}
		if st.Seconds > 0 {
			p.BlocksPerSec = float64(st.Blocks) / st.Seconds
		}
		blocksRead += st.Blocks
		if u.compare {
			compareSecs, compareBlocks = st.Seconds, st.Blocks
			switch {
			case baseErr != nil:
				rep.ComparisonError = "baseline: " + baseErr.Error()
			case base == nil:
				rep.ComparisonError = "no baseline given"
			case base.Epoch != u.epoch || base.FromSlot != u.from || base.ToSlot != u.to:
				rep.ComparisonError = fmt.Sprintf("baseline is unit %d %d-%d, not %d %d-%d", base.Epoch, base.FromSlot, base.ToSlot, u.epoch, u.from, u.to)
			default:
				cand, err := digestUnit(dir)
				if err != nil {
					rep.ComparisonError = "candidate digest: " + err.Error()
				} else {
					rep.Comparison = compareDigests(base, cand)
				}
			}
		}
		os.RemoveAll(dir) // units read over RPC stay on the runner, and not even there
	}
	rep.Usage = h.usage()
	// Projection over the window, from the comparison unit (a full, busy unit).
	if compareBlocks > 0 && compareSecs > 0 {
		var cmp *pilotProbe
		for _, p := range rep.Probes {
			if p.OK && p.Blocks == compareBlocks {
				cmp = p
			}
		}
		t0, _ := time.Parse("2006-01-02", "2026-07-19")
		t1, _ := time.Parse("2006-01-02", "2026-10-03")
		// Seconds per slot from the two edge probes' block times when both read
		// (they span the whole window); else planUnits' October rate, which overstates
		// the slots of slower months.
		note := "measured on the free plan's rate; mean block bytes are over every request, getBlocks included"
		secPerSlot := 38799.0 / 145252.0
		var a, z *pilotProbe
		for _, p := range rep.Probes {
			if p.OK && p.Blocks > 0 && p.Epoch == 1004 {
				a = p
			}
			if p.OK && p.Blocks > 0 && p.Epoch == 1047 {
				z = p
			}
		}
		if a != nil && z != nil && z.lastSlot > a.firstSlot {
			secPerSlot = float64(z.lastUnix-a.firstUnix) / float64(z.lastSlot-a.firstSlot)
		} else {
			note += "; edge probes missing: slots estimated at October's 0.267 s a slot (an overestimate)"
		}
		slots := int64(float64(t1.Unix()-t0.Unix()) / secPerSlot)
		ratio := float64(cmp.Blocks) / float64(cmp.ToSlot-cmp.FromSlot+1)
		blocks := int64(float64(slots) * ratio)
		meanBytes := 0.0
		if rep.Usage.Requests > 0 {
			meanBytes = float64(rep.Usage.ResponseBytes) / float64(rep.Usage.Requests)
		}
		rate := float64(compareBlocks) / compareSecs
		pr := &pilotProjection{WindowFrom: "2026-07-19", WindowToExclusive: "2026-10-03", SlotsEstimate: slots,
			ProducedRatio: ratio, BlocksEstimate: blocks, CreditsEstimate: blocks + slots/unitSlots + 1,
			MeanBlockBytes: meanBytes, BytesEstimate: int64(meanBytes * float64(blocks)),
			HoursAtMeasuredRate: float64(blocks) / rate / 3600,
			SecondsPerSlot:      secPerSlot, Note: note}
		// At 50 requests/s the limit is the plan, if enough fetchers hide the latency.
		lat := rep.Usage.MeanLatencyMs / 1000
		perFetcher := 1.0
		if lat > 0 {
			perFetcher = 1 / lat
		}
		pr.HoursAt50RPS = float64(blocks) / math.Min(50, perFetcher*64) / 3600
		rep.Projection = pr
	}
	switch {
	case rep.Comparison != nil && rep.Comparison.Equal:
		rep.Verdict = "parity: every compared table equal or explained"
	case rep.Comparison != nil:
		rep.Verdict = fmt.Sprintf("NO PARITY: %d unexplained differences", rep.Comparison.Unexplained)
	default:
		rep.Verdict = "NO PARITY: comparison not run (" + rep.ComparisonError + ")"
	}
	for _, p := range rep.Probes {
		if !p.OK {
			rep.Verdict += "; probe " + p.Name + " failed"
		}
	}
	rep.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.MarshalIndent(rep, "", "  ")
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err != nil {
		return rep, err
	}
	return rep, os.WriteFile(reportPath, b, 0o644)
}

// defaultPilotUnits: edge probes of n slots at both ends of the window, and the
// comparison unit (the archive unit whose digest is committed).
func defaultPilotUnits(n uint64, cmpEpoch, cmpFrom, cmpTo uint64) []pilotUnit {
	e1004 := epochFirstSlot(1004)
	e1047end := epochLastSlot(1047)
	return []pilotUnit{
		{name: "epoch 1004 first slots", epoch: 1004, from: e1004, to: e1004 + n - 1},
		{name: "epoch 1047 last slots", epoch: 1047, from: e1047end - n + 1, to: e1047end},
		{name: "comparison unit", epoch: cmpEpoch, from: cmpFrom, to: cmpTo, compare: true},
	}
}
