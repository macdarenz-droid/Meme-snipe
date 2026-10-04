# Sandbox manifest: session_01GDycboQzFrFWxVniy6B6Ps (FACTS-1 builder)

Everything I built is in the repo, on the merged PRs and on open #106 (`claude/facts-1f`, d06ebdb). The files below are throwaway working files: check logs, one debug probe and background-task outputs. They hold no research data, measurements or results beyond what the session notes give.

| Path | Size (bytes) | sha256 | Status |
|---|---|---|---|
| scratchpad/check.log | 6256 | f89f9031c892b8d7f0cf91d0dbba7b0a92c474f4c6e158c94d861db727a74897 | committed |
| scratchpad/k.test.ts | 673 | 4d8c14f1dcafafeb9494c85ad188795212b9c332feb4cfd85c0c195d9200934c | committed |
| tasks/b03ao59e7.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/b2cf8582z.output | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | committed |
| tasks/b2jz1prmc.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/b3ataswm3.output | 61 | 04855e97b79e8cc192ce6c35b4230ca5c16774f297de9265d6a8ef0fdb6119aa | committed |
| tasks/b4vxg3ib8.output | 116 | 058cefcff363c931cd1a95169e0c3cd5df37c0a7c9d2e7e1d9a4e811821fae0a | committed |
| tasks/b5ipi1hvo.output | 163 | 563b29a852c03ac2ac1c2c83179cbe3204b5b0ce59e280347784f4e3a7b1458c | committed |
| tasks/b6xhgrzss.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/b8su3yz86.output | 571 | 9b7b9161bbed4100617795f08b38685d5a3040414b54cce4b7917b5118e0a1d6 | committed |
| tasks/b8ylz943l.output | 61 | 363475a804121c6b73dfc3f12074766148dc79e76e9aa192aa9767e6c3bdd5c2 | committed |
| tasks/b9iiu3g6o.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bbw9bu2eh.output | 166 | 4f0a6723cb2630920e7f33f8575c32c39eefbfbdf64628fc66888792f1048ea6 | committed |
| tasks/bf91aokzp.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/bfq5bokvn.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bg9xtjrhq.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/bgx20imt7.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bi8jtik8x.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/bkblxvpmj.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bns7bv1xh.output | 83 | 8ac96869f146fb850076a2dd7a1a0e21aaa3b9b2d85056ca4e8996445ec83a65 | committed |
| tasks/bood5c04n.output | 573 | f52003f25127e513984e935816442473f88ceacd86324e39317b8bc7ad2a92e4 | committed |
| tasks/brmb92n2i.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/bu5b1mrau.output | 583 | 487b8881646dae35f0ef8f0c61cfac138e91db6b3288e5d9edfb3d4a5eb852e4 | committed |
| tasks/buwfcyo9t.output | 476 | 467bb3f9012ec6f155a450f5a1f098ed50a033fca4ba765e2f5b5e7e8124ea0b | committed |
| tasks/bvudnc8d8.output | 83 | e4bdb94032b0c6669624829de02507a04f0adb52a53fa5cd6fb441760250bffd | committed |
| tasks/bww3dtnq2.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/byv4te6oi.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bzhu6f2tv.output | 24 | 98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82 | committed |
| tasks/bznlkir35.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| /tmp/s.bak | 64201 | cb7d3e01a72e5032e4b06cc88cb76be04f5e6b731974df743ff7eb71c2c94ecf | excluded: a copy or mutant of `packages/worker/src/engine/strategy.ts`, used for the REC-1 backstop mutation check. Regenerate with the script in the session notes: drop `if (now >= to) continue;`, and/or swap the `#windowEnds`/`#entries` calls in `onMarket`. |
| /tmp/m_nobs | 64170 | cc8e5f3a71dd21b3434e2a2c93f178e96e583748c9b5d48a26bc0bc84033fa90 | excluded: a copy or mutant of `packages/worker/src/engine/strategy.ts`, used for the REC-1 backstop mutation check. Regenerate with the script in the session notes: drop `if (now >= to) continue;`, and/or swap the `#windowEnds`/`#entries` calls in `onMarket`. |
| /tmp/m_swap | 64201 | b49caba589998aa6669a3a28786003d0474bbe3f44ac8706eebb029a1cf310be | excluded: a copy or mutant of `packages/worker/src/engine/strategy.ts`, used for the REC-1 backstop mutation check. Regenerate with the script in the session notes: drop `if (now >= to) continue;`, and/or swap the `#windowEnds`/`#entries` calls in `onMarket`. |
| /tmp/m_both | 64170 | 82209dc5639fceceadde067e603f855d2750fab89ee2ad927391d3b83816adea | excluded: a copy or mutant of `packages/worker/src/engine/strategy.ts`, used for the REC-1 backstop mutation check. Regenerate with the script in the session notes: drop `if (now >= to) continue;`, and/or swap the `#windowEnds`/`#entries` calls in `onMarket`. |
| scratchpad/hn/ | - | - | excluded: the git worktree of `claude/handover-notes` itself |

Nothing excluded holds secrets, provider data or third-party content.

- `scratchpad/check.log`: output of the last local `pnpm check` (4530/4530 on #106 at d06ebdb).
- `k.test.ts`: a one-off probe that lists a recorder boot's files (TEST-1 work).
- `tasks/*.output`: background-command outputs, mostly check summaries.
