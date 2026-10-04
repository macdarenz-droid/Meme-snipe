> ## Documentation Index
> Fetch the complete documentation index at: https://docs.dune.com/llms.txt
> Use this file to discover all available pages before exploring further.

# dex_solana.trades

> The `dex_solana.trades` table captures detailed data on decentralized exchange (DEX) trades on the Solana blockchain, recording all raw trade events across various protocols.

export const TableSample = ({tableName, tableSchema}) => <>
    <div className="hidden dark:block">
      <iframe src={`https://dune.com/embeds/3419983/5785629?table_schema_t6f0df=${tableSchema}&table_name_t6f0df=${tableName}&darkMode=true`} style={{
  width: '100%',
  height: '500px',
  border: 'none',
  marginTop: '10px'
}} />
    </div>
    <div className="dark:hidden">
      <iframe src={`https://dune.com/embeds/3419983/5785629?table_schema_t6f0df=${tableSchema}&table_name_t6f0df=${tableName}`} style={{
  width: '100%',
  height: '500px',
  border: 'none',
  marginTop: '10px'
}} />
    </div>
  </>;

export const DuneEmbed = ({qID, vID, height = '500px'}) => <>
    <div className="hidden dark:block">
      <iframe src={`https://dune.com/embeds/${qID}/${vID}?darkMode=true`} style={{
  width: '100%',
  height,
  border: 'none',
  marginTop: '10px'
}}></iframe>
    </div>
    <div className="dark:hidden">
      <iframe src={`https://dune.com/embeds/${qID}/${vID}`} style={{
  width: '100%',
  height,
  border: 'none',
  marginTop: '10px'
}}></iframe>
    </div>
  </>;

## Table Description

The `dex_solana.trades` table captures detailed data on trades executed via decentralized exchanges (DEXs) on the Solana blockchain. This table records all raw trade events that occur across all liquidity pools on Solana DEXs, providing a comprehensive view of the entire trade execution process and detailing the specific paths and liquidity sources utilized.

## Functional Overview

The `dex_solana.trades` table provides an in-depth view of trades on Solana-based decentralized exchanges like Raydium, Orca, or Serum. This table includes entries for each segment of a trade that passes through different liquidity pools, as well as single-step trades. For example, a user may initiate a trade to swap USDC for RAY. If this trade is executed through multiple liquidity pools, such as USDC-SOL and SOL-RAY, the `dex_solana.trades` table will record each segment of the trade as a separate entry. Conversely, a single-step trade, such as directly swapping USDC for SOL, will be recorded as a single entry.

This detailed approach allows for granular analysis of trade execution paths on Solana, enabling users to:

* **Analyze Liquidity Sources**: Understand which liquidity pools are used and how they interact in both single-step and multi-step trades on Solana DEXs.
* **Track Trade Execution Paths**: Follow the exact route a trade takes across different Solana DEXs and liquidity pools.
* **Assess Slippage and Execution Quality**: Evaluate the impact of each step on the overall trade execution, including slippage and price changes in the Solana ecosystem.
* **Monitor Market Dynamics**: Gain insights into the behavior and dynamics of different liquidity pools and DEXs over time on the Solana blockchain.

By providing comprehensive trade details, the `dex_solana.trades` table supports advanced analytics and research into DEX trading behavior and liquidity management specific to the Solana ecosystem.

## Coverage

<div>
  <DuneEmbed qID={4009956} vID={6750980} height={300} />
</div>

## Table Schema

| Column | Type | Description |
| - | - | - |
| `blockchain` | `VARCHAR` | Blockchain (always `solana`) |
| `project` | `VARCHAR` | Name of the DEX protocol |
| `version` | `INTEGER` | Version of the contract |
| `version_name` | `VARCHAR` | Version name |
| `block_month` | `DATE` | UTC event block month (partition key) |
| `block_date` | `DATE` | UTC event block date |
| `block_time` | `TIMESTAMP` | UTC event block time |
| `block_slot` | `BIGINT` | Block slot number |
| `trade_source` | `VARCHAR` | Whether the trade was a direct call or routed through an aggregator like Jupiter |
| `token_bought_symbol` | `VARCHAR` | Symbol of the token bought |
| `token_sold_symbol` | `VARCHAR` | Symbol of the token sold |
| `token_pair` | `VARCHAR` | Token symbol pair |
| `token_bought_amount` | `DOUBLE` | Amount of the token bought in display units |
| `token_sold_amount` | `DOUBLE` | Amount of the token sold in display units |
| `token_bought_amount_raw` | `UINT256` | Raw amount of the token bought |
| `token_sold_amount_raw` | `UINT256` | Raw amount of the token sold |
| `amount_usd` | `DOUBLE` | USD value of the trade at time of execution |
| `fee_tier` | `DOUBLE` | Pool fee tier (fee percentage) |
| `fee_usd` | `DOUBLE` | Fee paid on swap in USD |
| `token_bought_mint_address` | `VARCHAR` | Mint address of the token bought |
| `token_sold_mint_address` | `VARCHAR` | Mint address of the token sold |
| `token_bought_vault` | `VARCHAR` | Token vault address for the pool, of the token bought |
| `token_sold_vault` | `VARCHAR` | Token vault address for the pool, of the token sold |
| `project_program_id` | `VARCHAR` | Pool program ID of the DEX project |
| `project_main_id` | `VARCHAR` | Project main ID |
| `trader_id` | `VARCHAR` | Address of the trader who initiated the swap |
| `tx_id` | `VARCHAR` | Transaction ID |
| `outer_instruction_index` | `INTEGER` | Top-level instruction index for the transaction |
| `inner_instruction_index` | `INTEGER` | Inner instruction index for the transaction |
| `tx_index` | `INTEGER` | Index of the transaction in the block slot |

## Table Sample

<TableSample tableSchema="dex_solana" tableName="trades" />

## Examples

The following query demonstrates how to use the `dex_solana.trades` table to calculate the total volume of trades on a weekly basis for Solana DEXs.

```sql theme={null}
SELECT
  DATE_TRUNC('week', block_time) AS week,
  SUM(CAST(amount_usd AS DOUBLE)) AS usd_volume
FROM
  dex_solana.trades
WHERE
  block_time > NOW() - INTERVAL '365' day
GROUP BY 1
ORDER BY 1
```

<CardGroup cols={1}>
  <Card title="DEX Dashboard" icon="chart-waterfall" href="https://dune.com/hagaetc/dex-metrics">
    For more examples of how to use the `dex_solana.trades` table, check out this dashboard.
  </Card>
</CardGroup>


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.