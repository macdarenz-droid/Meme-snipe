package main

// Units read over JSON-RPC (DATA-2): the produced slots of a unit come from getBlocks,
// each block from getBlock, and the unit is written by the same unitRun as an
// archive unit, so every file and row has the archive's format (schema 3).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// rpcSourceTag marks units read over RPC in stats.json (root_cid) and the manifest.
const rpcSourceTag = "rpc:getBlock"

// blockSource lists and returns blocks: helius.go over HTTP, dirSource from recorded
// responses (tests and local checks).
type blockSource interface {
	// producedSlots returns the slots in [from, to] that have a block, ascending.
	producedSlots(ctx context.Context, from, to uint64) ([]uint64, error)
	// block returns the getBlock result object for a produced slot.
	block(ctx context.Context, slot uint64) ([]byte, error)
}

// errSlotSkipped: the source says the slot has no block (skipped, or missing from its
// storage). For a slot that producedSlots listed it is a gap, never a skip.
var errSlotSkipped = errors.New("slot skipped or missing")

// RPCUnit reads blocks in [from, to] of epoch ep from src into outDir. conc blocks are
// fetched at once; they are added to the unit in slot order.
func RPCUnit(ctx context.Context, src blockSource, ep, from, to uint64, outDir string, conc, workers int) (*UnitStats, error) {
	t0 := time.Now()
	st := &UnitStats{Schema: schemaVersion, Epoch: ep, RootCid: rpcSourceTag, FromSlot: from, ToSlot: to,
		EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}, ScannerRevision: scannerRevision, SampleRate: sampleRate, Retention: retentionPolicy}
	if to < from {
		return nil, fmt.Errorf("unit %d-%d: empty range", from, to)
	}
	slots, err := src.producedSlots(ctx, from, to)
	if err != nil {
		return nil, fmt.Errorf("unit %d-%d: produced slots: %w", from, to, err)
	}
	for i, s := range slots {
		if s < from || s > to || (i > 0 && s <= slots[i-1]) {
			return nil, fmt.Errorf("unit %d-%d: produced slots not ascending inside the unit (%d)", from, to, s)
		}
	}
	st.SkippedSlots = int64(to-from+1) - int64(len(slots))
	u, err := startUnit(outDir, st, workers)
	if err != nil {
		return nil, err
	}
	if conc < 1 {
		conc = 1
	}
	type fetched struct {
		b   *blockData
		err error
	}
	// One result channel per slot, filled by conc fetchers and drained in slot order,
	// so at most conc+cap blocks are held in memory.
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	futures := make([]chan fetched, len(slots))
	for i := range futures {
		futures[i] = make(chan fetched, 1)
	}
	// The window is taken in slot order by the dispatcher (never by a fetcher), so the
	// next slot to add always has a place and the reader cannot deadlock.
	window := make(chan struct{}, conc*4) // blocks dispatched but not yet added
	next := make(chan int)
	go func() {
		defer close(next)
		for i := range slots {
			select {
			case window <- struct{}{}:
			case <-cctx.Done():
				return
			}
			select {
			case next <- i:
			case <-cctx.Done():
				return
			}
		}
	}()
	for w := 0; w < conc; w++ {
		go func() {
			for i := range next {
				raw, err := src.block(cctx, slots[i])
				if err != nil {
					if errors.Is(err, errSlotSkipped) {
						err = fmt.Errorf("slot %d is listed as produced but its block is missing: %w", slots[i], err)
					}
					futures[i] <- fetched{err: err}
					continue
				}
				b, err := rpcBlock(slots[i], raw)
				futures[i] <- fetched{b, err}
			}
		}()
	}
	var readErr error
	for i := range slots {
		f := <-futures[i]
		<-window
		if f.err != nil {
			readErr = f.err
			break
		}
		u.add(f.b)
	}
	cancel()
	check := func() error {
		if len(slots) > 0 && st.FirstBlockSlot != slots[0] {
			return fmt.Errorf("first block %d, expected %d", st.FirstBlockSlot, slots[0])
		}
		if int64(len(slots)) != int64(st.Blocks) {
			return fmt.Errorf("%d blocks written, %d produced", st.Blocks, len(slots))
		}
		return nil
	}
	if err := u.finish(readErr, check, t0); err != nil {
		return nil, err
	}
	return st, nil
}

// dirSource serves recorded getBlock responses: DIR/<slot>.json (or .json.zst) holds
// the whole JSON-RPC response (result or error). A slot without a file has no block.
type dirSource struct{ dir string }

func (d dirSource) producedSlots(_ context.Context, from, to uint64) ([]uint64, error) {
	ents, err := os.ReadDir(d.dir)
	if err != nil {
		return nil, err
	}
	var out []uint64
	for _, e := range ents {
		name := strings.TrimSuffix(e.Name(), ".zst")
		s, err := strconv.ParseUint(strings.TrimSuffix(name, ".json"), 10, 64)
		if err != nil || !strings.HasSuffix(name, ".json") {
			continue
		}
		if s >= from && s <= to {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func (d dirSource) block(_ context.Context, slot uint64) ([]byte, error) {
	p := filepath.Join(d.dir, fmt.Sprintf("%d.json", slot))
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		if b, err = os.ReadFile(p + ".zst"); err == nil {
			b, err = zstdDec.DecodeAll(b, nil)
		}
	}
	if err != nil {
		return nil, err
	}
	return rpcResult(b)
}

// rpcResult returns the result of a JSON-RPC response, or its error as a Go error
// (errSlotSkipped for the skipped and missing-slot codes).
func rpcResult(body []byte) ([]byte, error) {
	var r struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("rpc response: %w", err)
	}
	if r.Error != nil {
		return nil, r.Error
	}
	if len(r.Result) == 0 || string(r.Result) == "null" {
		return nil, fmt.Errorf("rpc response without a result")
	}
	return r.Result, nil
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// Unwrap maps the skipped-slot codes: -32007 (skipped, or missing after a ledger jump)
// and -32009 (skipped, or missing in long-term storage).
func (e *rpcError) Unwrap() error {
	if e.Code == -32007 || e.Code == -32009 {
		return errSlotSkipped
	}
	return nil
}

// Window planning over RPC: each epoch's first and last produced block and their block
// times (getBlocksWithLimit, getBlocks, getBlockTime: about 4 credits an epoch) feed
// the archive planner's interpolation (epochUnits), so both sources cut the same units.

var errEpochIncomplete = errors.New("epoch not complete on the RPC yet")

func (h *heliusClient) blockTime(ctx context.Context, slot uint64) (int64, error) {
	res, err := h.call(ctx, "getBlockTime", []any{slot})
	if err != nil {
		return 0, err
	}
	var t *int64
	if err := json.Unmarshal(res, &t); err != nil || t == nil {
		return 0, fmt.Errorf("getBlockTime %d: no time", slot)
	}
	return *t, nil
}

// epochAnchors returns the first and last produced blocks of epoch e with their times.
func (h *heliusClient) epochAnchors(ctx context.Context, e uint64) (*blockRef, *blockRef, error) {
	res, err := h.call(ctx, "getBlocksWithLimit", []any{epochFirstSlot(e), 1, map[string]any{"commitment": "finalized"}})
	if err != nil {
		return nil, nil, err
	}
	var firstSlots []uint64
	if err := json.Unmarshal(res, &firstSlots); err != nil {
		return nil, nil, fmt.Errorf("getBlocksWithLimit: %w", err)
	}
	if len(firstSlots) == 0 || firstSlots[0] > epochLastSlot(e) {
		return nil, nil, fmt.Errorf("epoch %d: %w", e, errEpochIncomplete)
	}
	tail, err := h.producedSlots(ctx, epochLastSlot(e)-1999, epochLastSlot(e))
	if err != nil {
		return nil, nil, err
	}
	if len(tail) == 0 {
		return nil, nil, fmt.Errorf("epoch %d: %w", e, errEpochIncomplete)
	}
	first := &blockRef{Slot: firstSlots[0]}
	last := &blockRef{Slot: tail[len(tail)-1]}
	if first.BlockTime, err = h.blockTime(ctx, first.Slot); err != nil {
		return nil, nil, err
	}
	if last.BlockTime, err = h.blockTime(ctx, last.Slot); err != nil {
		return nil, nil, err
	}
	return first, last, nil
}

// planRPCUnits lists the units covering block times [t0, t1): from planUnits' slot
// estimate it walks to the epoch holding t0, then forward until an epoch starts at or
// after t1. Every epoch it plans from must be complete on the RPC.
func planRPCUnits(ctx context.Context, h *heliusClient, t0, t1 int64) ([]unitSpec, error) {
	est := func(t int64) int64 { return 452500000 + (t-1790914653)*145252/38799 }
	type anchors struct{ first, last *blockRef }
	cache := map[uint64]anchors{}
	get := func(e uint64) (anchors, error) {
		if a, ok := cache[e]; ok {
			return a, nil
		}
		f, l, err := h.epochAnchors(ctx, e)
		if err != nil {
			return anchors{}, err
		}
		cache[e] = anchors{f, l}
		return cache[e], nil
	}
	e := uint64(est(t0) / 432000)
	for steps := 0; ; steps++ {
		if steps > 200 {
			return nil, fmt.Errorf("no epoch holds %d within 200 steps", t0)
		}
		a, err := get(e)
		if errors.Is(err, errEpochIncomplete) && e > 0 {
			e-- // the estimate ran past the RPC's newest complete epoch
			continue
		}
		if err != nil {
			return nil, err
		}
		switch {
		case a.first.BlockTime > t0 && e > 0:
			e--
			continue
		case a.last.BlockTime < t0:
			e++
			continue
		}
		break
	}
	var units []unitSpec
	for ; ; e++ {
		a, err := get(e)
		if err != nil {
			return nil, err
		}
		if a.first.BlockTime >= t1 {
			break
		}
		units = append(units, epochUnits(e, a.first, a.last, t0, t1)...)
	}
	// Nothing before the first epoch planned is needed: that epoch's first block is at
	// or before t0. The last epoch planned is the one before the first that starts at
	// or after t1.
	return units, nil
}
