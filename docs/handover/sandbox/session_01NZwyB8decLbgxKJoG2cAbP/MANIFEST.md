# Sandbox manifest: session_01NZwyB8decLbgxKJoG2cAbP (reviewer)

Everything I produced outside the repo checkout. Paths are relative to the scratch root `/tmp/claude-0/-home-user-Meme-snipe/<transcript id>/`.

- `scratchpad/mut*.sh`: the mutation scripts behind my verdicts. Each one copies a source file, applies a one-line replacement, runs the named vitest files and restores the copy. mut.sh/mut2.sh/mut3*.sh: #45 SEED-1. mut4–mut6: #70/#71. mut7–mut9: #90/#71. mut10: #99. The last block in mut.sh is #125. Run them from the repo root on the PR head.
- `scratchpad/pid.mjs`: a fake process.pid for the lock tests (`NODE_OPTIONS="--import ./pid.mjs" FAKE_PID=n`).
- `tasks/*.output`: logs of background runs (mutant results and `pnpm check` summaries).

| Path | Size (bytes) | sha256 | Status |
|---|---|---|---|
| scratchpad/mut.sh | 2167 | 2e52a9ebb98c2a7b051b4db04ccd1448a6af16f8e281b5e5911ea3490ce04353 | committed |
| scratchpad/mut10.sh | 1255 | 8ba22c0cd8d4bc23af05e877c20e267bc5b33a6b9fb03b7862a69ee0200d4039 | committed |
| scratchpad/mut2.sh | 1743 | 5dc0084d0cf4b759d7d11e32e7e34b229ff1f9832eaa172021da3a6b16bc494f | committed |
| scratchpad/mut3.sh | 1794 | 381b8413d92f13946e488b125f0cda73b37e8d1b1c0346ce599bc3bae0e6c7d4 | committed |
| scratchpad/mut3b.sh | 1011 | c822753d525898d26f6a0c4e7955741e28ef50a2a8702cf65867f527cb8c850f | committed |
| scratchpad/mut4.sh | 1672 | 96832f5c95990b18de193d31cad6e383f5a95a27b6572e9fd0cb174045d4de57 | committed |
| scratchpad/mut5.sh | 1083 | 5d8ced5b8a6345749eb98b26e66becba29993e68cf906adcb94026fb0ec67a78 | committed |
| scratchpad/mut6.sh | 1290 | 0e1be37e3895267f554555b94a6e06e3e23a882bcd4b64db89d4508325eddb67 | committed |
| scratchpad/mut7.sh | 1146 | b365f19e3c1f259eb44eedca686c6ef0bcb9c5614db0fc954bbf9e216320fa24 | committed |
| scratchpad/mut8.sh | 1601 | b72e6e61174561075577089a624070a51c0ea1e0084d626f52f007055731cbd0 | committed |
| scratchpad/mut9.sh | 1037 | b48f8ac3f77ae8c89b5b47db9c3c43541e130c1e0e79716a25bd3ed34cf34aa5 | committed |
| scratchpad/pid.mjs | 100 | df08aa9c7a0a033e75b0b52eaf9872e3f856c5f9b90139f06bd26c3a5043fb04 | committed |
| tasks/b4dq8x6e1.output | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | committed |
| tasks/b5p5217sk.output | 350 | 1fb376e121f8370e8b91e8439aaf2f7680999cebaae9cf31884576febf413f04 | committed |
| tasks/bchcrlrnb.output | 300 | baecc3284e30eadbf3948fc7c838b9263f3974b38c9d867475d55652729c9430 | committed |
| tasks/bpiiwfblv.output | 86 | dba7eaf19876e9b8041055e1f2dc87888e163ccfbfcdc457f991481fbf09e8d9 | committed |
| tasks/bqk6or3z4.output | 89 | 35997cbd6480b6b80810b0967eb721b82f090eaf959d3374779f9efadaedbb96 | committed |
| tasks/bz2o5jjsl.output | 579 | 06bf24811e2e74ed894396a28e5f570996d21e53d45c5bf75b8292656b7757a8 | committed |
| /tmp/base_state.ts | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | excluded: empty probe file |
| /tmp/mut.bak | 14543 | - | excluded: a backup copy of the last mutated repo source file, which is identical to the repo |
| /tmp/chain-volume-*, /tmp/* other test dirs | - | - | excluded: temporary dirs created by the test suite; `pnpm check` creates them again |
| repo node_modules, build outputs | - | - | excluded: `pnpm install --frozen-lockfile` |
| session transcript under the harness's project dir | - | - | excluded: managed by the harness, not inspected for this manifest; may contain tool output, so it is not published |
