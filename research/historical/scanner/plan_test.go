package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// chainTime is a model of mainnet block times: piecewise linear through the cited
// anchors (about 0.377 s per slot between B2 and B4, 0.280 s after), extrapolated with
// the end slopes. The planner never sees it except through epoch first-block times.
func chainTime(slot uint64) int64 {
	a := slotAnchors
	i := 0
	for i < len(a)-2 && slot >= a[i+1].slot {
		i++
	}
	p, q := a[i], a[i+1]
	rate := float64(q.time-p.time) / float64(q.slot-p.slot)
	return p.time + int64(float64(int64(slot)-int64(p.slot))*rate)
}

func utcDay(t *testing.T, d string) int64 {
	t.Helper()
	x, err := time.Parse("2006-01-02", d)
	if err != nil {
		t.Fatal(err)
	}
	return x.Unix()
}

// covers checks [first, last] is exactly the epochs holding [t0, t1) under ft: the
// first starts before t0 (its tail can share second t0, OFX-8), the next one not.
func covers(t0, t1 int64, first, last uint64, ft func(uint64) int64) error {
	if ft(first) >= t0 || ft(first+1) < t0 {
		return fmt.Errorf("epoch %d does not hold the window start", first)
	}
	if ft(last) >= t1 || ft(last+1) < t1 {
		return fmt.Errorf("epoch %d is not the last epoch before the window end", last)
	}
	return nil
}

// Every allow-listed day (07-22 lead-in, 07-23..08-21) and the two days after: the
// epochs picked hold the day, in at most 8 probes (OFX-1).
func TestPickEpochsAllowListDays(t *testing.T) {
	ft := func(e uint64) int64 { return chainTime(epochFirstSlot(e)) }
	day := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	for k := 0; k < 33; k++ {
		t0 := day.AddDate(0, 0, k).Unix()
		t1 := t0 + 86400
		first, last, probes, err := pickEpochs(t0, t1, func(e uint64) (int64, error) { return ft(e), nil })
		name := day.AddDate(0, 0, k).Format("2006-01-02")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := covers(t0, t1, first, last, ft); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if probes > 8 {
			t.Errorf("%s: %d probes, want at most 8", name, probes)
		}
	}
}

// 07-22 and 07-23 select the epochs holding them, also at the bracket's slot-time
// extremes (uniform 0.21 s and 0.49 s per slot from B2).
func TestPickEpochsHoldsTheDayAtExtremeSlotTimes(t *testing.T) {
	b2 := slotAnchors[0]
	for _, rate := range []float64{0.21, 0.3774, 0.49} {
		ft := func(e uint64) int64 {
			return b2.time + int64(float64(int64(epochFirstSlot(e))-int64(b2.slot))*rate)
		}
		for _, d := range []string{"2026-07-22", "2026-07-23"} {
			t0 := utcDay(t, d)
			first, last, probes, err := pickEpochs(t0, t0+86400, func(e uint64) (int64, error) { return ft(e), nil })
			if err != nil {
				t.Fatalf("%s at %.2f s: %v", d, rate, err)
			}
			if err := covers(t0, t0+86400, first, last, ft); err != nil {
				t.Errorf("%s at %.2f s: %v", d, rate, err)
			}
			if probes > maxProbes {
				t.Errorf("%s at %.2f s: %d probes", d, rate, probes)
			}
		}
	}
}

// Under the cited anchors 07-22 lies in epoch 1005 (and maybe 1006), never in the
// 991-996 the old planner opened.
func TestPickEpochs0722IsNear1005(t *testing.T) {
	t0 := utcDay(t, "2026-07-22")
	first, last, _, err := pickEpochs(t0, t0+86400, func(e uint64) (int64, error) { return chainTime(epochFirstSlot(e)), nil })
	if err != nil {
		t.Fatal(err)
	}
	if first != 1005 || last > 1006 {
		t.Fatalf("07-22 in epochs %d-%d, want 1005 to at most 1006", first, last)
	}
}

// OFX-8: an epoch whose first block is exactly at t0 does not drop the epoch before it,
// whose last blocks can carry the same second.
func TestPickEpochsSameSecondBoundary(t *testing.T) {
	ft := func(e uint64) int64 { return chainTime(epochFirstSlot(e)) }
	for _, e := range []uint64{1005, 1006, 1010} {
		t0 := ft(e)
		first, last, _, err := pickEpochs(t0, t0+86400, func(x uint64) (int64, error) { return ft(x), nil })
		if err != nil {
			t.Fatalf("t0 = first block of %d: %v", e, err)
		}
		if first != e-1 || last < e {
			t.Errorf("t0 = first block of %d: epochs %d-%d, want %d to at least %d", e, first, last, e-1, e)
		}
		if err := covers(t0, t0+86400, first, last, ft); err != nil {
			t.Errorf("t0 = first block of %d: %v", e, err)
		}
	}
}

func TestPickEpochsFailsClosed(t *testing.T) {
	t0 := utcDay(t, "2026-07-22")
	model := func(e uint64) (int64, error) { return chainTime(epochFirstSlot(e)), nil }
	// a chain 30 days off the anchors: the window is outside the bracket
	for _, shift := range []int64{-30 * 86400, 30 * 86400} {
		_, _, _, err := pickEpochs(t0, t0+86400, func(e uint64) (int64, error) { v, _ := model(e); return v + shift, nil })
		if err == nil || !strings.Contains(err.Error(), "bracket") {
			t.Errorf("shift %d: %v, want a bracket error", shift, err)
		}
	}
	// a needed epoch not in the archive yet fails the day; nothing is skipped
	_, _, _, err := pickEpochs(t0, t0+86400, func(e uint64) (int64, error) {
		if e == 1006 {
			return 0, errNotInArchive
		}
		return model(e)
	})
	if !errors.Is(err, errNotInArchive) {
		t.Errorf("missing epoch 1006: %v, want errNotInArchive", err)
	}
	// a day far from every anchor needs more than maxProbes probes: refused
	far := utcDay(t, "2029-01-01")
	_, _, probes, err := pickEpochs(far, far+86400, model)
	if err == nil || !strings.Contains(err.Error(), "more than 10 epochs probed") || probes != maxProbes {
		t.Errorf("far day: %d probes, %v; want the probe cap", probes, err)
	}
	if _, _, _, err := pickEpochs(t0, t0, model); err == nil {
		t.Error("empty window accepted")
	}
}

// TestArchiveBaseIsATestOnlySeam: the archive host is the Old Faithful host and no
// non-test file assigns archiveBase or takes its address (no flag, no environment).
func TestArchiveBaseIsATestOnlySeam(t *testing.T) {
	if defaultArchiveBase != "https://files.old-faithful.net" {
		t.Fatalf("defaultArchiveBase = %q", defaultArchiveBase)
	}
	files, _ := filepath.Glob("*.go")
	fset := token.NewFileSet()
	n := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		af, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		n++
		ast.Inspect(af, func(x ast.Node) bool {
			isBase := func(e ast.Expr) bool { id, ok := e.(*ast.Ident); return ok && id.Name == "archiveBase" }
			switch v := x.(type) {
			case *ast.AssignStmt:
				for _, l := range v.Lhs {
					if isBase(l) {
						t.Errorf("%s assigns archiveBase", fset.Position(v.Pos()))
					}
				}
			case *ast.UnaryExpr:
				if v.Op == token.AND && isBase(v.X) {
					t.Errorf("%s takes the address of archiveBase", fset.Position(v.Pos()))
				}
			case *ast.ValueSpec:
				for i, name := range v.Names {
					if name.Name == "archiveBase" && (i >= len(v.Values) || fmt.Sprint(v.Values[i]) != "defaultArchiveBase") {
						t.Errorf("%s: archiveBase must start as defaultArchiveBase", fset.Position(v.Pos()))
					}
				}
			}
			return true
		})
	}
	if n == 0 {
		t.Fatal("no source files read")
	}
}

// ---- fake archive: epochs of fakeCarSize bytes holding a first and a last block ----

const fakeCarSize = 72 << 20

func cborU32(b []byte, v uint64) []byte {
	return append(b, 0x1a, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func section(data []byte) []byte {
	sum := sha256.Sum256(data)
	body := append(append([]byte{0x01, 0x71, 0x12, 0x20}, sum[:]...), data...)
	return append(binary.AppendUvarint(nil, uint64(len(body))), body...)
}

func blockSection(slot uint64, bt int64) []byte {
	d := cborU32([]byte{0x85, 0x02}, slot)
	d = append(d, 0x80, 0x80, 0x82)
	d = cborU32(d, slot-1)
	d = cborU32(d, uint64(bt))
	return section(d)
}

// fakeCar: header, the first block and two other nodes, zeros, then 4 KiB after
// size-64 MiB the last block and two other nodes, zeros to the end.
func fakeCar(e uint64) map[int64][]byte {
	other := section([]byte{0x81, 0x09})
	head := append(binary.AppendUvarint(nil, 10), make([]byte, 10)...)
	fs, ls := epochFirstSlot(e), epochLastSlot(e)
	firstPart := append(append(append(head, blockSection(fs, chainTime(fs))...), other...), other...)
	lastPart := append(append(blockSection(ls, chainTime(ls)), other...), other...)
	return map[int64][]byte{0: firstPart, fakeCarSize - (64 << 20) + 4096: lastPart}
}

type fakeArchive struct {
	srv        *httptest.Server
	requests   atomic.Int64
	rangeBytes atomic.Int64
	smallBytes atomic.Int64
	mu         sync.Mutex
	epochs     map[uint64]bool // epochs asked for
}

func newFakeArchive(t *testing.T, missing map[uint64]bool) *fakeArchive {
	fa := &fakeArchive{epochs: map[uint64]bool{}}
	fa.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fa.requests.Add(1)
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		e, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil || len(parts) != 2 || missing[e] {
			http.NotFound(w, r)
			return
		}
		fa.mu.Lock()
		fa.epochs[e] = true
		fa.mu.Unlock()
		switch {
		case strings.HasSuffix(parts[1], ".cid"):
			b := []byte(fmt.Sprintf("bafyfake%d\n", e))
			fa.smallBytes.Add(int64(len(b)))
			w.Write(b)
		case strings.HasSuffix(parts[1], ".car") && r.Method == http.MethodHead:
			w.Header().Set("Content-Length", strconv.Itoa(fakeCarSize))
		case strings.HasSuffix(parts[1], ".car"):
			var a, b int64
			if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &a, &b); err != nil || a < 0 || b < a || b >= fakeCarSize {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			buf := make([]byte, b-a+1)
			for off, data := range fakeCar(e) {
				for i, c := range data {
					if p := off + int64(i); p >= a && p <= b {
						buf[p-a] = c
					}
				}
			}
			fa.rangeBytes.Add(int64(len(buf)))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, fakeCarSize))
			w.WriteHeader(http.StatusPartialContent)
			w.Write(buf)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fa.srv.Close)
	return fa
}

func (fa *fakeArchive) asked() []uint64 {
	fa.mu.Lock()
	defer fa.mu.Unlock()
	var es []uint64
	for e := range fa.epochs {
		es = append(es, e)
	}
	sort.Slice(es, func(i, j int) bool { return es[i] < es[j] })
	return es
}

func useFakeArchive(t *testing.T, missing map[uint64]bool) *fakeArchive {
	t.Helper()
	resetPoliteness(t, t.TempDir())
	fa := newFakeArchive(t, missing)
	archiveBase = fa.srv.URL
	t.Cleanup(func() { archiveBase = defaultArchiveBase })
	return fa
}

// OFX-5: 07-22 plans the units of the epochs holding the day. The planner before
// OF-FIX opened epochs 991-996 here and planned 0 units, so this test failed on it.
// Caps (OFX-1): at most 14 requests and 20 MiB + 192 B of range reads for 07-22.
func TestPlanUnitsFakeArchive(t *testing.T) {
	for _, d := range []string{"2026-07-22", "2026-07-23"} {
		t.Run(d, func(t *testing.T) {
			fa := useFakeArchive(t, nil)
			t0 := utcDay(t, d)
			units, epochs, err := planUnits(t.TempDir(), t0, t0+86400)
			if err != nil {
				t.Fatalf("asked epochs %v: %v", fa.asked(), err)
			}
			ft := func(e uint64) int64 { return chainTime(epochFirstSlot(e)) }
			var first, last uint64 = 1 << 62, 0
			for e := range epochs {
				first, last = min(first, e), max(last, e)
			}
			if err := covers(t0, t0+86400, first, last, ft); err != nil {
				t.Fatalf("epochs %d-%d, %d units: %v", first, last, len(units), err)
			}
			// the units span the whole day (a unit's slots map to chain time)
			lo, hi := int64(1<<62), int64(0)
			for _, u := range units {
				lo, hi = min(lo, chainTime(u.from)), max(hi, chainTime(u.to))
			}
			if len(units) == 0 || lo > t0 || hi < t0+86400-1 {
				t.Fatalf("%d units spanning %d-%d do not cover [%d, %d)", len(units), lo, hi, t0, t0+86400)
			}
			if d == "2026-07-22" {
				if first != 1005 {
					t.Errorf("07-22 starts in epoch %d, want 1005", first)
				}
				if r := fa.requests.Load(); r > 14 {
					t.Errorf("%d requests, want at most 14", r)
				}
				if b := fa.rangeBytes.Load(); b > 20<<20+3*64 { // five 4 MiB windows and three 64 B CAR headers
					t.Errorf("%d range bytes, want at most 20 MiB + 192 B", b)
				}
			}
			t.Logf("%s: epochs asked %v, %d units in %d-%d, %d requests, %d range bytes, %d small bytes",
				d, fa.asked(), len(units), first, last, fa.requests.Load(), fa.rangeBytes.Load(), fa.smallBytes.Load())
		})
	}
}

// OFX-2: a needed epoch missing from the archive fails the plan; no empty plan.
func TestPlanUnitsMissingEpochFails(t *testing.T) {
	useFakeArchive(t, map[uint64]bool{1006: true})
	t0 := utcDay(t, "2026-07-22")
	units, _, err := planUnits(t.TempDir(), t0, t0+86400)
	if !errors.Is(err, errNotInArchive) || units != nil {
		t.Fatalf("units %d, err %v; want errNotInArchive", len(units), err)
	}
}

func TestPlanLine(t *testing.T) {
	got := planLine([]unitSpec{{1005, 1, 2}, {1005, 3, 4}, {1006, 5, 6}})
	if got != "3 units planned (epochs 1005 1006)" {
		t.Fatalf("planLine = %q", got)
	}
	if got := planLine(nil); got != "0 units planned (epochs )" {
		t.Fatalf("planLine(nil) = %q", got)
	}
}

// OFX-9: a CAR region holding valid sections but no block node fails the probe after
// at most 64 MiB of walking (plus one read window), never read to the end of the file.
func TestFirstBlockFromCapsTheWalk(t *testing.T) {
	resetPoliteness(t, t.TempDir())
	var car []byte
	car = append(car, append(binary.AppendUvarint(nil, 10), make([]byte, 10)...)...)
	other := section(append([]byte{0x81, 0x09}, make([]byte, 1<<20)...)) // a 1 MiB non-block node
	for len(car) < 96<<20 {
		car = append(car, other...)
	}
	var served atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a, b int64
		if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &a, &b); err != nil || b >= int64(len(car)) {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		served.Add(b - a + 1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", a, b, len(car)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(car[a : b+1])
	}))
	defer srv.Close()
	e := &Epoch{N: 1, CarURL: srv.URL + "/1/epoch-1.car", CarSize: int64(len(car)), headerEnd: 11}
	_, err := e.firstBlockFrom(context.Background(), 0)
	if err == nil || errors.Is(err, errNoBlock) || !strings.Contains(err.Error(), "no block node within 64 MiB") {
		t.Fatalf("err = %v, want the 64 MiB walk cap", err)
	}
	if n := served.Load(); n > maxBlockWalk+2*(probeWindow+(2<<20)) {
		t.Errorf("%d bytes read, want about 64 MiB at most", n)
	}
}
