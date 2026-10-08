package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const canary = "CANARY-KEY-7f3a9c"

// upstream fakes Helius: it checks the key, then answers with fn.
func upstream(t *testing.T, fn func(w http.ResponseWriter, req rpcReq)) (*httptest.Server, *atomic.Int64) {
	var n atomic.Int64
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		if r.URL.Query().Get("api-key") != canary {
			http.Error(w, "no key", http.StatusUnauthorized)
			return
		}
		var req rpcReq
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &req)
		fn(w, req)
	}))
	t.Cleanup(s.Close)
	return s, &n
}

type teeRig struct {
	tee    *tee
	srv    *httptest.Server
	dir    string
	logBuf *bytes.Buffer
}

var logMu sync.Mutex

func newRig(t *testing.T, up string, rps float64, maxCredits int64) *teeRig {
	dir := t.TempDir()
	tt, err := newTee(up, canary, rps, 0, 0, maxCredits, filepath.Join(dir, "spool"), filepath.Join(dir, "ledger.json"), filepath.Join(dir, "STOP"))
	if err != nil {
		t.Fatal(err)
	}
	buf := &bytes.Buffer{}
	logMu.Lock()
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr); logMu.Unlock() })
	srv := httptest.NewServer(tt)
	t.Cleanup(srv.Close)
	return &teeRig{tee: tt, srv: srv, dir: dir, logBuf: buf}
}

func post(t *testing.T, c *http.Client, url, body string, hdr map[string]string) (*http.Response, []byte) {
	req, _ := http.NewRequest(http.MethodPost, url+"/?api-key=placeholder", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, b
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	w.Write(b)
	w.Close()
	return buf.Bytes()
}

func testBlock(t *testing.T) []byte {
	raw, err := os.ReadFile("../../historical/rpcscan/testdata/rpc/452277009.json.zst")
	if err != nil {
		t.Fatal(err)
	}
	b, err := zstdDec.DecodeAll(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Bodies pass unchanged (sha256), compressed or not; the spool holds the decompressed
// body and the manifest its sha256.
func TestTeeBodiesUnchanged(t *testing.T) {
	block := testBlock(t)
	zipped := gz(block)
	up, _ := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream", "yes")
		if req.Method == "getBlock" {
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(zipped)
			return
		}
		w.Write([]byte(`{"jsonrpc":"2.0","result":[1,2,3],"id":1}`))
	})
	r := newRig(t, up.URL+"/", 25, 100)
	// A client that asks for gzip itself gets the wire bytes unchanged.
	resp, b := post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[452277009,{}]}`, map[string]string{"Accept-Encoding": "gzip"})
	if resp.StatusCode != 200 || sha256.Sum256(b) != sha256.Sum256(zipped) || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("wire body or headers changed: status %d", resp.StatusCode)
	}
	// Go's default client (as rpcscan) decompresses transparently: same decoded body.
	resp, b = post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":2,"method":"getBlock","params":[452277009,{}]}`, nil)
	if resp.StatusCode != 200 || !bytes.Equal(b, block) {
		t.Fatal("decoded body changed")
	}
	_, b = post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":3,"method":"getBlocks","params":[1,3]}`, nil)
	if string(b) != `{"jsonrpc":"2.0","result":[1,2,3],"id":1}` {
		t.Fatalf("plain body changed: %s", b)
	}
	sp, err := readSpooled(filepath.Join(r.dir, "spool"), 452277009)
	if err != nil || !bytes.Equal(sp, block) {
		t.Fatal("spooled block differs from the upstream body")
	}
	m, err := readManifest(filepath.Join(r.dir, "spool"))
	sum := sha256.Sum256(block)
	if err != nil || m[452277009] != fmt.Sprintf("%x", sum) {
		t.Fatal("manifest sha256 wrong")
	}
	r.tee.writeLedger()
	l := r.tee.l
	if l.Attempts != 3 || l.Usable != 3 || l.Methods["getBlock"].Attempts != 2 || l.Methods["getBlocks"].Attempts != 1 ||
		l.BytesDecoded != int64(2*len(block)+len(`{"jsonrpc":"2.0","result":[1,2,3],"id":1}`)) || l.Methods["getBlock"].Spooled != 2 {
		t.Fatalf("ledger: %+v", l)
	}
}

// The key never appears in any log, ledger, stop file, spool file or returned header,
// including on upstream errors.
func TestTeeCanaryNeverWritten(t *testing.T) {
	up, _ := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	r := newRig(t, up.URL+"/", 25, 100)
	var hdrs []string
	for i := 0; i < 4; i++ {
		resp, b := post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[5]}`, nil)
		hdrs = append(hdrs, fmt.Sprint(resp.Header), string(b))
	}
	// An upstream that is down: the client error carries the URL, which must be dropped.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	r2 := newRig2(t, deadURL+"/", r.logBuf)
	resp, b := post(t, &http.Client{}, r2.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[5]}`, nil)
	hdrs = append(hdrs, fmt.Sprint(resp.Header), string(b))
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("dead upstream: status %d", resp.StatusCode)
	}
	r.tee.writeLedger()
	r2.tee.writeLedger()
	all := r.logBuf.String() + strings.Join(hdrs, "\n")
	for _, d := range []string{r.dir, r2.dir} {
		filepath.Walk(d, func(p string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() {
				b, _ := os.ReadFile(p)
				all += string(b)
			}
			return nil
		})
	}
	if strings.Contains(all, canary) || strings.Contains(all, "api-key="+canary) {
		t.Fatal("the key was written somewhere")
	}
	if !strings.Contains(r.logBuf.String(), "upstream error") {
		t.Fatal("the dead-upstream path was not exercised")
	}
}

func newRig2(t *testing.T, up string, buf *bytes.Buffer) *teeRig {
	dir := t.TempDir()
	tt, err := newTee(up, canary, 25, 0, 0, 100, filepath.Join(dir, "spool"), filepath.Join(dir, "ledger.json"), filepath.Join(dir, "STOP"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(tt)
	t.Cleanup(srv.Close)
	return &teeRig{tee: tt, srv: srv, dir: dir, logBuf: buf}
}

// Three consecutive 429 or 403 answers stop the tee: the next request is answered
// locally (429, Retry-After 3600) and never forwarded; a success in between resets
// the streak; Retry-After pauses forwarding.
func TestTeeThreeFailureStop(t *testing.T) {
	var script atomic.Value
	script.Store([]int{429, 200, 403, 429, 429})
	var i atomic.Int64
	up, hits := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		s := script.Load().([]int)
		k := int(i.Add(1)) - 1
		code := 200
		if k < len(s) {
			code = s[k]
		}
		if code != 200 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(code)
			return
		}
		w.Write([]byte(`{"jsonrpc":"2.0","result":1,"id":1}`))
	})
	r := newRig(t, up.URL+"/", 25, 100)
	c := &http.Client{}
	t0 := time.Now()
	var codes []int
	for k := 0; k < 6; k++ {
		resp, _ := post(t, c, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getSlot"}`, nil)
		codes = append(codes, resp.StatusCode)
		if k == 5 && resp.Header.Get("Retry-After") != "3600" {
			t.Fatal("the local refusal lacks Retry-After 3600")
		}
	}
	want := []int{429, 200, 403, 429, 429, 429}
	if fmt.Sprint(codes) != fmt.Sprint(want) {
		t.Fatalf("codes %v, want %v", codes, want)
	}
	if hits.Load() != 5 {
		t.Fatalf("upstream hit %d times, want 5 (the 6th answered locally)", hits.Load())
	}
	if time.Since(t0) < 3*time.Second {
		t.Fatal("Retry-After was not honoured between forwards")
	}
	stop, err := os.ReadFile(filepath.Join(r.dir, "STOP"))
	if err != nil || !strings.Contains(string(stop), "3 consecutive 429 or 403") {
		t.Fatalf("stop file: %q %v", stop, err)
	}
	if r.tee.l.LocalRefused != 1 || r.tee.l.Attempts != 5 || r.tee.l.HTTP429 != 3 || r.tee.l.HTTP403 != 1 {
		t.Fatalf("ledger: %+v", r.tee.l)
	}
}

// An RPC rate-limit error inside an HTTP 200 counts toward the streak, as rpcscan
// treats it as a 429.
func TestTeeRPC429InBody(t *testing.T) {
	up, _ := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"},"id":1}`))
	})
	r := newRig(t, up.URL+"/", 25, 100)
	for k := 0; k < 3; k++ {
		post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getSlot"}`, nil)
	}
	if r.tee.l.Stopped == "" || r.tee.l.Usable != 0 || r.tee.l.Methods["getSlot"].RPC429 != 3 {
		t.Fatalf("ledger: %+v", r.tee.l)
	}
}

// The credit cap stops the tee resumably: nothing past the cap is forwarded.
func TestTeeCreditCap(t *testing.T) {
	up, hits := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Write([]byte(`{"jsonrpc":"2.0","result":1,"id":1}`))
	})
	r := newRig(t, up.URL+"/", 25, 2)
	var codes []int
	for k := 0; k < 4; k++ {
		resp, _ := post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getSlot"}`, nil)
		codes = append(codes, resp.StatusCode)
	}
	if fmt.Sprint(codes) != "[200 200 429 429]" || hits.Load() != 2 {
		t.Fatalf("codes %v, upstream hits %d", codes, hits.Load())
	}
	stop, _ := os.ReadFile(filepath.Join(r.dir, "STOP"))
	if !strings.Contains(string(stop), "credit cap 2 reached") || r.tee.l.LocalRefused != 2 {
		t.Fatalf("stop %q, ledger %+v", stop, r.tee.l)
	}
}

// The free-disk floor stops the tee before a request is forwarded.
func TestTeeDiskFloor(t *testing.T) {
	up, hits := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Write([]byte(`{"jsonrpc":"2.0","result":1,"id":1}`))
	})
	r := newRig(t, up.URL+"/", 25, 100)
	r.tee.freeFn = func(string) (uint64, error) { return 7 << 30, nil }
	resp, _ := post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getSlot"}`, nil)
	if resp.StatusCode != 429 || hits.Load() != 0 || !strings.Contains(r.tee.l.Stopped, "free disk") {
		t.Fatalf("status %d, hits %d, stopped %q", resp.StatusCode, hits.Load(), r.tee.l.Stopped)
	}
}

// The pace holds forwards to -rps, and the rate cap of 25 a second is refused above.
func TestTeePaceAndCap(t *testing.T) {
	if _, err := newTee("http://x/", canary, 26, 0, 0, 1, t.TempDir(), "l", "s"); err == nil {
		t.Fatal("26 a second accepted")
	}
	if _, err := newTee("http://x/", canary, 10, 30, 5, 1, t.TempDir(), "l", "s"); err == nil {
		t.Fatal("-rps2 30 accepted")
	}
	if _, err := newTee("http://x/", "", 10, 0, 0, 1, t.TempDir(), "l", "s"); err == nil {
		t.Fatal("no key accepted")
	}
	up, _ := upstream(t, func(w http.ResponseWriter, req rpcReq) {
		w.Write([]byte(`{"jsonrpc":"2.0","result":1,"id":1}`))
	})
	r := newRig(t, up.URL+"/", 10, 100)
	t0 := time.Now()
	var wg sync.WaitGroup
	for k := 0; k < 11; k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			post(t, &http.Client{}, r.srv.URL, `{"jsonrpc":"2.0","id":1,"method":"getSlot"}`, nil)
		}()
	}
	wg.Wait()
	if el := time.Since(t0); el < 950*time.Millisecond {
		t.Fatalf("11 requests at 10 a second took %s", el)
	}
}
