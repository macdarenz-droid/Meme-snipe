# Sandbox manifest: session_012efQfLAwWStK3PT6ZW2PHz (reviewer)

Every file this session produced in its container outside the repo checkout. Paths are relative to the session folder `/tmp/claude-0/-home-user-Meme-snipe/2bf2916e-dcdc-547a-9cc9-f3ceeaba1e6f/`. Committed files are copied into this folder at the same relative paths. I scanned them for secrets, emails and tailnet names; none were found.

What they are:
- `scratchpad/check*.log`, `install*.log`: `pnpm install --frozen-lockfile` and `pnpm check` outputs from the reviews (the counts are quoted in the verdicts).
- `mut41.sh`, `mut114.sh`, `mut115.sh` (+ `.log`): the mutation scripts (perl one-line mutants plus targeted vitest runs) and their results for #41, #114 and #115.
- `p2bt.diff`, `p2core.diff`: review diffs of BT-1c #53 (repo code, regenerable with `git diff`).
- `holdout73.txt`: review working notes for BT-1d #73.
- `sent.txt`: the full text of every verdict this session sent to the supervisor (22 messages), extracted from the session transcript.
- `tasks/*.output`: background-command outputs (check and mutant progress).

| Path | Bytes | sha256 | Status |
|---|---|---|---|
| scratchpad/check.log | 1791 | 92bf1c3464171325b50b0e0d7bf057a50099ad20a19756c29338642d4a68bd8b | committed |
| scratchpad/check10.log | 4597 | ff743ceea252e7db61314937a19cf89018c85022d74801d7ab657569ba1c9095 | committed |
| scratchpad/check11.log | 2988 | 177aaa521bb1913b25c4b9d63262478a8926b3ccd47280ecaa9792707e764ffb | committed |
| scratchpad/check115.log | 1315 | fa2dcf42e6b31a1334c6633629c6e77ccadb99b93e6b7621c2d182d7d8fd5497 | committed |
| scratchpad/check12.log | 2974 | 835267876ebd45d33f46f6a815bd487d9a7cec95bd4e062d6144765b5f659786 | committed |
| scratchpad/check13.log | 4172 | 2354920d09fd616c59757075937d7649ea280a98e37678a225db047135dcffdf | committed |
| scratchpad/check14.log | 4339 | 043d15c57cad9df20112e3d3384f3d6d39274c9af40b870c0ef0fb452a240cff | committed |
| scratchpad/check15.log | 5469 | 3a942510c8a3acbf1db12e940b8e63a157f325c772e87360a8479228c7079e6f | committed |
| scratchpad/check16.log | 4340 | d169a44622c7923e600f0ac80bdf8a594f7664d896fdd006e4b9f4d7c37b3322 | committed |
| scratchpad/check17.log | 4332 | 5dd733cbb374d8904a2d2030a9be9061899205b36d59edf0def35d3429a9642a | committed |
| scratchpad/check18.log | 4526 | 14481922e31e22a80368547594161fb7654b732c7736aaaa8afb7edb40a11877 | committed |
| scratchpad/check19.log | 5515 | ab3c00237ae0f02c08a933dba4b1bdab80e416f9066fa89e5e2df27a69ed5f07 | committed |
| scratchpad/check2.log | 1781 | 5af506084be4eac4439be3de4627a7ffb4da282c2e470fdb6fbc49a842061903 | committed |
| scratchpad/check3.log | 2036 | 76d5c21a8a55f894b48f61d28d37e2e8d408f854c3f0738482503e1a70f23e4e | committed |
| scratchpad/check4.log | 2209 | e27101eb0aea54bc940f4b79c7f865026d50f7e7d1f1b802a2cbbb1b2e142049 | committed |
| scratchpad/check41.log | 5689 | e97eaa9126437106fdea299c92523d9c5af06dd150a9483847878865d4186d6e | committed |
| scratchpad/check41b.log | 6544 | 1322d91838cb2e4fee9b306054194a24f0d4e6a36ec3b017166ea4f1d5d48a4b | committed |
| scratchpad/check5.log | 2209 | 31a2d3b58f353236d3cea1d18cf0b9e1367b221cf9c7e94eb4e65ed4ceba20d0 | committed |
| scratchpad/check6.log | 2219 | dbc953d8f0ad3986c97d8d2969db980e2590993e79a309907230ba1835063253 | committed |
| scratchpad/check7.log | 2968 | 20e858b29ec4c0795dcb57cf8d22ff36d96a0d68d42117fccd2c65e47f1ada30 | committed |
| scratchpad/check8.log | 2823 | be7cc7b4f077c16bc93f73a0f907d08238a7f035233e0b6610bbebd1d1ae58df | committed |
| scratchpad/check9.log | 2824 | 50253597667982c21e75d064041c3d9b042ff4416ba9e7b6cf594ce30901e62d | committed |
| scratchpad/holdout73.txt | 24817 | 5ab6ba7063e48be185e4b5661864188a3cc4c1c674142d5663270da28016425f | committed |
| scratchpad/install.log | 1059 | d67f3e3d85079276fed5418323b409ce03cb072c3716bff0a13941bbc8e1db5e | committed |
| scratchpad/install10.log | 147 | 5203c20e33f5cbaada09efa2569da325155d0fa2101c81246fb07255e241b0a3 | committed |
| scratchpad/install12.log | 146 | e37bb3f1304ad1f1f104603ede0043a0a4aeb5e7dd5ae30d92485add70c3a4d5 | committed |
| scratchpad/install13.log | 147 | 0537d5e1f4fb3907886cbeaa3e8af9f7a0d97b1db615920c7f867d7f89f0bf26 | committed |
| scratchpad/install14.log | 146 | 0581e0b82369963fc1cec0be171de820a8962a0b4e85caba2e0094c9de14cdd0 | committed |
| scratchpad/install19.log | 146 | fb87cac7a33bb5ac60dc3915f5717c1f35c02284898c82eec1a4c84b84dba559 | committed |
| scratchpad/install2.log | 146 | adbf6f53e482d192886c4a53d7dfa9fde8c62a919c2876576bddbe10b0e3432e | committed |
| scratchpad/install3.log | 257 | 0b8fc03fdab1a5471b2625c39ed6a293882ad0a1628142012be5d34ad192b497 | committed |
| scratchpad/install5.log | 147 | 87173e5dcd7e8ad2723ffc61f6afc7929be70fa59af578d65f0660f46359bbf5 | committed |
| scratchpad/install7.log | 146 | 03230cb8d05cc76b99fe8591b96cb118a42f87fa06829dbfb7951d39f713d24a | committed |
| scratchpad/install8.log | 146 | f33408f758ed297ee13e2a70b1042a9dd4604f280589515de83e6b7c70a3b485 | committed |
| scratchpad/install9.log | 146 | e37bb3f1304ad1f1f104603ede0043a0a4aeb5e7dd5ae30d92485add70c3a4d5 | committed |
| scratchpad/mut114.sh | 1704 | 8ecaf26eef2d8a594a86a99d44205fd5b1fac7176a5caea7fc6423ac074d0c2c | committed |
| scratchpad/mut115.log | 813 | 87cd559816e75e88f411c6be65d42610b56f8b85224041ea10b5b9a72ac17fe4 | committed |
| scratchpad/mut115.sh | 1120 | 357be327a895c32010de9b9ce7a0306ca9f73eddb5e3fc008c347b1dc2cd21fb | committed |
| scratchpad/mut41.log | 1423 | 149144941e5e087db35296f2e443586415fa9fb029fb4eaff9c71437a518078a | committed |
| scratchpad/mut41.sh | 2145 | da95b2970e1581e385474e0b72d71c5a0201cd96c40ba85235aeae2c6d812214 | committed |
| scratchpad/p2bt.diff | 45385 | 299df47aa63a4cbbe56424625705d95ab5e1a89a1e3501a18490806ff77cc6c8 | committed |
| scratchpad/p2core.diff | 21442 | f8af7739f670425bbb86cdde7e8b16d5f38cdfc55b2d1c17bfdd7d7318a5e583 | committed |
| scratchpad/sent.txt | 79127 | b24029c372d804bdd2057cb6c4a267356c24e87d333904546ddcf32d5d4dd702 | committed |
| tasks/b2s5h9l22.output | 325 | f359c066dd9a6efb4beeec76a5e4d79c18438e76b86c20f3c69a683ff0ec9e61 | committed |
| tasks/b6z7w686h.output | 104 | 77889414cbceef514e53e182258f5d47aa8df6c603c75f3f23da419b2e3c9c1c | committed |
| tasks/b81aa8d3k.output | 1641 | dfe3255c9b97191db70a11f20171910ceaecd88a44a1f8833e2fefb6ed467478 | committed |
| tasks/b8az23nvq.output | 108 | f9351ab7a9e5483383a6f324c9370ffde3c8121d1a0a76d17b3876ec5d52e20f | committed |
| tasks/ba5ryr1a5.output | 128 | 379ef96fda497e07489371285651ba2d18525b69ef5031f5185b6984b5c8b49b | committed |
| tasks/bap9xzjny.output | 835 | 54117bdeb32d403cf340c82cc4f8dcbbb5db03eb045140c52d119caa352c3af4 | committed |
| tasks/bdlkhbl64.output | 319 | 44dd2f5cf6da611630dcd20eb115e85564ac481050ad5e67c59fcdeaa5aecb77 | committed |
| tasks/bfkfpcfi4.output | 98 | fee4a6a40ce6f17a3f200bf3e48027dcefabff4f0e2227e6b9a7160d5cbaa64c | committed |
| tasks/bgvy6z632.output | 195 | 2e23b79f09f06ada98d122d3632b9499b2f38500d7e2844486126f9d777b0770 | committed |
| tasks/bhf51awt3.output | 10 | 6caf3ac12c8c443229d86996a80886e86bc4da77167087b74b4306128f39c53f | committed |
| tasks/bhq4pyghw.output | 880 | 0eb9a10475c9fb5c607edcd22ccd60e924e280a5783515e1bf5b0e1015b08c13 | committed |
| tasks/bkndicg90.output | 108 | 277c5f2991b0c8c0217b761a05fe7e0d984cdae2fd8af328237aab572a9c360d | committed |
| tasks/bmw2auww1.output | 266 | 8f8b964d23b702c8330b9afe9890f72ab6692be01d550a3e1916248def0d17a0 | committed |
| tasks/bpnx500qk.output | 825 | 6537e2062135502cf30bd6c550ca50d5015ca6530ba5b3450bf09d577b13600a | committed |
| tasks/bpwbp6ygo.output | 79 | b0b11ddb9addf0ac217274675efc9d2de60278a28dee4e9325c926f915075e99 | committed |
| tasks/bq70xzf0t.output | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | committed |
| tasks/budz9bjoq.output | 91 | 355dea0d0c7887ae53b3130ba5bfdc1ce1a301a958e6f7dc62a0be2ad8721a82 | committed |
| tasks/bup5zijw7.output | 1457 | b22420dc18f9dbdcf81198f46e9468e7a2fe2e87035265cf0287c502b5cb733b | committed |
| tasks/bvygn4xfm.output | 847 | 530d2b12543f832c2c4a9a8eee22a98554619f55d381048c01463b69f6ee0f47 | committed |
| tasks/bw7vkpuhh.output | 22 | 9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747 | committed |
| scratchpad/bt/ | 185642214 | n/a (directory) | excluded: a git worktree of this repo plus node_modules, no uncommitted changes. Regenerate with `git worktree add <dir> <sha> && pnpm install --frozen-lockfile` (bt 8dc0f49, bt2 dd19015, bt3 b6200d1; hn is claude/handover-notes itself) |
| scratchpad/bt2/ | 186053539 | n/a (directory) | excluded: a git worktree of this repo plus node_modules, no uncommitted changes. Regenerate with `git worktree add <dir> <sha> && pnpm install --frozen-lockfile` (bt 8dc0f49, bt2 dd19015, bt3 b6200d1; hn is claude/handover-notes itself) |
| scratchpad/bt3/ | 185677497 | n/a (directory) | excluded: a git worktree of this repo plus node_modules, no uncommitted changes. Regenerate with `git worktree add <dir> <sha> && pnpm install --frozen-lockfile` (bt 8dc0f49, bt2 dd19015, bt3 b6200d1; hn is claude/handover-notes itself) |
| scratchpad/hn/ | 47008013 | n/a (directory) | excluded: a git worktree of this repo plus node_modules, no uncommitted changes. Regenerate with `git worktree add <dir> <sha> && pnpm install --frozen-lockfile` (bt 8dc0f49, bt2 dd19015, bt3 b6200d1; hn is claude/handover-notes itself) |
| /root/.claude/projects/-home-user-Meme-snipe/2bf2916e-dcdc-547a-9cc9-f3ceeaba1e6f.jsonl | 6605845 | n/a | excluded: the session transcript, which holds tool/system context and account details (personal data; the repo is public). Its review content is in sent.txt and the session's handover notes |
