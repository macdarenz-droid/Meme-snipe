# Sandbox manifest: session_012QdDAuRuYt57E9PCjHfuKT (reviewer)

Everything this session produced outside the repo checkout, under `/tmp/claude-0` (the scratch root; the session scratchpad folder was empty). Committed files sit in this folder at the same relative path.

- `*.log`: `pnpm check` and vitest logs from my reviews. Each is named for its PR or review round, and the SHAs are in the session notes.
- `o2.ts`, `o3.ts`, `o4.ts`, `orig.ts`, `s.ts`, `bak`, `bak6`: copies of repo source files at reviewed heads (`s.ts` and `bak6` are strategy.ts at d06ebdb; `bak` is the mutant backup of a #123 file), kept for reference. Regenerate with `git show <sha>:<path>`.
- `tasks/*.output`: background-command outputs.
- Mutants were made inline by a python 'replace once' on the named line. Each pattern and its result is in `docs/handover/sessions/session_012QdDAuRuYt57E9PCjHfuKT.md`; no patch files exist.

| Path | Size (bytes) | sha256 | Status |
|---|---|---|---|
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/b1ftbew11.output` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bb6gvk3xn.output` | 256 | `eeb7c4b187159e299b846955fdfb768f2d8c39c29029be0be52f6e18c85ab95a` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bbav1uch3.output` | 114 | `8f4100c30b03bcb2a2e2a8c23d7f5afc6eb89baedbdaf50403f377cee32529cd` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bdgrubegt.output` | 657 | `44c98c3e2d0c09d81c7125e408e8aaae731d3b19e2576a1601a020dbe6bfcf73` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bgscz5uge.output` | 305 | `4a0fe25caf198cc40841f1bc603e08b39ce07719fc04321e4dc56850cfdf8121` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bhat42ahf.output` | 12 | `37f73743db78702df5e22b50771ced78fb28e2c842fa6cd2252c5d4f9b6f06f5` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bok1ny1gz.output` | 786 | `b423115cb0669b2653cd0505a94985ba37836cb58cea6daa1373a04e66041cb8` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bskomyj9z.output` | 50 | `3bccf1676bfae9bb51bcfde25cc33ab7bc08c4ea8ac3af7dad4081238b3c92cc` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bvrsbmea6.output` | 24 | `98a76774ed1f67045446490cf3d0cbdee89fbb3bcc588cdbd6d8bdedb2802d82` | committed |
| `-home-user-Meme-snipe/21f75bfa-2b13-5313-a3e3-4a806f3da55e/tasks/bz8jo1az7.output` | 202 | `6a9e56bff90fe49acff72e0f8d463cbd31100cd50c49819b863abf728aaf6894` | committed |
| `bak` | 13292 | `3bb860ba5485504d7b84e1da9ea223d65a5cba8e9d6a8d72f79fa95c6ff397d5` | committed |
| `bak6` | 83886 | `3f54ac054d2e46cf62c18deb5ef478060ee86c95b53e5f5a4661a598be9e99a4` | committed |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/HEAD` | 21 | `28d25bf82af4c0e2b72f50959b2beb859e3e60b9630a5e8c603dad4ddb2b6e80` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/config` | 99 | `be6f79cc153c4b6ae8195a10a887b3af94065ced71ecc83c765bf38f7a9a2a81` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/config.global` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/index` | 85509 | `b61ada79de277d0704f18873b3969b8f0da5f6b0e582a051d454a42aee06e85c` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/info/attributes` | 57 | `718ebb75c56e93e9e9ddb3830e75a37dce8bf820cf03a6223fa606b91b748502` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/info/exclude` | 240 | `6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/objects/25/dede5f1a5154bafe278187c17207de58f09012` | 122 | `4c6e5647d2e3d56f06f2fe02f39368b0f67a248eedd8d17fbf742d07bcf2038c` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/objects/info/alternates` | 35 | `40b80442145cfb25525315dacb75fe762f8e641c8629f2e06ebead04463a1a81` | excluded: Claude Code tool-internal git cache, not my work |
| `bash-edit-diff/14773755366104191454-1901614831328433311-a48ff0e4af05b048/refs/heads/main` | 41 | `6b3caa7c1a7633b7957fe3b5e311ab871685b5abd984a3bc210317bb708d6988` | excluded: Claude Code tool-internal git cache, not my work |
| `c1b.log` | 6319 | `0f534326822aafe40f4ccc41a69076d2f08f4f087fa88e742c67e5b88c5bc864` | committed |
| `cache-break-state-21f75bfa-2b13-5313-a3e3-4a806f3da55e.json` | 3595 | `b251679031897ff381295d6538df87d34b4d0004c27663dbd162e558144cb2bf` | excluded: Claude Code harness state, not my work |
| `cf.log` | 4227 | `1c090eb4dd7a8f3e2e775a86f229a22d743a4fb372c7342b4336cfeff900edf0` | committed |
| `check.log` | 6490 | `ccc7755016f2d8dd956c08f9e02d02939115dd0ed8a214c5568e2fdc6058f9f2` | committed |
| `check2.log` | 2092 | `5f8db20e865f097fa1f33ab68981923b2ab144f75af1018c0f995564ffc60fa3` | committed |
| `check3.log` | 3733 | `b6dbf314fbaf29767a035b1c23b70aba21700726534656ab9842554b86a83033` | committed |
| `check4.log` | 3729 | `2c5277cb7181955432b3092897afb1c4178e27531193044859a28ad0a2ba01e5` | committed |
| `check5.log` | 3725 | `a60eb1038dccd28a6a398a7f7e7ccfc7099104bc5d506fd0615cedbfd23d6083` | committed |
| `check6.log` | 3901 | `2796328732941fd6d879eb01f996544e8b1b6366dc779a958181c6def2fc80df` | committed |
| `f1f.log` | 4565 | `43fe31c266527626cc1126bc02adf28db55abe2f9bfcd229f14ec721e351fb2f` | committed |
| `f1g.log` | 4749 | `e775ba532a31f30ebf0f781262d5923338a0e58620e1a36a44375d31c7ceffb1` | committed |
| `f6.log` | 3749 | `da6589aee56f68c895a9a05af717929784726c30981c27a1e8fccaca9215e48b` | committed |
| `inst.log` | 992 | `85133b3f84de8bee4330df0dffd5fef43c4a0d7568a036ffed6d676cd7eae463` | committed |
| `inst2.log` | 137 | `8ac53773c20035f7e6de3d44ada0bf247ef6180a03b3638ec610884e0589d2b0` | committed |
| `inst3.log` | 407 | `600fb2c7da6d9ab3acd5399f1c90e2a6984395d714b2c0f33425d10f3e9ddfc8` | committed |
| `m106.log` | 5597 | `cc70e5730e182c65a5adf2ebacc1676d3bd9eca02857cacd9812674cffb11166` | committed |
| `o2.ts` | 58598 | `cbaf18fd991d12b52ee1162c3183eecfb02b2b15f21e49207f01f3cd31083809` | committed |
| `o3.ts` | 59922 | `4aef55f3963e18b449518fbcab31083e8a33b515319c4514347c89a9d8e6b79e` | committed |
| `o4.ts` | 60503 | `a4be58fc880cc30d37723064541348c700d06aded853030e02ae9fddae16e68e` | committed |
| `orig.ts` | 57328 | `75bb75a995704331c9a1f6b6d9c0e6aa320df908f1b4c5c59a42eb20364f055d` | committed |
| `p1.log` | 4407 | `b4b9f9cfd1ae3592d973d78b403abdd134672bb784b71a35e709266c7c575a99` | committed |
| `p117.log` | 5429 | `f981bbebd1bfab0110c9693dbfaee22c71be706e13152d6fd62bf64e800476c5` | committed |
| `p117b.log` | 5911 | `5ad80587ae1bd258ef3f074e617d5fb2e85c6d8ea7c457ee333f72056aeea99c` | committed |
| `r95.log` | 4392 | `8ca2a45479008df3dc1fc1e36d488b13b59cd11167abaf482179f2792df11c0d` | committed |
| `rec.log` | 4223 | `5a6feaf4a6fb6d34b05e39e3bae36f2670a07fe1242711fcd13d4e2dbaa404c8` | committed |
| `rec2.log` | 5641 | `fb5fee0737bd5cb673a76633984ec802de43d7e1504f62808936bc767ba5bcf8` | committed |
| `s.ts` | 83886 | `3f54ac054d2e46cf62c18deb5ef478060ee86c95b53e5f5a4661a598be9e99a4` | committed |
| `test2.log` | 2858 | `fe4de4b71b3b9160be550ac380beb8f0be9061af038bbbb19731e8dacc412598` | committed |
| `w1b2-1.log` | 4396 | `27d991db6c9865a7e89eba79448faeea26dcf47ce8ff488ae8e73b5bf7c11bd8` | committed |
| `w1b2-2.log` | 5845 | `94bc5164f6110618051e0b28e05ff04897e01fcb74b97a581b0bb935dc9e2d6c` | committed |
| `w1b3.log` | 4563 | `1959858a0178b1749fb6f48e333f67c68a9df437a3ce39315fc3251a7535d798` | committed |
| `w1c.log` | 4411 | `7ad693219eab2ae08e18feae568e1d20b1ffe5debb5e9492ec5c1d99fd71d75e` | committed |
| `w1c2.log` | 4584 | `ad418df02117945e946ce8961cadc16cc4c2b1ddc8531e4ca7ad40f7337bb364` | committed |
| `w1c3.log` | 4563 | `3bbfb3bd1903eade4238ba0e0bb7779eedaf053e5356f69ce02b3487bb9e4189` | committed |
| `wo.log` | 1232 | `7b41990a42aa5341fc1cea40fd6cc6ec05e1426df7ea9a4b89e9854194d7cca7` | committed |

Also excluded, not listed file by file:
- `wo/` (worktree of b849d9f, 195 MB) and `f6/` (worktree of d06ebdb, 50 MB): repo checkouts plus node_modules. Regenerate with `git worktree add <dir> <sha> && pnpm install --frozen-lockfile`.
- `ho/`: this branch's checkout.

There are no secrets, keys, provider data or third-party pages in the committed files (I grepped for key, secret and tailnet patterns).
