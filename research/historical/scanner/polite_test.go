package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func resetPoliteness(t *testing.T, dir string) {
	t.Helper()
	stopped.Store(false)
	stateDir, maxRetryAt, blockedUntil, blockedSince = dir, 0, time.Time{}, time.Time{}
	t.Cleanup(func() { stopped.Store(false); stateDir = ""; stopOn429 = true; maxRetryAt = 0 })
}

func TestMaxMbpsRange(t *testing.T) {
	for _, v := range []float64{0, -1, 80.01, 81, 1000} {
		if err := setupPoliteness(context.Background(), t.TempDir(), v, "stop"); !errors.Is(err, errRefused) {
			t.Errorf("-max-mbps %v accepted", v)
		}
	}
	if err := setupPoliteness(context.Background(), t.TempDir(), 80, "maybe"); !errors.Is(err, errRefused) {
		t.Errorf("bad -on-429 accepted")
	}
	if err := setupPoliteness(context.Background(), t.TempDir(), 80, "stop"); err != nil || !stopOn429 {
		t.Errorf("80 MB/s with stop refused: %v", err)
	}
}

func TestByteTokenIsOneMillionBytes(t *testing.T) {
	for n, want := range map[int64]int64{1: 1, 1_000_000: 1, 1_000_001: 2, 3_000_000: 3, 1 << 20: 2} {
		if got := byteTokens(n); got != want {
			t.Errorf("%d bytes: %d tokens, want %d", n, got, want)
		}
	}
}

func TestBackoffIsAtLeastOneHourAndLargestRetryAfter(t *testing.T) {
	resetPoliteness(t, "")
	if d := backoffFor(30 * time.Second); d != time.Hour {
		t.Fatalf("got %s", d)
	}
	if d := backoffFor(2 * time.Hour); d != 2*time.Hour {
		t.Fatalf("got %s", d)
	}
	if d := backoffFor(0); d != 2*time.Hour {
		t.Fatalf("largest Retry-After forgotten: %s", d)
	}
}

func TestFirst429StopsAndPersistsBackoff(t *testing.T) {
	dir := t.TempDir()
	resetPoliteness(t, dir)
	stopOn429 = true
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Retry-After", "7200")
		w.WriteHeader(http.StatusServiceUnavailable) // a 503 with Retry-After counts as a 429
	}))
	defer srv.Close()
	_, err := fetchRange(context.Background(), srv.URL+"/x.car", 0, 10)
	if !errors.Is(err, errStopped) || !stopped.Load() || hits != 1 {
		t.Fatalf("err=%v stopped=%v hits=%d", err, stopped.Load(), hits)
	}
	if _, err := fetchRange(context.Background(), srv.URL+"/x.car", 0, 10); !errors.Is(err, errStopped) || hits != 1 {
		t.Fatalf("a stopped run sent another request")
	}
	st, ok := readState(dir)
	if !ok || st.retryAfter != 2*time.Hour {
		t.Fatalf("state %+v %v", st, ok)
	}
	if d := time.Until(st.until); d < 2*time.Hour-time.Minute || d > 2*time.Hour {
		t.Fatalf("back-off until in %s, want 2 h", d)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "429.log"))
	if !strings.Contains(string(log), "retry_after=2h0m0s") {
		t.Fatalf("429.log: %q", log)
	}
	// A new run sharing the state directory sleeps the back-off out first.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := setupPoliteness(ctx, dir, 80, "stop"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("new run did not wait out the back-off: %v", err)
	}
}

func TestPersistedBackoffNeverMovesBack(t *testing.T) {
	dir := t.TempDir()
	resetPoliteness(t, dir)
	now := time.Now()
	record429(now, 3*time.Hour)
	maxRetryAt = 0
	record429(now, 0)
	st, _ := readState(dir)
	if st.until.Before(now.Add(3*time.Hour - time.Second)) {
		t.Fatalf("back-off end moved back to %s", st.until)
	}
}

func TestPauseModeWaitsAtLeastOneHour(t *testing.T) {
	resetPoliteness(t, t.TempDir())
	stopOn429 = false
	if !noteBlocked(10 * time.Second) {
		t.Fatalf("first 429 in pause mode ended the run")
	}
	if d := time.Until(blockedUntil); d < time.Hour-time.Minute {
		t.Fatalf("paused only %s", d)
	}
}
