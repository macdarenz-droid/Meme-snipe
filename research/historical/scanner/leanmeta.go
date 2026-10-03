package main

// Lean decoder for the protobuf TransactionStatusMeta stored in the archive. It fills
// only the fields the scanner reads and skips log messages, rewards and pre-token
// balances, which are most of the bytes. Field numbers follow
// solana-storage-proto proto (as vendored by yellowstone-faithful).

import (
	"errors"

	"google.golang.org/protobuf/encoding/protowire"
)

var errProto = errors.New("bad protobuf")

type TransactionStatusMeta struct {
	Err                     *TransactionError
	Fee                     uint64
	PreBalances             []uint64
	PostBalances            []uint64
	InnerInstructions       []*InnerInstructions
	PostTokenBalances       []*TokenBalance
	LoadedWritableAddresses [][]byte
	LoadedReadonlyAddresses [][]byte
	ComputeUnitsConsumed    *uint64
}

type TransactionError struct{ Err []byte }

type InnerInstructions struct {
	Index        uint32
	Instructions []*InnerInstruction
}

type InnerInstruction struct {
	ProgramIdIndex uint32
	Accounts       []byte
	Data           []byte
	StackHeight    *uint32
}

type TokenBalance struct {
	AccountIndex  uint32
	Mint          string
	Owner         string
	UiTokenAmount *UiTokenAmount
}

type UiTokenAmount struct {
	Amount   string
	Decimals uint32
}

func leanMeta(b []byte) (*TransactionStatusMeta, error) {
	m := &TransactionStatusMeta{}
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, errProto
		}
		b = b[n:]
		switch {
		case num == 1 && typ == protowire.BytesType: // err
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			e := &TransactionError{}
			for len(v) > 0 {
				fn, ft, k := protowire.ConsumeTag(v)
				if k < 0 {
					return nil, errProto
				}
				v = v[k:]
				if fn == 1 && ft == protowire.BytesType {
					x, k := protowire.ConsumeBytes(v)
					if k < 0 {
						return nil, errProto
					}
					e.Err = append([]byte(nil), x...)
					v = v[k:]
				} else {
					k := protowire.ConsumeFieldValue(fn, ft, v)
					if k < 0 {
						return nil, errProto
					}
					v = v[k:]
				}
			}
			m.Err = e
			b = b[n:]
		case num == 2 && typ == protowire.VarintType:
			v, n := protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, errProto
			}
			m.Fee = v
			b = b[n:]
		case (num == 3 || num == 4) && typ == protowire.BytesType: // packed balances
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			var out []uint64
			for len(v) > 0 {
				x, k := protowire.ConsumeVarint(v)
				if k < 0 {
					return nil, errProto
				}
				out = append(out, x)
				v = v[k:]
			}
			if num == 3 {
				m.PreBalances = out
			} else {
				m.PostBalances = out
			}
			b = b[n:]
		case (num == 3 || num == 4) && typ == protowire.VarintType: // unpacked element
			x, n := protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, errProto
			}
			if num == 3 {
				m.PreBalances = append(m.PreBalances, x)
			} else {
				m.PostBalances = append(m.PostBalances, x)
			}
			b = b[n:]
		case num == 5 && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			ii, err := leanInner(v)
			if err != nil {
				return nil, err
			}
			m.InnerInstructions = append(m.InnerInstructions, ii)
			b = b[n:]
		case num == 8 && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			tb, err := leanTokenBalance(v)
			if err != nil {
				return nil, err
			}
			m.PostTokenBalances = append(m.PostTokenBalances, tb)
			b = b[n:]
		case (num == 12 || num == 13) && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			k := append([]byte(nil), v...)
			if num == 12 {
				m.LoadedWritableAddresses = append(m.LoadedWritableAddresses, k)
			} else {
				m.LoadedReadonlyAddresses = append(m.LoadedReadonlyAddresses, k)
			}
			b = b[n:]
		case num == 16 && typ == protowire.VarintType:
			v, n := protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, errProto
			}
			m.ComputeUnitsConsumed = &v
			b = b[n:]
		default:
			n := protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return nil, errProto
			}
			b = b[n:]
		}
	}
	return m, nil
}

func leanInner(b []byte) (*InnerInstructions, error) {
	out := &InnerInstructions{}
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, errProto
		}
		b = b[n:]
		switch {
		case num == 1 && typ == protowire.VarintType:
			v, n := protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, errProto
			}
			out.Index = uint32(v)
			b = b[n:]
		case num == 2 && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			ix := &InnerInstruction{}
			for len(v) > 0 {
				fn, ft, k := protowire.ConsumeTag(v)
				if k < 0 {
					return nil, errProto
				}
				v = v[k:]
				switch {
				case fn == 1 && ft == protowire.VarintType:
					x, k := protowire.ConsumeVarint(v)
					if k < 0 {
						return nil, errProto
					}
					ix.ProgramIdIndex = uint32(x)
					v = v[k:]
				case (fn == 2 || fn == 3) && ft == protowire.BytesType:
					x, k := protowire.ConsumeBytes(v)
					if k < 0 {
						return nil, errProto
					}
					if fn == 2 {
						ix.Accounts = x
					} else {
						ix.Data = x
					}
					v = v[k:]
				case fn == 4 && ft == protowire.VarintType:
					x, k := protowire.ConsumeVarint(v)
					if k < 0 {
						return nil, errProto
					}
					h := uint32(x)
					ix.StackHeight = &h
					v = v[k:]
				default:
					k := protowire.ConsumeFieldValue(fn, ft, v)
					if k < 0 {
						return nil, errProto
					}
					v = v[k:]
				}
			}
			out.Instructions = append(out.Instructions, ix)
			b = b[n:]
		default:
			n := protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return nil, errProto
			}
			b = b[n:]
		}
	}
	return out, nil
}

func leanTokenBalance(b []byte) (*TokenBalance, error) {
	tb := &TokenBalance{}
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil, errProto
		}
		b = b[n:]
		switch {
		case num == 1 && typ == protowire.VarintType:
			v, n := protowire.ConsumeVarint(b)
			if n < 0 {
				return nil, errProto
			}
			tb.AccountIndex = uint32(v)
			b = b[n:]
		case (num == 2 || num == 4) && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			if num == 2 {
				tb.Mint = string(v)
			} else {
				tb.Owner = string(v)
			}
			b = b[n:]
		case num == 3 && typ == protowire.BytesType:
			v, n := protowire.ConsumeBytes(b)
			if n < 0 {
				return nil, errProto
			}
			ua := &UiTokenAmount{}
			for len(v) > 0 {
				fn, ft, k := protowire.ConsumeTag(v)
				if k < 0 {
					return nil, errProto
				}
				v = v[k:]
				if fn == 3 && ft == protowire.BytesType {
					x, k := protowire.ConsumeBytes(v)
					if k < 0 {
						return nil, errProto
					}
					ua.Amount = string(x)
					v = v[k:]
				} else if fn == 2 && ft == protowire.VarintType {
					x, k := protowire.ConsumeVarint(v)
					if k < 0 {
						return nil, errProto
					}
					ua.Decimals = uint32(x)
					v = v[k:]
				} else {
					k := protowire.ConsumeFieldValue(fn, ft, v)
					if k < 0 {
						return nil, errProto
					}
					v = v[k:]
				}
			}
			tb.UiTokenAmount = ua
			b = b[n:]
		default:
			n := protowire.ConsumeFieldValue(num, typ, b)
			if n < 0 {
				return nil, errProto
			}
			b = b[n:]
		}
	}
	return tb, nil
}
