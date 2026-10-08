package main

// zeroed-tapedec: the shared tape's loopback tee and research decoder
// (research/SHARED_TAPE_PLAN.md). Every scanner source here is a symlink to
// ../../historical/scanner (and rpcblock.go to ../../historical/rpcscan), so the
// decoders are the core's files, used read-only; this folder is outside both trees,
// so the core units' revision does not change.
//
//   zeroed-tapedec tee -rps 10 -max-credits N -spool DIR -ledger FILE -stop-file FILE -addr-file FILE
//   zeroed-tapedec decode -spool DIR -from-slot S -to-slot S -day YYYY-MM-DD -out DIR

import (
	"fmt"
	"os"
)

// scannerRevision is set at build time (the folder's git tree); the scanner's unit
// stats read it.
var scannerRevision = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: zeroed-tapedec tee|decode ...")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "tee":
		os.Exit(runTee(os.Args[2:]))
	case "decode":
		os.Exit(runDecode(os.Args[2:]))
	}
	fmt.Fprintln(os.Stderr, "usage: zeroed-tapedec tee|decode ...")
	os.Exit(2)
}
