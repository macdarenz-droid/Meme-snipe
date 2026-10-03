package main

import "testing"

// Real migrations from 2026-10-02 (CompletePumpAmmMigrationEvent: mint, pool); SOL
// curves migrate into a pool quoted in wrapped SOL.
func TestCanonicalPoolMatchesRealMigrations(t *testing.T) {
	for _, c := range [][2]string{
		{"8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump", "62jTpYEzdU7a8ayjgedtU7J43fqesgYRfJAi8rX7VgJS"},
		{"ADM3KSHNhACDLTGLPNKBDPAvjykrfCKHQAZdijHYPYWB", "GVhfB8GTUrFiRE2JX5MZ6rk621kSc6aCXr54kpNYitYz"},
		{"4Ysi462h1QxLPf3muyit5yeDKZ1rUavg4UzBJVqzpump", "FV1YksRzcNfYUwAuSCby2zk36m825veaxnVWybgQbvGd"},
	} {
		if got := canonicalPool(c[0], wsolMint); got != c[1] {
			t.Errorf("mint %s: canonical pool %s, migration created %s", c[0], got, c[1])
		}
		if !isCanonicalPool(c[1], c[0], wsolMint) {
			t.Errorf("pool %s not recognised as canonical", c[1])
		}
	}
	if isCanonicalPool("62jTpYEzdU7a8ayjgedtU7J43fqesgYRfJAi8rX7VgJS", "ADM3KSHNhACDLTGLPNKBDPAvjykrfCKHQAZdijHYPYWB", wsolMint) {
		t.Errorf("another mint's pool accepted as canonical")
	}
}
