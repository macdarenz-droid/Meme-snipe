package main

// zeroed-scan: builds the historical pump.fun / PumpSwap dataset from the Old Faithful
// archive. See docs/research/historical-data.md. Only .github/workflows/data-scan.yml
// runs run/unit against the archive (one lane; no local scans, supervisor ruling).
//
//   zeroed-scan run -out DIR -from 2026-09-01 -to 2026-10-01 [-parallel 3]
//   zeroed-scan unit -out DIR -epoch 1047 -from-slot S -to-slot S
//
// Over Helius getBlock (DATA-2; HELIUS_API_KEY from the environment, -max-credits
// required), writing the same units:
//
//   zeroed-scan rpc-unit -out DIR -epoch E -from-slot S -to-slot S -max-credits N [-dir RECORDED]
//   zeroed-scan rpc-run -out DIR -from 2026-07-19 -to 2026-10-04 -max-credits N
//   zeroed-scan pilot -baseline FILE -sample 0.05 -max-credits N -report FILE
//   zeroed-scan digest -unit DIR -o FILE ; zeroed-scan digest-compare -baseline FILE -unit DIR
//
// Work is split into fixed units of unitSlots slots aligned to the epoch start, so a
// run can be killed and restarted at any time: finished units (a directory with
// stats.json) are skipped and an unfinished unit is redone from scratch.

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
	"runtime/pprof"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var scannerRevision = "dev"

// runLock holds the run's lock file open; an unreferenced *os.File would be closed by
// its finalizer and silently release the lock.
var runLock *os.File

const unitSlots = 4500 // ~30 minutes of chain time

type unitSpec struct {
	epoch    uint64
	from, to uint64
}

func (u unitSpec) dir(out string) string {
	return filepath.Join(out, "units", fmt.Sprintf("%d", u.epoch), fmt.Sprintf("%d-%d", u.from, u.to))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zeroed-scan run|unit ...")
		os.Exit(2)
	}
	debug.SetGCPercent(400)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch os.Args[1] {
	case "unit":
		fs := flag.NewFlagSet("unit", flag.ExitOnError)
		out := fs.String("out", "data", "output dir")
		ep := fs.Uint64("epoch", 0, "epoch")
		from := fs.Uint64("from-slot", 0, "first slot")
		to := fs.Uint64("to-slot", 0, "last slot")
		dl := fs.Int("dl", 6, "parallel chunk downloads")
		workers := fs.Int("workers", 4, "block workers")
		fs.Float64Var(&sampleRate, "sample", sampleRate, "mint sample kept in full (hash threshold)")
		prof := fs.String("cpuprofile", "", "write a CPU profile")
		maxMBps := fs.Float64("max-mbps", 80, "download cap in MB/s (1 MB = 1e6 bytes), above 0 and at most 80")
		on429u := fs.String("on-429", "stop", "stop: end the run (exit code 75); pause: wait max(1 h, Retry-After) and retry")
		state := fs.String("state", "", "directory holding 429.log and the persisted back-off (default: -out)")
		fs.Parse(os.Args[2:])
		if *state == "" {
			*state = *out
		}
		if err := setupPoliteness(ctx, *state, *maxMBps, *on429u); err != nil {
			log.Print(err)
			if errors.Is(err, errRefused) {
				os.Exit(2)
			}
			os.Exit(1)
		}
		if *prof != "" {
			pf, err := os.Create(*prof)
			if err != nil {
				log.Fatal(err)
			}
			pprof.StartCPUProfile(pf)
			defer pprof.StopCPUProfile()
		}
		e, err := OpenEpoch(*ep, filepath.Join(*out, "cache"))
		if err != nil {
			log.Fatal(err)
		}
		u := unitSpec{*ep, *from, *to}
		st, err := ScanUnit(ctx, e, u.from, u.to, u.dir(*out), *dl, *workers)
		if err != nil {
			log.Print(err)
			if stopped.Load() {
				os.Exit(75)
			}
			os.Exit(1)
		}
		log.Printf("unit done: blocks=%d curve=%d amm=%d other=%d pumpTx=%d failed=%d decodeFail=%d %.0fs",
			st.Blocks, st.CurveTrades, st.AmmTrades, st.OtherEvents, st.PumpTxs, st.PumpTxsFailed, st.DecodeFailures, st.Seconds)
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
			defer h.logUsage()
			src, conc = h, hc.conc
		}
		if *ep != *from/432000 || *ep != *to/432000 {
			log.Printf("refused: slots %d-%d are not in epoch %d", *from, *to, *ep)
			os.Exit(2)
		}
		u := unitSpec{*ep, *from, *to}
		st, err := RPCUnit(ctx, src, u.epoch, u.from, u.to, u.dir(*out), conc, *workers)
		if err != nil {
			log.Print(err)
			if errors.Is(err, errCreditCap) || errors.Is(err, errBackoffBudget) {
				os.Exit(75)
			}
			os.Exit(1)
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
		resumable := func(err error) bool { return errors.Is(err, errCreditCap) || errors.Is(err, errBackoffBudget) }
		units, err := planRPCUnits(ctx, h, t0.Unix(), t1.Unix())
		if err != nil {
			log.Print(h.scrub(err.Error()))
			if resumable(err) {
				os.Exit(75)
			}
			os.Exit(1)
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
				if resumable(err) {
					os.Exit(75) // finished units are kept; rerun later
				}
				os.Exit(1)
			}
			eta := time.Duration(float64(time.Since(start)) / float64(i+1) * float64(len(todo)-i-1))
			log.Printf("unit %d %d-%d ok: blocks=%d skipped=%d curve=%d amm=%d decodeFail=%d %.0fs | %d/%d, eta %s, credits %d",
				u.epoch, u.from, u.to, st.Blocks, st.SkippedSlots, st.CurveTrades, st.AmmTrades, st.DecodeFailures, st.Seconds,
				i+1, len(todo), eta.Round(time.Minute), h.Credits.Load())
		}
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
	case "run":
		fs := flag.NewFlagSet("run", flag.ExitOnError)
		out := fs.String("out", "data", "output dir")
		fromDay := fs.String("from", "", "first UTC day (YYYY-MM-DD)")
		toDay := fs.String("to", "", "end UTC day, exclusive (YYYY-MM-DD)")
		parallel := fs.Int("parallel", 3, "units scanned at once")
		dl := fs.Int("dl", 4, "parallel chunk downloads per unit")
		workers := fs.Int("workers", 2, "block workers per unit")
		newestFirst := fs.Bool("newest-first", true, "scan the most recent units first")
		fs.Float64Var(&sampleRate, "sample", sampleRate, "mint sample kept in full (hash threshold)")
		slots := fs.String("slots", "", "only units inside this slot range, FROM-TO (for tests)")
		maxMBps := fs.Float64("max-mbps", 80, "download cap in MB/s (1 MB = 1e6 bytes), above 0 and at most 80")
		on429 := fs.String("on-429", "stop", "stop: end the run (exit code 75) so a scheduler can back off; pause: wait max(1 h, Retry-After) and retry")
		fs.Parse(os.Args[2:])
		if !validMBps(*maxMBps) || (*on429 != "stop" && *on429 != "pause") {
			log.Printf("refused: -max-mbps must be in (0, %d] and -on-429 stop or pause", maxAllowedMBps)
			os.Exit(2)
		}
		t0, err := time.Parse("2006-01-02", *fromDay)
		if err != nil {
			log.Fatal(err)
		}
		t1, err := time.Parse("2006-01-02", *toDay)
		if err != nil {
			log.Fatal(err)
		}
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
		runLock = lf // keep the file (and its lock) alive for the whole run
		if err := setupPoliteness(ctx, *out, *maxMBps, *on429); err != nil {
			log.Print(err)
			if errors.Is(err, errRefused) {
				os.Exit(2)
			}
			os.Exit(1)
		}
		units, epochs, err := planUnits(*out, t0.Unix(), t1.Unix())
		if err != nil {
			if stopped.Load() {
				log.Printf("planning stopped on 429: %v", err)
				os.Exit(75)
			}
			log.Fatal(err)
		}
		if *slots != "" {
			var a, b uint64
			if _, err := fmt.Sscanf(*slots, "%d-%d", &a, &b); err != nil {
				log.Fatalf("bad -slots: %v", err)
			}
			kept := units[:0]
			for _, u := range units {
				if u.from >= a && u.to <= b {
					kept = append(kept, u)
				}
			}
			units = kept
		}
		if *newestFirst {
			sort.Slice(units, func(i, j int) bool { return units[i].from > units[j].from })
		}
		todo := []unitSpec{}
		for _, u := range units {
			if _, err := os.Stat(filepath.Join(u.dir(*out), "stats.json")); err == nil {
				continue
			}
			todo = append(todo, u)
		}
		log.Printf("plan: %d units, %d already done, %d to scan", len(units), len(units)-len(todo), len(todo))
		var wg sync.WaitGroup
		q := make(chan unitSpec)
		var mu sync.Mutex
		done, failed := 0, 0
		start := time.Now()
		for w := 0; w < *parallel; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for u := range q {
					var st *UnitStats
					var err error
					for attempt := 0; attempt < 3; attempt++ {
						st, err = ScanUnit(ctx, epochs[u.epoch], u.from, u.to, u.dir(*out), *dl, *workers)
						if err == nil || ctx.Err() != nil || stopped.Load() {
							break
						}
						log.Printf("unit %d %d-%d attempt %d failed: %v", u.epoch, u.from, u.to, attempt+1, err)
						time.Sleep(time.Duration(attempt+1) * 10 * time.Second)
					}
					mu.Lock()
					if err != nil {
						failed++
						log.Printf("unit %d %d-%d FAILED: %v", u.epoch, u.from, u.to, err)
					} else {
						done++
						el := time.Since(start)
						eta := time.Duration(float64(el) / float64(done) * float64(len(todo)-done-failed))
						log.Printf("unit %d %d-%d ok: blocks=%d curve=%d amm=%d other=%d decodeFail=%d %.0fs | %d/%d done, eta %s",
							u.epoch, u.from, u.to, st.Blocks, st.CurveTrades, st.AmmTrades, st.OtherEvents, st.DecodeFailures, st.Seconds,
							done, len(todo), eta.Round(time.Minute))
					}
					mu.Unlock()
				}
			}()
		}
	feed:
		for _, u := range todo {
			if stopped.Load() {
				break feed
			}
			select {
			case q <- u:
			case <-ctx.Done():
				break feed
			}
		}
		close(q)
		wg.Wait()
		log.Printf("run finished: %d done, %d failed, interrupted=%v, stopped on 429=%v", done, failed, ctx.Err() != nil, stopped.Load())
		if stopped.Load() {
			os.Exit(75) // EX_TEMPFAIL: finished units are kept; back off, then rerun
		}
		if failed > 0 || ctx.Err() != nil {
			os.Exit(1)
		}
	case "finalize":
		fs := flag.NewFlagSet("finalize", flag.ExitOnError)
		out := fs.String("out", "data", "scan output dir (with units/)")
		ds := fs.String("dataset", "dataset", "dataset output dir")
		fromDay := fs.String("from", "", "first UTC day of the dataset window")
		toDay := fs.String("to", "", "end UTC day, exclusive")
		allowGaps := fs.Bool("allow-gaps", false, "allow holes in the scanned slot ranges (testing only)")
		fs.Float64Var(&launchRate, "launch-rate", launchRate, "launch universe hash threshold (<= 0.25)")
		fs.Float64Var(&gradRate, "grad-rate", gradRate, "graduation universe hash threshold (<= 0.25)")
		fs.Float64Var(&poolRate, "pool-rate", poolRate, "direct-pool universe hash threshold (<= 0.25)")
		partMB := fs.Int64("part-mb", 1900, "rotate output files after this many MiB of uncompressed data (at most 1900)")
		leadIn := fs.Int("lead-in-days", 14, "days of gap-free coverage required before -from (0 for a single-day check)")
		regimes := fs.String("regimes", "", "JSON file of regime boundaries copied into the manifest (research/historical/regimes.json)")
		allowRevs := fs.String("allow-revisions", "", "comma-separated scanner revisions accepted together (default: one revision)")
		fs.Parse(os.Args[2:])
		if *partMB < 1 || *partMB > 1900 {
			log.Fatal("-part-mb must be between 1 and 1900")
		}
		partMaxBytes = *partMB << 20
		opt := finalizeOpts{AllowGaps: *allowGaps, LeadInDays: *leadIn, Regimes: *regimes}
		if *allowRevs != "" {
			opt.AllowRevisions = strings.Split(*allowRevs, ",")
		}
		if *leadIn < 0 {
			log.Fatal("-lead-in-days must be 0 or more")
		}
		if err := Finalize(*out, *ds, *fromDay, *toDay, opt); err != nil {
			log.Fatal(err)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}

// planUnits lists the units covering blocks with block time in [t0, t1).
func planUnits(out string, t0, t1 int64) ([]unitSpec, map[uint64]*Epoch, error) {
	// Anchors: slot 452,500,000 had block time 1,790,914,653 and slot 452,645,252 had
	// 1,790,953,452 (0.267 s per slot in Oct 2026). The estimate only picks candidate
	// epochs, with a two-epoch margin for slot-time drift; real block times decide.
	est := func(t int64) int64 { return 452500000 + (t-1790914653)*145252/38799 }
	e0 := uint64(est(t0)/432000) - 2
	e1 := uint64(est(t1)/432000) + 2
	epochs := map[uint64]*Epoch{}
	var units []unitSpec
	ctx := context.Background()
	for e := e0; e <= e1; e++ {
		ep, err := OpenEpoch(e, filepath.Join(out, "cache"))
		if err != nil {
			if errors.Is(err, errNotInArchive) {
				log.Printf("epoch %d: not in the archive yet", e)
				continue
			}
			return nil, nil, err // never plan around an epoch we merely failed to reach
		}
		epochs[e] = ep
		first, err := ep.firstBlockFrom(ctx, 0)
		if err != nil {
			return nil, nil, fmt.Errorf("epoch %d first block: %w", e, err)
		}
		last, err := ep.firstBlockFrom(ctx, ep.CarSize-(64<<20))
		if err != nil {
			return nil, nil, fmt.Errorf("epoch %d last block: %w", e, err)
		}
		units = append(units, epochUnits(e, first, last, t0, t1)...)
	}
	return units, epochs, nil
}

// epochUnits lists the units of epoch e whose interpolated block times reach [t0, t1).
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
