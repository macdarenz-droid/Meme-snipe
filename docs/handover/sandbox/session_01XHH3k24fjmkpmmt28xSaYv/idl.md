> ## Documentation Index
> Fetch the complete documentation index at: https://docs.dune.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Solana Decoded Tables

> Decoded Solana program data using Interface Description Language (IDL) definitions — human-readable instruction and event data for DeFi protocols, NFT marketplaces, and any Solana program. The fastest path from raw bytes to actionable analytics.

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

<Note>
  **IDL Submissions**

  You can submit any program for decoding that has a public IDL or GitHub repo (Anchor, native, and system are supported), for example [Jupiter on Solscan](https://solscan.io/account/JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB#anchorProgramIDL). Use [dune.com/contracts/new](https://dune.com/contracts/new) and select Solana, or see [Solana program decoding submissions](/web-app/decoding/solana-decoding-submissions) for the full flow and IDL requirements.
</Note>

Decoded tables inherit all of the columns from [`instruction_calls`](/data-catalog/solana/instruction-calls), so you can refer there for most of the types. We only add columns for each argument in the function call `data` and each account that was required to be in `account_arguments`. **These only decode from instructions, and not inner instructions.**

## Example IDL Decoded Walkthrough

Using an IDL, we decode the function data arguments and the required account arguments. Let's look at an example using Whirlpool - normally you can find the IDL [on Solscan](https://solscan.io/account/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc#anchorProgramIDL), but this time we had to dig [into the project repo](https://github.com/orca-so/whirlpools/blob/main/sdk/src/artifacts/whirlpool.json). IDLs are like ABIs on Ethereum, except they are created from the [Anchor lang](https://www.anchor-lang.com/) project instead of natively from every program.

[Here's a transaction](https://solscan.io/tx/TGDKvM2E8mWYcsG2JBnb9axFcyEcKqs7yZLyayCmrV8p8SSdA8r9SLEC7EHQ4mcXQXpczEyaCBXvnmEi9yoKVJ9) of a pool (a trading pair) being initialized.

You can see that the instruction data is decoded in "Bumps", "TickSpacing", and "InitialSqrtPrice" on the explorer. We have the same thing in a SQL table! You can also see all the account names are labelled clearly as well with an `account_` prefix. Raw table inherited columns like `tx_id`, `block_time`, `tx_index` get a `call_` prefix.

The main thing to note is that we've exploded outer and inner instructions, where the index will match what you see on explorers. This example call is at the outer instruction level, so the inner instruction index is null. For Whirlpool swaps, often times it will happen in inner\_instructions so then the top level outer instruction is inherited into the `call_outer_instruction_index` and the inner index is `call_inner_instruction_index` (same idea with the `call_outer_executing_account` and `call_inner_executing_account`)

<div>
  <DuneEmbed qID="2352049" vID="3851391" height={300} />
</div>

Try it out for yourself in [this query](https://dune.com/queries/2352049/) below:

```sql theme={null}
SELECT * FROM whirlpool_solana.whirlpool_call_initializePool
WHERE call_tx_id = 'TGDKvM2E8mWYcsG2JBnb9axFcyEcKqs7yZLyayCmrV8p8SSdA8r9SLEC7EHQ4mcXQXpczEyaCBXvnmEi9yoKVJ9'
```

The table name follows the pattern:\
`<namespace>_solana.<programName>_call_<instructionName>`

We already have many of the top projects decoded, so go explore!


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.