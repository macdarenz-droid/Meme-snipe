package main

// zeroed-scan: builds the historical pump.fun / PumpSwap dataset from the Old Faithful
// archive. See docs/research/historical-data.md.
//
//   zeroed-scan run -out DIR -from 2026-09-01 -to 2026-10-01 [-parallel 3]
//   zeroed-scan unit -out DIR -epoch 1047 -from-slot S -to-slot S
//
// Work is split into fixed units of unitSlots slots aligned to the epoch start, so a
// run can be killed and restarted at any time: finished units (a directory with
// stats.json) are skipped and an unfinished unit is redone from scratch.

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"runtime/pprof"
	"sort"
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
		prof := fs.String("cpuprofile", "", "write a CPU profile")
		fs.Parse(os.Args[2:])
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
			return
		}
		log.Printf("unit done: blocks=%d/%d curve=%d amm=%d other=%d pumpTx=%d failed=%d decodeFail=%d %.0fs",
			st.Blocks, st.BlocksExpected, st.CurveTrades, st.AmmTrades, st.OtherEvents, st.PumpTxs, st.PumpTxsFailed, st.DecodeFailures, st.Seconds)
	case "run":
		fs := flag.NewFlagSet("run", flag.ExitOnError)
		out := fs.String("out", "data", "output dir")
		fromDay := fs.String("from", "", "first UTC day (YYYY-MM-DD)")
		toDay := fs.String("to", "", "end UTC day, exclusive (YYYY-MM-DD)")
		parallel := fs.Int("parallel", 3, "units scanned at once")
		dl := fs.Int("dl", 4, "parallel chunk downloads per unit")
		workers := fs.Int("workers", 2, "block workers per unit")
		newestFirst := fs.Bool("newest-first", true, "scan the most recent units first")
		fs.Parse(os.Args[2:])
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
		units, epochs, err := planUnits(*out, t0.Unix(), t1.Unix())
		if err != nil {
			log.Fatal(err)
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
						if err == nil || ctx.Err() != nil {
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
						log.Printf("unit %d %d-%d ok: blocks=%d/%d curve=%d amm=%d other=%d decodeFail=%d %.0fs | %d/%d done, eta %s",
							u.epoch, u.from, u.to, st.Blocks, st.BlocksExpected, st.CurveTrades, st.AmmTrades, st.OtherEvents, st.DecodeFailures, st.Seconds,
							done, len(todo), eta.Round(time.Minute))
					}
					mu.Unlock()
				}
			}()
		}
	feed:
		for _, u := range todo {
			select {
			case q <- u:
			case <-ctx.Done():
				break feed
			}
		}
		close(q)
		wg.Wait()
		log.Printf("run finished: %d done, %d failed, interrupted=%v", done, failed, ctx.Err() != nil)
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
		fs.Parse(os.Args[2:])
		if launchRate > sampleRate || gradRate > sampleRate || poolRate > sampleRate {
			log.Fatalf("rates above the scanner superset (%v) need a rescan", sampleRate)
		}
		if err := Finalize(*out, *ds, *fromDay, *toDay, *allowGaps); err != nil {
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
	for e := e0; e <= e1; e++ {
		ep, err := OpenEpoch(e, filepath.Join(out, "cache"))
		if err != nil {
			log.Printf("epoch %d: not available (%v)", e, err)
			continue
		}
		epochs[e] = ep
		for u := epochFirstSlot(e); u <= epochLastSlot(e); u += unitSlots {
			last := u + unitSlots - 1
			if last > epochLastSlot(e) {
				last = epochLastSlot(e)
			}
			in := false
			for s := u; s <= last; s++ {
				if bt, ok := ep.BlockTime(s); ok && bt >= t0 && bt < t1 {
					in = true
					break
				}
			}
			if in {
				units = append(units, unitSpec{e, u, last})
			}
		}
	}
	return units, epochs, nil
}
