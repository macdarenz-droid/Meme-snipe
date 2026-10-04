package main

// Politeness rules for the one-lane scan (supervisor ruling, 2026-10-03):
//   - -max-mbps must lie in (0, 80]; anything else is refused (exit 2).
//   - The default on a 429 (or a 503 with Retry-After) is to stop the run (exit 75).
//   - Every back-off lasts max(1 h, the largest Retry-After seen).
//   - The last 429 is persisted in the state directory, so every new run or rescan
//     that shares it first sleeps out the remaining back-off before its first request.
//   - Every 429 is appended to <state>/429.log (unit and run mode alike).

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxAllowedMBps = 40 // ARCHIVE-SAFE: ARCHIVE_MAX_MBPS in research/historical/ci/archive-limits.conf
	minBackoff     = time.Hour
	stateFileName  = "archive-429.state"
)

var errRefused = errors.New("refused")

var (
	stateDir   string // where 429.log and archive-429.state live; "" disables both
	stateMu    sync.Mutex
	maxRetryAt time.Duration // largest Retry-After seen by this process
)

// validMBps reports whether a download cap is allowed.
func validMBps(v float64) bool { return v > 0 && v <= maxAllowedMBps }

// backoffFor is the wait after a 429: max(1 h, Retry-After, every earlier Retry-After).
func backoffFor(retryAfter time.Duration) time.Duration {
	stateMu.Lock()
	if retryAfter > maxRetryAt {
		maxRetryAt = retryAfter
	}
	ra := maxRetryAt
	stateMu.Unlock()
	if ra > minBackoff {
		return ra
	}
	return minBackoff
}

// politeState is the persisted back-off: "<unix of last 429> <retry-after s> <unix until>".
type politeState struct {
	at, until  time.Time
	retryAfter time.Duration
}

func readState(dir string) (politeState, bool) {
	b, err := os.ReadFile(filepath.Join(dir, stateFileName))
	if err != nil {
		return politeState{}, false
	}
	f := strings.Fields(string(b))
	if len(f) != 3 {
		return politeState{}, false
	}
	var v [3]int64
	for i := range f {
		if v[i], err = strconv.ParseInt(f[i], 10, 64); err != nil {
			return politeState{}, false
		}
	}
	return politeState{at: time.Unix(v[0], 0), retryAfter: time.Duration(v[1]) * time.Second, until: time.Unix(v[2], 0)}, true
}

// record429 logs a 429 and moves the persisted back-off end forward (never back).
func record429(now time.Time, retryAfter time.Duration) {
	if stateDir == "" {
		return
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	pause := minBackoff
	if maxRetryAt > pause {
		pause = maxRetryAt
	}
	if retryAfter > pause {
		pause = retryAfter
	}
	until := now.Add(pause)
	if old, ok := readState(stateDir); ok && old.until.After(until) {
		until = old.until
	}
	if f, err := os.OpenFile(filepath.Join(stateDir, "429.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		fmt.Fprintf(f, "%s 429 retry_after=%s backoff_until=%s stop=%v\n", now.UTC().Format(time.RFC3339),
			retryAfter, until.UTC().Format(time.RFC3339), stopOn429)
		f.Close()
	}
	tmp := filepath.Join(stateDir, stateFileName+".tmp")
	line := fmt.Sprintf("%d %d %d\n", now.Unix(), int64(retryAfter/time.Second), until.Unix())
	if os.WriteFile(tmp, []byte(line), 0o644) == nil {
		os.Rename(tmp, filepath.Join(stateDir, stateFileName))
	}
}

// setupPoliteness applies the flags and sleeps out a persisted back-off. An invalid
// flag returns errRefused (the caller exits 2).
func setupPoliteness(ctx context.Context, dir string, mbps float64, on429 string) error {
	if !validMBps(mbps) {
		return fmt.Errorf("%w: -max-mbps %v must be above 0 and at most %d", errRefused, mbps, maxAllowedMBps)
	}
	switch on429 {
	case "stop":
		stopOn429 = true
	case "pause":
		stopOn429 = false
	default:
		return fmt.Errorf("%w: -on-429 %q must be stop or pause", errRefused, on429)
	}
	byteLimiter = newLimiter(mbps)
	stateDir = dir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return sleepOutBackoff(ctx, dir)
}

func sleepOutBackoff(ctx context.Context, dir string) error {
	st, ok := readState(dir)
	if !ok {
		return nil
	}
	d := time.Until(st.until)
	if d <= 0 {
		return nil
	}
	log.Printf("archive answered 429 at %s: backing off until %s (%s) before the first request",
		st.at.UTC().Format(time.RFC3339), st.until.UTC().Format(time.RFC3339), d.Round(time.Second))
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
