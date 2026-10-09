package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// OF-6 ruling 3: -units keeps exactly the listed planned units; a bad or empty file, or a
// listed unit outside the plan, refuses.
func TestOnlyUnits(t *testing.T) {
	plan := []unitSpec{{1046, 1, 4500}, {1046, 4501, 9000}, {1046, 9001, 13500}}
	f := filepath.Join(t.TempDir(), "u")
	os.WriteFile(f, []byte("1046/4501-9000\n\n1046/1-4500\n"), 0o644)
	want, err := readUnitsFile(f)
	if err != nil {
		t.Fatal(err)
	}
	got, err := onlyUnits(plan, want)
	if err != nil || len(got) != 2 || got[0].name() != "1046/1-4500" || got[1].name() != "1046/4501-9000" {
		t.Fatalf("kept %v %v", got, err)
	}
	if len(want) != 2 {
		t.Fatal("onlyUnits changed its input")
	}
	for _, bad := range []string{"", "\n", "1046/1-4500x\n", "1046 1-4500\n", "1046/01-4500\n"} {
		os.WriteFile(f, []byte(bad), 0o644)
		if _, err := readUnitsFile(f); err == nil {
			t.Errorf("file %q accepted", bad)
		}
	}
	os.WriteFile(f, []byte("1046/1-4500\n1047/1-4500\n"), 0o644)
	want, _ = readUnitsFile(f)
	if _, err := onlyUnits(plan, want); err == nil || !strings.Contains(err.Error(), "not a unit of this day's plan") {
		t.Errorf("an unplanned unit was accepted: %v", err)
	}
}

// OF-6: a K3 unit taken from the day before's store ("from") or read again after a QA
// failure ("reread") carries no k2 lines; without its line, with k2 lines, or for a unit
// that is not there, the log check refuses.
func TestUnitLogFromAndRereadLines(t *testing.T) {
	list := writeList(t, k3Mint+" 100 200")
	out := t.TempDir()
	lines := trimmedDay(t, out, list)
	// a third K3 unit, trimmed elsewhere (another day's copy), without k2 lines here
	src := filepath.Join(t.TempDir(), "k2")
	scanFixtureUnit(t, "K2", "", src)
	if err := TrimUnit(src, filepath.Join(out, "units", "1046", "5-6"), list); err != nil {
		t.Fatal(err)
	}
	unitLines, _ := unitLog(out)
	var k2lines []string
	for _, l := range lines {
		if strings.HasPrefix(l, "k2 ") {
			k2lines = append(k2lines, l)
		}
	}
	base := append(append([]string{}, unitLines...), k2lines...)
	if err := checkUnitLog(out, writeLog(t, base)); err == nil {
		t.Fatal("a K3 unit without k2 lines or a from line passed")
	}
	for _, kind := range []string{"from 1046/5-6 data-day-2026-07-22", "reread 1046/5-6 qa-rr-1"} {
		if err := checkUnitLog(out, writeLog(t, append(append([]string{}, base...), kind))); err != nil {
			t.Errorf("%q: %v", kind, err)
		}
	}
	h, _ := fileSha256(filepath.Join(out, "units", "1046", "5-6", "events.jsonl.zst"))
	withK2 := append(append(append([]string{}, base...), "from 1046/5-6 data-day-2026-07-22"), "k2 "+h+" 1046/5-6/events.jsonl.zst")
	if err := checkUnitLog(out, writeLog(t, withK2)); err == nil {
		t.Error("a from unit with k2 lines passed")
	}
	if err := checkUnitLog(out, writeLog(t, append(append([]string{}, base...), "from 1046/5-6 data-day-2026-07-22", "from 1046/7-8 data-day-2026-07-22"))); err == nil {
		t.Error("a from line for a unit that is not there passed")
	}
	for _, bad := range []string{"from 1046/5-6", "from 1046-5-6 x", "from 1046/5-6 x", "reread 1046/5-6 y"} {
		l := append(append([]string{}, base...), "from 1046/5-6 x", bad)
		if err := checkUnitLog(out, writeLog(t, l)); err == nil {
			t.Errorf("malformed or duplicate line %q passed", bad)
		}
	}
}

// OF-6 ruling 2: a coin migrating inside day D's forward margin (after midnight, in a unit D
// also scans) keeps all its events and every raw record D+1's list keeps, in the copy of
// that unit D+1 takes from D's store. D's list is built from all of D's units, the forward
// margin included, so D's trim keeps the coin from its migration on; D+1's list holds the
// same window (from D's list as prior, and from the unit's own migration event).
func TestMarginMigrationKeptForNextDay(t *testing.T) {
	base := t.TempDir()
	dOut, d1Out := filepath.Join(base, "d"), filepath.Join(base, "d1")
	k2u := filepath.Join(dOut, "units", "1046", "1-2")
	scanFixtureUnit(t, "K2", "", k2u)
	// midnight between D and D+1 at block time 140; k3Mint migrates after it, inside D's
	// forward margin (at 145), with trades at 150 (failed), 199 and 250 after it
	const midnight, migAt = 140, 145
	ev, _ := json.Marshal(map[string]any{"block_time": migAt, "program": "pump", "event": "CompletePumpAmmMigrationEvent", "fields": map[string]string{"mint": k3Mint}})
	writeZst(t, filepath.Join(k2u, "events.jsonl.zst"), append(ev, '\n'))
	dLines, err := migrationList([]string{dOut}, pmHorizonS, "", 0)
	if err != nil || len(dLines) != 1 || !strings.HasPrefix(dLines[0], k3Mint+" 145 ") {
		t.Fatalf("D's list %v %v: the forward-margin migration must be on it", dLines, err)
	}
	dList := writeList(t, dLines...)
	stored := filepath.Join(d1Out, "units", "1046", "1-2") // D's trimmed copy, taken by D+1
	os.MkdirAll(filepath.Dir(stored), 0o755)
	if err := TrimUnit(k2u, stored, dList); err != nil {
		t.Fatal(err)
	}
	d1Lines, err := migrationList([]string{d1Out}, pmHorizonS, dList, midnight)
	if err != nil || len(d1Lines) != 1 || d1Lines[0] != dLines[0] {
		t.Fatalf("D+1's list %v %v", d1Lines, err)
	}
	own := filepath.Join(base, "own")
	if err := TrimUnit(k2u, own, writeList(t, d1Lines...)); err != nil {
		t.Fatal(err)
	}
	read := func(dir string) []string {
		var ls []string
		readZstLines(filepath.Join(dir, "raw_canonical.jsonl.zst"), func(l []byte) error { ls = append(ls, string(l)); return nil })
		return ls
	}
	have := map[string]bool{}
	for _, l := range read(stored) {
		have[l] = true
	}
	need := read(own)
	if len(need) != 3 {
		t.Fatalf("fixture: D+1's own trim keeps %d records of the coin, want 3 (150, 199, 250)", len(need))
	}
	for _, l := range need {
		if !have[l] {
			t.Errorf("D's stored copy lacks a record D+1 keeps: %s", l)
		}
	}
	a, _ := os.ReadFile(filepath.Join(stored, "events.jsonl.zst"))
	b, _ := os.ReadFile(filepath.Join(k2u, "events.jsonl.zst"))
	if !bytes.Equal(a, b) {
		t.Error("the stored copy's events differ from the unit's: events must be complete")
	}
}

// OF-6 ruling 9: a planned unit overlapping one the day before stored must have been
// taken from the store; anything else refuses before a unit is read.
func TestCheckStored(t *testing.T) {
	plan := []unitSpec{{1046, 1, 4500}, {1046, 4501, 9000}, {1046, 9001, 13500}}
	dir := t.TempDir()
	w := func(name, body string) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte(body), 0o644)
		return p
	}
	stored, err := readUnitNames(w("stored", "1045/1-4500\n1046/1-4500\n1046/4501-9000\n"))
	if err != nil {
		t.Fatal(err)
	}
	taken, err := readUnitNames(w("taken", "1046/1-4500 data-day-2026-07-23-k3\n1046/4501-9000 data-day-2026-07-23-k3\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkStored(plan, stored, taken); err != nil {
		t.Errorf("every overlapping unit taken, yet refused: %v", err)
	}
	one, _ := readUnitNames(w("one", "1046/1-4500 data-day-2026-07-23-k3\n"))
	if err := checkStored(plan, stored, one); err == nil || !strings.Contains(err.Error(), "1046/4501-9000") {
		t.Errorf("a stored unit planned again but not taken passed: %v", err)
	}
	// an overlap that is not the same range (a drifted boundary) is refused too
	odd, _ := readUnitNames(w("odd", "1046/9000-9100\n"))
	if err := checkStored(plan, odd, taken); err == nil {
		t.Error("a partly overlapping stored unit passed")
	}
	none, _ := readUnitNames(w("none", ""))
	if err := checkStored(plan, none, none); err != nil || len(none) != 0 {
		t.Errorf("no stored units: %v", err)
	}
	for _, bad := range []string{"1046/1-4500x\n", "1046 1-4500\n", "1046/9-1\n"} {
		if _, err := readUnitNames(w("bad", bad)); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
