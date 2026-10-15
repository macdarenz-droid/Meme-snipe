package main

// Planning: which epochs, and which units in them, hold the blocks of [t0, t1).
//
// OF-FIX: the old planner picked epochs from one October anchor at 0.267 s per slot
// with a two-epoch margin; extrapolated back to 2026-07-22 that is epoch 993 (it opened
// 991-996), while the cited B2 boundary puts the day in epoch 1005, so the first batch
// planned 0 units and still exited 0. Now the anchors only bound a bracket, measured
// first-block times decide (a bisect), and every way to plan nothing is an error.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"path/filepath"
	"strconv"
	"strings"
)

// slotAnchor is a slot with its block time, cited in the repo.
type slotAnchor struct {
	slot uint64
	time int64
	src  string
}

// The anchors only bound the search; measured block times decide. B2 and B4 are known
// to the minute (anchorSlackS covers that).
var slotAnchors = []slotAnchor{
	{434319990, 1784643780, "B2 2026-07-21T14:23Z, research/historical/regimes.json"},
	{446462760, 1789226640, "B4 2026-09-12T15:24Z (pump), research/historical/regimes.json"},
	{452500000, 1790914653, "slot 452,500,000 at 1,790,914,653, the anchor of the planner before OF-FIX"},
}

const (
	minSlotS     = 0.20 // bracket bounds on the mean slot time (OFX-1)
	maxSlotS     = 0.50
	anchorSlackS = 120
	maxProbes    = 10 // epochs probed per plan at most (OFX-1); above it the plan fails
)

// epochBracket returns the epochs that can hold [t0, t1) for any mean slot time in
// [minSlotS, maxSlotS] from the anchor nearest to t0.
func epochBracket(t0, t1 int64) (lo, hi uint64, a slotAnchor) {
	a = slotAnchors[0]
	for _, c := range slotAnchors[1:] {
		if absI64(t0-c.time) < absI64(t0-a.time) {
			a = c
		}
	}
	slotAt := func(dt int64, early bool) uint64 {
		// early: the smallest slot that can have block time a.time+dt; else the largest
		var ds float64
		if early {
			d := float64(dt - anchorSlackS)
			if d >= 0 {
				ds = d / maxSlotS
			} else {
				ds = d / minSlotS
			}
		} else {
			d := float64(dt + anchorSlackS)
			if d >= 0 {
				ds = d / minSlotS
			} else {
				ds = d / maxSlotS
			}
		}
		s := float64(a.slot) + ds
		if s < 0 {
			return 0
		}
		return uint64(math.Floor(s))
	}
	return slotAt(t0-a.time, true) / 432000, slotAt(t1-a.time, false) / 432000, a
}

// pickEpochs returns the first and last epoch holding blocks with time in [t0, t1):
// the last epoch whose first block is at or before t0, through the last epoch whose
// first block is before t1. firstTime(e) is epoch e's first block time; every error of
// it (an epoch not in the archive yet included) fails the plan. probes counts the
// distinct epochs asked.
func pickEpochs(t0, t1 int64, firstTime func(uint64) (int64, error)) (first, last uint64, probes int, err error) {
	if t1 <= t0 {
		return 0, 0, 0, fmt.Errorf("empty window [%d, %d)", t0, t1)
	}
	lo, hi, a := epochBracket(t0, t1)
	seen := map[uint64]int64{}
	ft := func(e uint64) (int64, error) {
		if v, ok := seen[e]; ok {
			return v, nil
		}
		if len(seen) >= maxProbes {
			return 0, fmt.Errorf("more than %d epochs probed for [%d, %d) (bracket %d-%d): refused", maxProbes, t0, t1, lo, hi)
		}
		v, err := firstTime(e)
		if err != nil {
			return 0, fmt.Errorf("epoch %d: %w", e, err)
		}
		seen[e] = v
		return v, nil
	}
	t, err := ft(lo)
	if err != nil {
		return 0, 0, len(seen), err
	}
	if t > t0 {
		return 0, 0, len(seen), fmt.Errorf("epoch %d, the start of the bracket from %s, begins at %d, after the window start %d: the window is outside the bracket", lo, a.src, t, t0)
	}
	// invariant: first block of lo at or before t0; hi+1 not yet known
	l, h := lo, hi+1
	for h-l > 1 {
		mid := l + (h-l)/2
		if t, err = ft(mid); err != nil {
			return 0, 0, len(seen), err
		}
		if t <= t0 {
			l = mid
		} else {
			h = mid
		}
	}
	first, last = l, l
	for {
		if t, err = ft(last + 1); err != nil {
			return 0, 0, len(seen), err
		}
		if t >= t1 {
			break
		}
		last++
		if last > hi {
			return 0, 0, len(seen), fmt.Errorf("epoch %d begins at %d, before the window end %d, past the bracket end %d from %s", last, t, t1, hi, a.src)
		}
	}
	return first, last, len(seen), nil
}

// planUnits lists the units covering blocks with block time in [t0, t1). It never
// returns an empty plan without an error (OFX-2).
func planUnits(out string, t0, t1 int64) ([]unitSpec, map[uint64]*Epoch, error) {
	ctx := context.Background()
	opened := map[uint64]*Epoch{}
	firsts := map[uint64]*blockRef{}
	firstTime := func(e uint64) (int64, error) {
		ep, err := OpenEpoch(e, filepath.Join(out, "cache"))
		if err != nil {
			if errors.Is(err, errNotInArchive) {
				return 0, fmt.Errorf("not in the archive yet: %w", err)
			}
			return 0, err // never plan around an epoch we merely failed to reach
		}
		b, err := ep.firstBlockFrom(ctx, 0)
		if err != nil {
			return 0, fmt.Errorf("first block: %w", err)
		}
		opened[e], firsts[e] = ep, b
		return b.BlockTime, nil
	}
	e0, e1, probes, err := pickEpochs(t0, t1, firstTime)
	if err != nil {
		return nil, nil, fmt.Errorf("plan: %w", err)
	}
	log.Printf("plan: epochs %d-%d hold [%d, %d) (%d epochs probed)", e0, e1, t0, t1, probes)
	epochs := map[uint64]*Epoch{}
	var units []unitSpec
	for e := e0; e <= e1; e++ {
		ep, first := opened[e], firsts[e]
		epochs[e] = ep
		// Block time is interpolated between the epoch's first and (near) last block;
		// two units of margin on each side absorb slot-time drift. Units outside the
		// window are harmless: finalize keeps rows by block time.
		last, err := ep.firstBlockFrom(ctx, ep.CarSize-(64<<20))
		if err != nil {
			return nil, nil, fmt.Errorf("epoch %d last block: %w", e, err)
		}
		tAt := func(s uint64) int64 {
			if last.Slot == first.Slot {
				return first.BlockTime
			}
			return first.BlockTime + int64(float64(int64(s)-int64(first.Slot))*float64(last.BlockTime-first.BlockTime)/float64(last.Slot-first.Slot))
		}
		margin := int64(2 * unitSlots * 400 / 1000) // two units at up to 0.4 s per slot
		for u := epochFirstSlot(e); u <= epochLastSlot(e); u += unitSlots {
			lastSlot := u + unitSlots - 1
			if lastSlot > epochLastSlot(e) {
				lastSlot = epochLastSlot(e)
			}
			if tAt(u)-margin < t1 && tAt(lastSlot)+margin >= t0 {
				units = append(units, unitSpec{e, u, lastSlot})
			}
		}
	}
	if len(units) == 0 {
		return nil, nil, fmt.Errorf("plan: 0 units in epochs %d-%d for [%d, %d)", e0, e1, t0, t1)
	}
	return units, epochs, nil
}

// planLine is the one-line plan scan-day.sh copies into the batch summary (OFX-4).
func planLine(units []unitSpec) string {
	var es []string
	last := uint64(math.MaxUint64)
	for _, u := range units {
		if u.epoch != last {
			es = append(es, strconv.FormatUint(u.epoch, 10))
			last = u.epoch
		}
	}
	return fmt.Sprintf("%d units planned (epochs %s)", len(units), strings.Join(es, " "))
}

func absI64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
