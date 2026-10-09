package main

// zeroed-scan: builds the historical pump.fun / PumpSwap dataset from the Old Faithful
// archive. See docs/research/historical-data.md. Only .github/workflows/data-scan.yml
// runs run/unit against the archive (one lane; no local scans, supervisor ruling).
//
//   zeroed-scan run -out DIR -from 2026-09-01 -to 2026-10-01 [-parallel 3]
//   zeroed-scan unit -out DIR -epoch 1047 -from-slot S -to-slot S
//
// Work is split into fixed units of unitSlots slots aligned to the epoch start, so a
// run can be killed and restarted at any time: finished units (a directory with
// stats.json) are skipped and an unfinished unit is redone from scratch.

import (
	"context"
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

func (u unitSpec) name() string { return fmt.Sprintf("%d/%d-%d", u.epoch, u.from, u.to) }

// readUnitsFile (OF-6 ruling 3): the units a -units file lists, one "EPOCH/FROM-TO" a line
// (a QA failure's named units, after the owner was told); at least one, each well formed.
// Read before planning, so a bad file refuses the run before any request.
func readUnitsFile(path string) (map[string]bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		var e, f, t uint64
		if n, err := fmt.Sscanf(l, "%d/%d-%d", &e, &f, &t); err != nil || n != 3 || (unitSpec{e, f, t}).name() != l {
			return nil, fmt.Errorf("-units: bad line %q (EPOCH/FROM-TO)", l)
		}
		want[l] = true
	}
	if len(want) == 0 {
		return nil, fmt.Errorf("-units: %s lists no unit", path)
	}
	return want, nil
}

// onlyUnits keeps the planned units listed in want; a listed unit that is not in the
// plan refuses the run.
func onlyUnits(units []unitSpec, want map[string]bool) ([]unitSpec, error) {
	left := map[string]bool{}
	for k := range want {
		left[k] = true
	}
	var kept []unitSpec
	for _, u := range units {
		if left[u.name()] {
			kept = append(kept, u)
			delete(left, u.name())
		}
	}
	for l := range left {
		return nil, fmt.Errorf("-units: %s is not a unit of this day's plan", l)
	}
	return kept, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zeroed-scan run|unit|finalize|trim|unitlog|migrations ...")
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
		maxMBps := fs.Float64("max-mbps", 40, "download cap in MB/s (1 MB = 1e6 bytes), above 0 and at most 40")
		on429u := fs.String("on-429", "stop", "stop: end the run (exit code 75); pause: wait max(1 h, Retry-After) and retry")
		state := fs.String("state", "", "directory holding 429.log and the persisted back-off (default: -out)")
		retention := fs.String("retention", "", "K2 or K3 (OF-3; empty: today's units)")
		mlist := fs.String("migration-list", "", "K3: the pinned PM-01 migration list")
		fs.Parse(os.Args[2:])
		if err := setRetention(*retention, *mlist); err != nil {
			log.Printf("refused: %v", err)
			os.Exit(2)
		}
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
	case "trim":
		// OF-3: a K2 unit trimmed to K3 with the pinned migration list; no network.
		fs := flag.NewFlagSet("trim", flag.ExitOnError)
		in := fs.String("in", "", "the K2 unit directory")
		outU := fs.String("out", "", "the K3 unit directory to write (must not exist)")
		mlist := fs.String("migration-list", "", "the pinned PM-01 migration list")
		fs.Parse(os.Args[2:])
		if err := TrimUnit(*in, *outU, *mlist); err != nil {
			log.Printf("refused: %v", err)
			os.Exit(2)
		}
		return
	case "migrations":
		// OF-3: the pinned PM-01 migration list of a day: its own units plus -prior.
		fs := flag.NewFlagSet("migrations", flag.ExitOnError)
		horizon := fs.Int64("horizon-s", pmHorizonS, "seconds kept after each migration (PM-01 PREREG §3: 300 min)")
		prior := fs.String("prior", "", "the earlier days' pinned list (empty: none)")
		dayStart := fs.Int64("day-start", 0, "the day's first second (unix): prior lines ending before it are dropped")
		fs.Parse(os.Args[2:])
		lines, err := migrationList(fs.Args(), *horizon, *prior, *dayStart)
		if err != nil {
			log.Printf("refused: %v", err)
			os.Exit(2)
		}
		for _, l := range lines {
			fmt.Println(l)
		}
		return
	case "unitlog":
		// OF-3: the per-unit log of OUT's units; with -check, refuse units that differ from it.
		fs := flag.NewFlagSet("unitlog", flag.ExitOnError)
		outD := fs.String("out", "", "the directory holding units/")
		check := fs.String("check", "", "a per-unit log to compare the units with")
		fs.Parse(os.Args[2:])
		if *check != "" {
			if err := checkUnitLog(*outD, *check); err != nil {
				log.Printf("refused: %v", err)
				os.Exit(2)
			}
			return
		}
		lines, err := unitLog(*outD)
		if err != nil {
			log.Fatal(err)
		}
		for _, l := range lines {
			fmt.Println(l)
		}
		return
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
		onlyFile := fs.String("units", "", "OF-6: only these units (a file of EPOCH/FROM-TO lines; a QA failure's named units)")
		maxMBps := fs.Float64("max-mbps", 40, "download cap in MB/s (1 MB = 1e6 bytes), above 0 and at most 40")
		on429 := fs.String("on-429", "stop", "stop: end the run (exit code 75) so a scheduler can back off; pause: wait max(1 h, Retry-After) and retry")
		retention := fs.String("retention", "", "K2 or K3 (OF-3; empty: today's units)")
		mlist := fs.String("migration-list", "", "K3: the pinned PM-01 migration list")
		fs.Parse(os.Args[2:])
		if err := setRetention(*retention, *mlist); err != nil {
			log.Printf("refused: %v", err)
			os.Exit(2)
		}
		var onlyWant map[string]bool
		if *onlyFile != "" {
			var err error
			if onlyWant, err = readUnitsFile(*onlyFile); err != nil {
				log.Printf("refused: %v", err)
				os.Exit(2)
			}
		}
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
		if onlyWant != nil {
			if units, err = onlyUnits(units, onlyWant); err != nil {
				log.Printf("refused: %v", err)
				os.Exit(2)
			}
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
		// Block time is interpolated between the epoch's first and (near) last block;
		// two units of margin on each side absorb slot-time drift. Units outside the
		// window are harmless: finalize keeps rows by block time.
		first, err := ep.firstBlockFrom(ctx, 0)
		if err != nil {
			return nil, nil, fmt.Errorf("epoch %d first block: %w", e, err)
		}
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
	return units, epochs, nil
}
