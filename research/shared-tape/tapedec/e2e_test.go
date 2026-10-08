package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The unchanged rpcscan binary reads one unit through the tee from a fake Helius that
// serves a testdata block (gzip, as Helius does; one block, since the testdata
// blocks are not parent-linked). Identity by construction: the
// tee's counters equal rpcscan's own, and the unit rebuilt from the spool (rpcscan
// rpc-unit -dir) has the same digest as the unit read live.
func TestEndToEndWithRpcscan(t *testing.T) {
	bin := buildRpcscan(t)
	slots := []uint64{452277009, 452277012, 452277901}
	up, _ := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		var body []byte
		switch req.Method {
		case "getBlocks":
			var from, to uint64
			json.Unmarshal(req.Params[0], &from)
			json.Unmarshal(req.Params[1], &to)
			var in []uint64
			for _, s := range slots {
				if s >= from && s <= to {
					in = append(in, s)
				}
			}
			b, _ := json.Marshal(in)
			body = []byte(fmt.Sprintf(`{"jsonrpc":"2.0","result":%s,"id":1}`, b))
		case "getBlock":
			var s uint64
			json.Unmarshal(req.Params[0], &s)
			raw, err := os.ReadFile(fmt.Sprintf("../../historical/rpcscan/testdata/rpc/%d.json.zst", s))
			if err != nil {
				body = []byte(`{"jsonrpc":"2.0","error":{"code":-32007,"message":"Slot skipped"},"id":1}`)
			} else {
				body, _ = zstdDec.DecodeAll(raw, nil)
			}
		default:
			body = []byte(`{"jsonrpc":"2.0","error":{"code":-32601,"message":"unknown"},"id":1}`)
		}
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		zw.Write(body)
		zw.Close()
		w.Write(buf.Bytes())
	})
	r := newRig(t, up.URL+"/", 25, 1000)
	out := t.TempDir()
	usage := filepath.Join(out, "usage.json")
	cmd := exec.Command(bin, "rpc-unit", "-out", out, "-epoch", "1046", "-from-slot", "452277009", "-to-slot", "452277011",
		"-helius-url", r.srv.URL+"/", "-rps", "25", "-conc", "4", "-max-credits", "100", "-usage-out", usage, "-sample", "0.05")
	cmd.Env = append(os.Environ(), "HELIUS_API_KEY=placeholder")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rpcscan: %v\n%s", err, b)
	} else if strings.Contains(string(b), canary) {
		t.Fatal("the key reached rpcscan's log")
	}
	var u struct {
		Credits       int64 `json:"credits"`
		Requests      int64 `json:"requests"`
		ResponseBytes int64 `json:"response_bytes"`
	}
	ub, _ := os.ReadFile(usage)
	if err := json.Unmarshal(ub, &u); err != nil {
		t.Fatal(err)
	}
	r.tee.writeLedger()
	l := r.tee.l
	if u.Credits != l.Attempts+l.LocalRefused || u.Requests != l.Usable || u.ResponseBytes != l.BytesDecoded || u.Requests != 2 {
		t.Fatalf("counters differ: rpcscan %+v, tee attempts %d refused %d usable %d bytes %d", u, l.Attempts, l.LocalRefused, l.Usable, l.BytesDecoded)
	}
	live := filepath.Join(out, "units", "1046", "452277009-452277011")
	replay := t.TempDir()
	if b, err := exec.Command(bin, "rpc-unit", "-out", replay, "-epoch", "1046", "-from-slot", "452277009", "-to-slot", "452277011",
		"-dir", filepath.Join(r.dir, "spool"), "-sample", "0.05").CombinedOutput(); err != nil {
		t.Fatalf("replay: %v\n%s", err, b)
	}
	dg := filepath.Join(t.TempDir(), "digest.json.zst")
	if b, err := exec.Command(bin, "digest", "-unit", live, "-o", dg).CombinedOutput(); err != nil {
		t.Fatalf("digest: %v\n%s", err, b)
	}
	if b, err := exec.Command(bin, "digest-compare", "-baseline", dg, "-unit", filepath.Join(replay, "units", "1046", "452277009-452277011")).CombinedOutput(); err != nil {
		t.Fatalf("the unit rebuilt from the spool differs from the live unit: %v\n%s", err, b)
	}
	// The decoder reads the same spool, verified against the tee's manifest.
	ds, err := decodeUnit(filepath.Join(r.dir, "spool"), 452277009, 452277011, "", filepath.Join(out, "research"), true, 2)
	if err != nil || ds.Blocks != 1 || ds.ManifestOK != 1 || ds.Counts.Txs == 0 {
		t.Fatalf("decode from the spool: %v %+v", err, ds)
	}
}

// A stopped tee ends rpcscan resumably (exit 75) at once, with nothing more forwarded.
func TestEndToEndStopIsResumable(t *testing.T) {
	bin := buildRpcscan(t)
	up, hits := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	r := newRig(t, up.URL+"/", 25, 1000)
	out := t.TempDir()
	cmd := exec.Command(bin, "rpc-unit", "-out", out, "-epoch", "1046", "-from-slot", "452277000", "-to-slot", "452277999",
		"-helius-url", r.srv.URL+"/", "-rps", "25", "-conc", "4", "-max-credits", "100", "-usage-out", filepath.Join(out, "u.json"))
	cmd.Env = append(os.Environ(), "HELIUS_API_KEY=placeholder")
	b, err := cmd.CombinedOutput()
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 75 {
		t.Fatalf("rpcscan exit %v, want 75\n%s", err, b)
	}
	if hits.Load() != 3 || r.tee.l.Stopped == "" {
		t.Fatalf("upstream hits %d (want 3), stopped %q", hits.Load(), r.tee.l.Stopped)
	}
}

func buildRpcscan(t *testing.T) string {
	bin, _ := filepath.Abs(filepath.Join(t.TempDir(), "zeroed-rpcscan"))
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = "../../historical/rpcscan"
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building rpcscan: %v\n%s", err, out)
	}
	return bin
}
