package main

// RPC getBlock blocks (DATA-2): a block as the JSON-RPC getBlock method returns it
// (encoding "base64", transactionDetails "full") becomes the same blockData the
// archive's CAR stream gives, with each transaction's meta re-encoded as the
// archive's protobuf TransactionStatusMeta. processBlock and processTx then run
// unchanged, so a unit read over RPC has exactly the rows of one read from the
// archive. Only the meta fields the scanner reads are re-encoded (leanmeta.go).

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/mr-tron/base58"
	"google.golang.org/protobuf/encoding/protowire"
)

type rpcBlockJSON struct {
	BlockTime    *int64          `json:"blockTime"`
	ParentSlot   *uint64         `json:"parentSlot"`
	Transactions []rpcTxJSON     `json:"transactions"`
	Signatures   json.RawMessage `json:"signatures"` // present only for other transactionDetails
}

type rpcTxJSON struct {
	Transaction json.RawMessage `json:"transaction"` // ["<base64>", "base64"]
	Meta        *rpcMetaJSON    `json:"meta"`
}

type rpcMetaJSON struct {
	Err                  json.RawMessage    `json:"err"`
	Fee                  uint64             `json:"fee"`
	PreBalances          []uint64           `json:"preBalances"`
	PostBalances         []uint64           `json:"postBalances"`
	InnerInstructions    *[]rpcInnerJSON    `json:"innerInstructions"` // null or absent: not recorded
	LogMessages          *[]string          `json:"logMessages"`       // null or absent: not recorded
	PreTokenBalances     []rpcTokenBalJSON  `json:"preTokenBalances"`
	PostTokenBalances    []rpcTokenBalJSON  `json:"postTokenBalances"`
	LoadedAddresses      *rpcLoadedAddrJSON `json:"loadedAddresses"`
	ComputeUnitsConsumed *uint64            `json:"computeUnitsConsumed"`
}

type rpcInnerJSON struct {
	Index        uint32 `json:"index"`
	Instructions []struct {
		ProgramIDIndex uint32   `json:"programIdIndex"`
		Accounts       []uint32 `json:"accounts"`
		Data           string   `json:"data"` // base58
		StackHeight    *uint32  `json:"stackHeight"`
	} `json:"instructions"`
}

type rpcTokenBalJSON struct {
	AccountIndex  uint32 `json:"accountIndex"`
	Mint          string `json:"mint"`
	Owner         string `json:"owner"`
	ProgramID     string `json:"programId"`
	UITokenAmount struct {
		Amount   string `json:"amount"`
		Decimals uint32 `json:"decimals"`
	} `json:"uiTokenAmount"`
}

type rpcLoadedAddrJSON struct {
	Writable []string `json:"writable"`
	Readonly []string `json:"readonly"`
}

// rpcBlock decodes a getBlock result for slot into blockData. A block without its
// block time, parent or full transaction details is refused: the unit could not
// match the archive's.
func rpcBlock(slot uint64, result []byte) (*blockData, error) {
	var bj rpcBlockJSON
	if err := json.Unmarshal(result, &bj); err != nil {
		return nil, fmt.Errorf("slot %d: block json: %w", slot, err)
	}
	if bj.BlockTime == nil {
		return nil, fmt.Errorf("slot %d: block has no blockTime", slot)
	}
	if bj.ParentSlot == nil {
		return nil, fmt.Errorf("slot %d: block has no parentSlot", slot)
	}
	if bj.Transactions == nil {
		return nil, fmt.Errorf("slot %d: block has no transactions array (transactionDetails must be full)", slot)
	}
	b := &blockData{slot: slot, parent: *bj.ParentSlot, blockTime: *bj.BlockTime, rpcTxs: make([]rpcTx, 0, len(bj.Transactions))}
	for i, t := range bj.Transactions {
		tx, err := rpcTxBytes(t.Transaction)
		if err != nil {
			return nil, fmt.Errorf("slot %d tx %d: %w", slot, i, err)
		}
		var meta []byte
		if t.Meta != nil {
			if meta, err = rpcMetaProto(t.Meta); err != nil {
				return nil, fmt.Errorf("slot %d tx %d: meta: %w", slot, i, err)
			}
		}
		b.rpcTxs = append(b.rpcTxs, rpcTx{tx: tx, meta: meta})
	}
	return b, nil
}

func rpcTxBytes(raw json.RawMessage) ([]byte, error) {
	var enc []string
	if err := json.Unmarshal(raw, &enc); err != nil || len(enc) != 2 || enc[1] != "base64" {
		return nil, fmt.Errorf("transaction is not [data, \"base64\"]")
	}
	return base64.StdEncoding.DecodeString(enc[0])
}

// rpcMetaProto re-encodes an RPC meta as the archive's protobuf TransactionStatusMeta
// (solana-storage-proto confirmed_block.proto; the field numbers parseMeta reads).
func rpcMetaProto(m *rpcMetaJSON) ([]byte, error) {
	var b []byte
	if len(m.Err) > 0 && !bytes.Equal(bytes.TrimSpace(m.Err), []byte("null")) {
		e, err := txErrorBincode(m.Err)
		if err != nil {
			return nil, err
		}
		var eb []byte
		eb = protowire.AppendTag(eb, 1, protowire.BytesType)
		eb = protowire.AppendBytes(eb, e)
		b = protowire.AppendTag(b, 1, protowire.BytesType)
		b = protowire.AppendBytes(b, eb)
	}
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, m.Fee)
	for _, f := range []struct {
		num protowire.Number
		v   []uint64
	}{{3, m.PreBalances}, {4, m.PostBalances}} {
		var p []byte
		for _, x := range f.v {
			p = protowire.AppendVarint(p, x)
		}
		b = protowire.AppendTag(b, f.num, protowire.BytesType)
		b = protowire.AppendBytes(b, p)
	}
	if m.InnerInstructions == nil {
		b = protowire.AppendTag(b, 10, protowire.VarintType)
		b = protowire.AppendVarint(b, 1)
	} else {
		for _, g := range *m.InnerInstructions {
			var gb []byte
			gb = protowire.AppendTag(gb, 1, protowire.VarintType)
			gb = protowire.AppendVarint(gb, uint64(g.Index))
			for _, ix := range g.Instructions {
				data, err := base58.Decode(ix.Data)
				if err != nil && ix.Data != "" {
					return nil, fmt.Errorf("inner instruction data: %w", err)
				}
				acc := make([]byte, len(ix.Accounts))
				for j, a := range ix.Accounts {
					if a > 255 {
						return nil, fmt.Errorf("inner instruction account index %d", a)
					}
					acc[j] = byte(a)
				}
				var ib []byte
				ib = protowire.AppendTag(ib, 1, protowire.VarintType)
				ib = protowire.AppendVarint(ib, uint64(ix.ProgramIDIndex))
				ib = protowire.AppendTag(ib, 2, protowire.BytesType)
				ib = protowire.AppendBytes(ib, acc)
				ib = protowire.AppendTag(ib, 3, protowire.BytesType)
				ib = protowire.AppendBytes(ib, data)
				if ix.StackHeight != nil {
					ib = protowire.AppendTag(ib, 4, protowire.VarintType)
					ib = protowire.AppendVarint(ib, uint64(*ix.StackHeight))
				}
				gb = protowire.AppendTag(gb, 2, protowire.BytesType)
				gb = protowire.AppendBytes(gb, ib)
			}
			b = protowire.AppendTag(b, 5, protowire.BytesType)
			b = protowire.AppendBytes(b, gb)
		}
	}
	if m.LogMessages == nil {
		b = protowire.AppendTag(b, 11, protowire.VarintType)
		b = protowire.AppendVarint(b, 1)
	} else {
		for _, l := range *m.LogMessages {
			b = protowire.AppendTag(b, 6, protowire.BytesType)
			b = protowire.AppendString(b, l)
		}
	}
	for _, f := range []struct {
		num protowire.Number
		v   []rpcTokenBalJSON
	}{{7, m.PreTokenBalances}, {8, m.PostTokenBalances}} {
		for _, tb := range f.v {
			var ub []byte
			ub = protowire.AppendTag(ub, 2, protowire.VarintType)
			ub = protowire.AppendVarint(ub, uint64(tb.UITokenAmount.Decimals))
			ub = protowire.AppendTag(ub, 3, protowire.BytesType)
			ub = protowire.AppendString(ub, tb.UITokenAmount.Amount)
			var t []byte
			t = protowire.AppendTag(t, 1, protowire.VarintType)
			t = protowire.AppendVarint(t, uint64(tb.AccountIndex))
			t = protowire.AppendTag(t, 2, protowire.BytesType)
			t = protowire.AppendString(t, tb.Mint)
			t = protowire.AppendTag(t, 3, protowire.BytesType)
			t = protowire.AppendBytes(t, ub)
			t = protowire.AppendTag(t, 4, protowire.BytesType)
			t = protowire.AppendString(t, tb.Owner)
			t = protowire.AppendTag(t, 5, protowire.BytesType)
			t = protowire.AppendString(t, tb.ProgramID)
			b = protowire.AppendTag(b, f.num, protowire.BytesType)
			b = protowire.AppendBytes(b, t)
		}
	}
	if m.LoadedAddresses != nil {
		for _, f := range []struct {
			num protowire.Number
			v   []string
		}{{12, m.LoadedAddresses.Writable}, {13, m.LoadedAddresses.Readonly}} {
			for _, a := range f.v {
				k, err := base58.Decode(a)
				if err != nil || len(k) != 32 {
					return nil, fmt.Errorf("loaded address %q", a)
				}
				b = protowire.AppendTag(b, f.num, protowire.BytesType)
				b = protowire.AppendBytes(b, k)
			}
		}
	}
	if m.ComputeUnitsConsumed != nil {
		b = protowire.AppendTag(b, 16, protowire.VarintType)
		b = protowire.AppendVarint(b, *m.ComputeUnitsConsumed)
	}
	return b, nil
}

// Variant order of TransactionError and InstructionError (anza-xyz/solana-sdk,
// transaction-error and instruction-error crates). Bincode writes the variant index as
// a little-endian u32, so the order is the format; both enums only ever append.
var txErrorVariants = []string{"AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound",
	"InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "InstructionError",
	"CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution",
	"SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion",
	"InvalidWritableAccount", "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks",
	"AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData",
	"InvalidAddressLookupTableIndex", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit",
	"WouldExceedAccountDataTotalLimit", "DuplicateInstruction", "InsufficientFundsForRent",
	"MaxLoadedAccountsDataSizeExceeded", "InvalidLoadedAccountsDataSizeLimit", "ResanitizationNeeded",
	"ProgramExecutionTemporarilyRestricted", "UnbalancedTransaction", "ProgramCacheHitMaxLimit", "CommitCancelled", "BailOut"}

var ixErrorVariants = []string{"GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData",
	"AccountDataTooSmall", "InsufficientFunds", "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized",
	"UninitializedAccount", "UnbalancedInstruction", "ModifiedProgramId", "ExternalAccountLamportSpend",
	"ExternalAccountDataModified", "ReadonlyLamportChange", "ReadonlyDataModified", "DuplicateAccountIndex",
	"ExecutableModified", "RentEpochModified", "NotEnoughAccountKeys", "AccountDataSizeChanged", "AccountNotExecutable",
	"AccountBorrowFailed", "AccountBorrowOutstanding", "DuplicateAccountOutOfSync", "Custom", "InvalidError",
	"ExecutableDataModified", "ExecutableLamportChange", "ExecutableAccountNotRentExempt", "UnsupportedProgramId",
	"CallDepth", "MissingAccount", "ReentrancyNotAllowed", "MaxSeedLengthExceeded", "InvalidSeeds", "InvalidRealloc",
	"ComputationalBudgetExceeded", "PrivilegeEscalation", "ProgramEnvironmentSetupFailure", "ProgramFailedToComplete",
	"ProgramFailedToCompile", "Immutable", "IncorrectAuthority", "BorshIoError", "AccountNotRentExempt",
	"InvalidAccountOwner", "ArithmeticOverflow", "UnsupportedSysvar", "IllegalOwner", "MaxAccountsDataAllocationsExceeded",
	"MaxAccountsExceeded", "MaxInstructionTraceLengthExceeded", "BuiltinProgramsMustConsumeComputeUnits", "BailOut"}

func variantIndex(list []string, name string) (uint32, bool) {
	for i, n := range list {
		if n == name {
			return uint32(i), true
		}
	}
	return 0, false
}

// txErrorBincode turns the RPC's JSON TransactionError (serde's externally tagged form:
// "AccountInUse", {"InstructionError":[2,{"Custom":6001}]}, {"DuplicateInstruction":1},
// {"InsufficientFundsForRent":{"account_index":3}}) into the bincode bytes the
// archive stores. An unknown variant or shape is an error, never a guess.
func txErrorBincode(raw json.RawMessage) ([]byte, error) {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		i, ok := variantIndex(txErrorVariants, name)
		if !ok || name == "InstructionError" || name == "DuplicateInstruction" || name == "InsufficientFundsForRent" || name == "ProgramExecutionTemporarilyRestricted" {
			return nil, fmt.Errorf("transaction error %q: not a known unit variant", name)
		}
		return binary.LittleEndian.AppendUint32(nil, i), nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || len(obj) != 1 {
		return nil, fmt.Errorf("transaction error %s: unknown shape", raw)
	}
	for k, v := range obj {
		i, ok := variantIndex(txErrorVariants, k)
		if !ok {
			return nil, fmt.Errorf("transaction error %q: unknown variant", k)
		}
		out := binary.LittleEndian.AppendUint32(nil, i)
		switch k {
		case "InstructionError":
			var pair []json.RawMessage
			if err := json.Unmarshal(v, &pair); err != nil || len(pair) != 2 {
				return nil, fmt.Errorf("InstructionError %s: not [index, error]", v)
			}
			idx, err := jsonU8(pair[0])
			if err != nil {
				return nil, fmt.Errorf("InstructionError index: %w", err)
			}
			ie, err := ixErrorBincode(pair[1])
			if err != nil {
				return nil, err
			}
			return append(append(out, idx), ie...), nil
		case "DuplicateInstruction":
			idx, err := jsonU8(v)
			if err != nil {
				return nil, fmt.Errorf("DuplicateInstruction: %w", err)
			}
			return append(out, idx), nil
		case "InsufficientFundsForRent", "ProgramExecutionTemporarilyRestricted":
			var f map[string]json.RawMessage
			if err := json.Unmarshal(v, &f); err != nil || len(f) != 1 || f["account_index"] == nil {
				return nil, fmt.Errorf("%s %s: not {account_index}", k, v)
			}
			idx, err := jsonU8(f["account_index"])
			if err != nil {
				return nil, fmt.Errorf("%s: %w", k, err)
			}
			return append(out, idx), nil
		}
		return nil, fmt.Errorf("transaction error %q: a unit variant with a value", k)
	}
	return nil, fmt.Errorf("transaction error %s: unknown shape", raw)
}

func ixErrorBincode(raw json.RawMessage) ([]byte, error) {
	var name string
	if json.Unmarshal(raw, &name) == nil {
		i, ok := variantIndex(ixErrorVariants, name)
		if !ok || name == "Custom" {
			return nil, fmt.Errorf("instruction error %q: not a known unit variant", name)
		}
		return binary.LittleEndian.AppendUint32(nil, i), nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || len(obj) != 1 {
		return nil, fmt.Errorf("instruction error %s: unknown shape", raw)
	}
	for k, v := range obj {
		i, ok := variantIndex(ixErrorVariants, k)
		if !ok {
			return nil, fmt.Errorf("instruction error %q: unknown variant", k)
		}
		out := binary.LittleEndian.AppendUint32(nil, i)
		switch k {
		case "Custom":
			var c uint32
			if err := json.Unmarshal(v, &c); err != nil {
				return nil, fmt.Errorf("Custom %s: not a u32", v)
			}
			return binary.LittleEndian.AppendUint32(out, c), nil
		case "BorshIoError":
			// Older validators carried a message (BorshIoError(String)): bincode writes a
			// u64 length and the bytes. Newer ones send the plain string "BorshIoError".
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return nil, fmt.Errorf("BorshIoError %s: not a string", v)
			}
			out = binary.LittleEndian.AppendUint64(out, uint64(len(s)))
			return append(out, s...), nil
		}
		return nil, fmt.Errorf("instruction error %q: a unit variant with a value", k)
	}
	return nil, fmt.Errorf("instruction error %s: unknown shape", raw)
}

func jsonU8(raw json.RawMessage) (byte, error) {
	n, err := strconv.ParseUint(string(bytes.TrimSpace(raw)), 10, 8)
	if err != nil {
		return 0, fmt.Errorf("%s is not a u8", raw)
	}
	return byte(n), nil
}
