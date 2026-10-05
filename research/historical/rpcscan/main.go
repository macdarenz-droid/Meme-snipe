package main

// zeroed-rpcscan: the historical dataset over Helius getBlock (DATA-2), with the
// archive scanner's own code. Every scanner source except main.go is a symlink to
// ../scanner, so the decoders, the unit writer's helpers and the formats are the same
// files, and the scanner folder (whose git tree is the archive units' revision) is
// untouched. RPC transactions are encoded as archive nodes (rpcblock.go) and go
// through the scanner's unchanged processBlock.
//
// HELIUS_API_KEY from the environment; -max-credits is required:
//
//   zeroed-rpcscan rpc-unit -out DIR -epoch E -from-slot S -to-slot S -max-credits N [-dir RECORDED]
//   zeroed-rpcscan rpc-run -out DIR -from 2026-07-19 -to 2026-10-04 -max-credits N
//   zeroed-rpcscan pilot -baseline FILE -sample 0.05 -max-credits N -report FILE
//   zeroed-rpcscan digest -unit DIR -o FILE ; zeroed-rpcscan digest-compare -baseline FILE -unit DIR
//
// Units are written in the scanner's layout (units/EPOCH/FROM-TO), so the scanner's
// finalize, QA and assembly read them unchanged.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
	"syscall"
	"time"
)

// scannerRevision is set at build time (ci/rpcscan-rev.sh): the scanner's tree, this
// folder's tree and the Go version.
var scannerRevision = "dev"

// runLock holds the run's lock file open (see the scanner's main.go).
var runLock *os.File

const unitSlots = 4500 // the scanner's units: ~30 minutes of chain time, epoch-aligned

type unitSpec struct {
	epoch    uint64
	from, to uint64
}

func (u unitSpec) dir(out string) string {
	return filepath.Join(out, "units", fmt.Sprintf("%d", u.epoch), fmt.Sprintf("%d-%d", u.from, u.to))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zeroed-rpcscan rpc-unit|rpc-run|pilot|digest|digest-compare ...")
		os.Exit(2)
	}
	debug.SetGCPercent(400)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch os.Args[1] {
	case "rpc-unit":
		// One unit read over JSON-RPC getBlock (DATA-2): from Helius (HELIUS_API_KEY
		// in the environment, never on the command line) or from a directory of
		// recorded getBlock responses (-dir, for tests and local checks).
		fs := flag.NewFlagSet("rpc-unit", flag.ExitOnError)
		out := fs.String("out", "data", "output dir")
		ep := fs.Uint64("epoch", 0, "epoch")
		from := fs.Uint64("from-slot", 0, "first slot")
		to := fs.Uint64("to-slot", 0, "last slot")
		dir := fs.String("dir", "", "read recorded getBlock responses from DIR/<slot>.json instead of Helius")
		workers := fs.Int("workers", 4, "block workers")
		fs.Float64Var(&sampleRate, "sample", sampleRate, "mint sample kept in full (hash threshold)")
		hc := heliusFlags(fs)
		usageOut := fs.String("usage-out", "", "write the credits and requests used to FILE (JSON) on every exit")
		fs.Parse(os.Args[2:])
		var src blockSource
		conc := 1
		if *dir != "" {
			src = dirSource{*dir}
		} else {
			h, err := hc.client()
			if err != nil {
				log.Print(err)
				os.Exit(2)
			}
			src, conc = h, hc.conc
			defer h.logUsage()
		}
		if *ep != *from/432000 || *ep != *to/432000 {
			log.Printf("refused: slots %d-%d are not in epoch %d", *from, *to, *ep)
			os.Exit(2)
		}
		u := unitSpec{*ep, *from, *to}
		st, err := RPCUnit(ctx, src, u.epoch, u.from, u.to, u.dir(*out), conc, *workers)
		if h, ok := src.(*heliusClient); ok {
			writeUsage(*usageOut, h, true)
		}
		if err != nil {
			log.Print(err)
			os.Exit(rpcExitCode(err))
		}
		log.Printf("unit done: blocks=%d skipped=%d curve=%d amm=%d other=%d pumpTx=%d failed=%d decodeFail=%d %.0fs",
			st.Blocks, st.SkippedSlots, st.CurveTrades, st.AmmTrades, st.OtherEvents, st.PumpTxs, st.PumpTxsFailed, st.DecodeFailures, st.Seconds)
	case "rpc-run":
		// Every unit of a window over Helius getBlock (DATA-2's full pull, which needs
		// the owner's paid plan). Finished units are skipped; the credit stop and the
		// back-off budget end the run resumably (exit 75), like a 429 from the archive.
		fs := flag.NewFlagSet("rpc-run", flag.ExitOnError)
		out := fs.String("out", "data", "output dir")
		fromDay := fs.String("from", "", "first UTC day (YYYY-MM-DD)")
		toDay := fs.String("to", "", "end UTC day, exclusive (YYYY-MM-DD)")
		workers := fs.Int("workers", 4, "block workers")
		newestFirst := fs.Bool("newest-first", true, "read the most recent units first")
		fs.Float64Var(&sampleRate, "sample", sampleRate, "mint sample kept in full (hash threshold)")
		hc := heliusFlags(fs)
		usageOut := fs.String("usage-out", "", "write the credits and requests used to FILE (JSON) on every exit")
		fs.Parse(os.Args[2:])
		t0, err := time.Parse("2006-01-02", *fromDay)
		if err != nil {
			log.Fatal(err)
		}
		t1, err := time.Parse("2006-01-02", *toDay)
		if err != nil {
			log.Fatal(err)
		}
		h, err := hc.client()
		if err != nil {
			log.Print(err)
			os.Exit(2)
		}
		defer h.logUsage()
		exit := func(code int) { writeUsage(*usageOut, h, true); h.logUsage(); os.Exit(code) }
		if err := os.MkdirAll(*out, 0o755); err != nil {
			log.Fatal(err)
		}
		lf, err := os.OpenFile(filepath.Join(*out, "run.lock"), os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			log.Fatal(err)
		}
		if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			log.Fatalf("another run holds %s: %v", lf.Name(), err)
		}
		runLock = lf
		units, err := planRPCUnits(ctx, h, t0.Unix(), t1.Unix())
		if err != nil {
			log.Print(h.scrub(err.Error()))
			exit(rpcExitCode(err))
		}
		if *newestFirst {
			sort.Slice(units, func(i, j int) bool { return units[i].from > units[j].from })
		}
		var todo []unitSpec
		for _, u := range units {
			if _, err := os.Stat(filepath.Join(u.dir(*out), "stats.json")); err != nil {
				todo = append(todo, u)
			}
		}
		log.Printf("plan: %d units, %d already done, %d to read", len(units), len(units)-len(todo), len(todo))
		start := time.Now()
		for i, u := range todo {
			st, err := RPCUnit(ctx, h, u.epoch, u.from, u.to, u.dir(*out), hc.conc, *workers)
			if err != nil {
				log.Printf("unit %d %d-%d: %s", u.epoch, u.from, u.to, h.scrub(err.Error()))
				exit(rpcExitCode(err)) // finished units are kept
			}
			writeUsage(*usageOut, h, false) // after every unit; not final until the run exits
			eta := time.Duration(float64(time.Since(start)) / float64(i+1) * float64(len(todo)-i-1))
			log.Printf("unit %d %d-%d ok: blocks=%d skipped=%d curve=%d amm=%d decodeFail=%d %.0fs | %d/%d, eta %s, credits %d",
				u.epoch, u.from, u.to, st.Blocks, st.SkippedSlots, st.CurveTrades, st.AmmTrades, st.DecodeFailures, st.Seconds,
				i+1, len(todo), eta.Round(time.Minute), h.Credits.Load())
		}
		writeUsage(*usageOut, h, true)
	case "digest":
		// Fingerprint a unit's rows (digest.go): the committed pilot baseline is made
		// with this from the archive unit.
		fs := flag.NewFlagSet("digest", flag.ExitOnError)
		unit := fs.String("unit", "", "unit directory (with stats.json)")
		outF := fs.String("o", "", "output file (.json.zst)")
		fs.Parse(os.Args[2:])
		d, err := digestUnit(*unit)
		if err != nil {
			log.Fatal(err)
		}
		if err := writeDigest(*outF, d); err != nil {
			log.Fatal(err)
		}
	case "digest-compare":
		fs := flag.NewFlagSet("digest-compare", flag.ExitOnError)
		baseF := fs.String("baseline", "", "baseline digest")
		candU := fs.String("unit", "", "candidate unit directory")
		fs.Parse(os.Args[2:])
		base, err := readDigest(*baseF)
		if err != nil {
			log.Fatal(err)
		}
		cand, err := digestUnit(*candU)
		if err != nil {
			log.Fatal(err)
		}
		c := compareDigests(base, cand)
		b, _ := json.MarshalIndent(c, "", "  ")
		fmt.Println(string(b))
		if !c.Equal {
			os.Exit(1)
		}
	case "pilot":
		// The Helius pilot (pilot.go). HELIUS_API_KEY from the environment only.
		fs := flag.NewFlagSet("pilot", flag.ExitOnError)
		work := fs.String("work", "pilot-work", "scratch directory for the units read (deleted after each)")
		report := fs.String("report", "pilot-report.json", "report file")
		baseline := fs.String("baseline", "", "committed digest of the comparison unit")
		cmp := fs.String("compare", "1046:452277000-452281499", "comparison unit EPOCH:FROM-TO (the baseline's unit)")
		edge := fs.Uint64("edge-slots", 50, "slots read at each end of the window")
		workers := fs.Int("workers", 4, "block workers")
		fs.Float64Var(&sampleRate, "sample", sampleRate, "mint sample kept in full (hash threshold); must equal the baseline's")
		hc := heliusFlags(fs)
		fs.Parse(os.Args[2:])
		var ce, cf, ct uint64
		if _, err := fmt.Sscanf(*cmp, "%d:%d-%d", &ce, &cf, &ct); err != nil || ce != cf/432000 || ce != ct/432000 || ct < cf {
			log.Printf("refused: bad -compare %q", *cmp)
			os.Exit(2)
		}
		// Refuse before spending a credit if the baseline cannot be compared.
		base, err := readDigest(*baseline)
		if err != nil {
			log.Printf("refused: baseline: %v", err)
			os.Exit(2)
		}
		if base.Epoch != ce || base.FromSlot != cf || base.ToSlot != ct {
			log.Printf("refused: the baseline is unit %d:%d-%d, not %s", base.Epoch, base.FromSlot, base.ToSlot, *cmp)
			os.Exit(2)
		}
		if sr, _ := base.Stats["sample_rate"].(float64); sr != sampleRate {
			log.Printf("refused: -sample %v differs from the baseline's %v", sampleRate, sr)
			os.Exit(2)
		}
		h, err := hc.client()
		if err != nil {
			log.Print(err)
			os.Exit(2)
		}
		rep, err := runPilot(ctx, h, hc.conc, *workers, defaultPilotUnits(*edge, ce, cf, ct), *baseline, *work, *report)
		h.logUsage()
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("pilot: %s", rep.Verdict)
		if rep.Comparison == nil || !rep.Comparison.Equal {
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}

// rpcExitCode: 3 when the credit cap stopped the run (not resumable: a chained rerun
// would only hit it again; the cap is raised by a person or the next month), 75 when
// the rate-limit back-off budget ran out (resumable, like the archive's 429), 1 else.
func rpcExitCode(err error) int {
	switch {
	case errors.Is(err, errCreditCap):
		return 3
	case errors.Is(err, errBackoffBudget):
		return 75
	}
	return 1
}

// writeUsage writes the client's counters to path (no-op for "").
func writeUsage(path string, h *heliusClient, final bool) {
	if path == "" {
		return
	}
	// Written whole or not at all (a temp file renamed into place), so a run killed
	// mid-write never leaves a half file that would fail the booking.
	u := h.usage()
	u.Final = final
	b, _ := json.MarshalIndent(u, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Printf("usage file: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		log.Printf("usage file: %v", err)
	}
}

// epochUnits is the scanner planner's per-epoch rule (planUnits in ../scanner/main.go),
// kept identical so both sources cut the same units. epochUnits lists the units of epoch e whose interpolated block times reach [t0, t1).
// Block time is interpolated between the epoch's first and (near) last block; two units
// of margin on each side absorb slot-time drift. Units outside the window are
// harmless: finalize keeps rows by block time.
func epochUnits(e uint64, first, last *blockRef, t0, t1 int64) []unitSpec {
	tAt := func(s uint64) int64 {
		if last.Slot == first.Slot {
			return first.BlockTime
		}
		return first.BlockTime + int64(float64(int64(s)-int64(first.Slot))*float64(last.BlockTime-first.BlockTime)/float64(last.Slot-first.Slot))
	}
	margin := int64(2 * unitSlots * 400 / 1000) // two units at up to 0.4 s per slot
	var units []unitSpec
	for u := epochFirstSlot(e); u <= epochLastSlot(e); u += unitSlots {
		lastSlot := u + unitSlots - 1
		if lastSlot > epochLastSlot(e) {
			lastSlot = epochLastSlot(e)
		}
		if tAt(u)-margin < t1 && tAt(lastSlot)+margin >= t0 {
			units = append(units, unitSpec{e, u, lastSlot})
		}
	}
	return units
}
