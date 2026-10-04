> ## Documentation Index
> Fetch the complete documentation index at: https://docs.dune.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Solana Overview

> Solana raw and decoded data on Dune — transactions, blocks, instructions, account activity, rewards, and vote data for trading, compliance, wallet engineering, and research.

Dune indexes the full Solana blockchain — every transaction, block, instruction call, and account balance change. As a non-EVM chain, Solana's [account-based architecture](https://solana.com/docs/core/accounts) produces data that looks fundamentally different from Ethereum. Programs, accounts, and instructions replace contracts, addresses, and function calls.

Raw data tables give you direct access to transactions, pre/post-balances, and instruction data. For most analytical workflows, however, you'll get faster results and cleaner queries using [decoded data](/data-catalog/solana/idl-tables) from IDL decoding — Solana's equivalent of ABI decoding on EVM chains.

### Available Tables

<CardGroup cols={2}>
  <Card title="Account Activity" icon="user-check" href="/data-catalog/solana/account-activity">
    Pre/post-balance changes for every account touched in a transaction — track wallet activity, treasury flows, and balance movements
  </Card>

  <Card title="Blocks" icon="cubes" href="/data-catalog/solana/blocks">
    Slot-level block data including leader identity, rewards, and timing — analyze network throughput and validator performance
  </Card>

  <Card title="IDL Tables (Decoded)" icon="code" href="/data-catalog/solana/idl-tables">
    Human-readable decoded program data from IDL definitions — the fastest path to protocol-specific analytics
  </Card>

  <Card title="Instruction Calls" icon="terminal" href="/data-catalog/solana/instruction-calls">
    Every program instruction with decoded arguments and inner calls — trace program execution and cross-program invocations
  </Card>

  <Card title="Rewards" icon="gift" href="/data-catalog/solana/rewards">
    Validator and staker reward distributions — calculate APY, track staking returns, and analyze validator economics
  </Card>

  <Card title="Transactions" icon="message-arrow-up" href="/data-catalog/solana/transactions">
    Complete transaction records with signatures, signers, fees, and execution status — the foundation for on-chain analysis
  </Card>

  <Card title="Vote Transactions" icon="check-to-slot" href="/data-catalog/solana/vote-transactions">
    Validator consensus votes — monitor network health, validator participation, and consensus patterns
  </Card>
</CardGroup>

***

## Resources

<CardGroup cols={1}>
  <Card title="Full Solana Data Guide" icon="map" href="https://read.cryptodatabytes.com/p/starter-guide-to-solana-data-analysis">
    In-depth walkthrough for getting started with Solana data analysis on Dune, covering raw tables, decoded data, and common query patterns.
  </Card>
</CardGroup>


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.