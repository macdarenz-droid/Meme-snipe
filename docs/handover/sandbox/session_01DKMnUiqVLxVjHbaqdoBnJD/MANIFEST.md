# Sandbox manifest: session_01DKMnUiqVLxVjHbaqdoBnJD (reviewer)

Everything this reviewer produced outside the repo checkout. I wrote no code to any branch. The review scripts, mutant scripts, stubs, logs and outputs are committed under `scratch/`, keeping their paths relative to the scratch folder `/tmp/claude-0`.

What the files are:
- `mut.sh`, `mut2.sh`: digest.go mutants for #111.
- `m3.sh`: rpc-day, rpc-credits and check-day mutants for #119.
- `m4.sh`: rpc-ledger mutants for #127.
- `*.txt`: the mutant results.
- `demo/`: the #119 B1 reproduction (a stub writing a truncated usage file).
- `unz/unz_test.go`: zstd decompression of the #111 baseline.
- `bt3*`: the #89 evidence runs.
- `check*.log`, `ci*.log`, `go*.log`, `qa*.log`, `testci.log`: test logs from earlier reviews.
- `tasks/*.output`: background-command outputs.
- `fb.ts`, `oldvol.ts`: #77 volume cross-check probes.

## Files in /tmp/claude-0 (scratch)
| path | bytes | sha256 | status |
|---|---|---|---|
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b39llhx1l.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b39llhx1l.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b4es2kvdm.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b4es2kvdm.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b5i4yywdp.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b5i4yywdp.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b64t9zcnb.output | 91 | `0a7dbe410b9052c2d850a1139e782dd3d259cb9f8f3692fb2b4d380940cbc081` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/b64t9zcnb.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbi2n8jwi.output | 367 | `22b65820f05de5494ed50b888482194ab655641a6df6587261aae2ed5a687fa7` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbi2n8jwi.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbl7sijn0.output | 90 | `47e84ba65f0146a0fd1f7e0007f33211f9411e78c48ab0aa0b52eccc6b1fa537` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbl7sijn0.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbuljrm6n.output | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bbuljrm6n.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bdj31r1dm.output | 368 | `8df3dcd654e378886a9a240031fe9298f3e594db1f3a8e1846552b0915d1841a` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bdj31r1dm.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bea6xd5ca.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bea6xd5ca.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bgm18kvty.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bgm18kvty.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bjpa40n77.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bjpa40n77.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bpg0k9vw4.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bpg0k9vw4.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bwl6wr6el.output | 22 | `9ee8ddbc1f705d5cad80decea71573a77c4bf3d3e817fbb4e7c644c51b31e747` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bwl6wr6el.output) |
| /tmp/claude-0/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bwo45xudf.output | 366 | `217887241699e347a11d581ba0863610e2c0f4dbcb928b9e2febb53240107092` | committed (scratch/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e/tasks/bwo45xudf.output) |
| /tmp/claude-0/ac.bak | 4691 | `d32c0dcbb610c766e3e1088ce297c388a3bc42b7605173bc5a69415d93fab8db` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/HEAD | 21 | `28d25bf82af4c0e2b72f50959b2beb859e3e60b9630a5e8c603dad4ddb2b6e80` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/config | 99 | `be6f79cc153c4b6ae8195a10a887b3af94065ced71ecc83c765bf38f7a9a2a81` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/config.global | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/index | 114990 | `47b7f055c60a0c3218fa2ea4614fe288ad089e01b526aec5d55f7f66d86a976b` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/info/attributes | 57 | `718ebb75c56e93e9e9ddb3830e75a37dce8bf820cf03a6223fa606b91b748502` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/info/exclude | 240 | `6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/objects/de/a48c1f207508537c3540a0b06af4031975718f | 121 | `e82b516c6f89f83fff38077e2ca9535f5f3bcb601bf7d894caa65f7046a9baea` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/objects/info/alternates | 35 | `40b80442145cfb25525315dacb75fe762f8e641c8629f2e06ebead04463a1a81` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bash-edit-diff/639599612217215168-1901614831328433311-262e929da5119a80/refs/heads/main | 41 | `bfe7fdac306d5cd35b8766e92f34d2e22016f2753bb399276f070cd9d92fbbed` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/bt3/evidence.json | 1845 | `3b99e77926d21c9bb2691a9392231a373ff486c63c1596454fc359e9b288ba24` | committed (scratch/bt3/evidence.json) |
| /tmp/claude-0/bt3/summary.md | 732 | `6bcd851de9829a14a760596128a254a036873ae0c33eb136676060e358c1c4f2` | committed (scratch/bt3/summary.md) |
| /tmp/claude-0/bt3r/evidence.json | 2561 | `e2d55ab26eb84acf9b0243799d59b6cb9515d02196411990a04384488fe41151` | committed (scratch/bt3r/evidence.json) |
| /tmp/claude-0/bt3r/summary.md | 734 | `f67c8f7d4faec99c0be9c666bde1a8ed777bfcd0ac9224e65240eebd812556fe` | committed (scratch/bt3r/summary.md) |
| /tmp/claude-0/bt3x/evidence.json | 1844 | `28f307396b694d3f5ffe7af6e2217fb335bf3c52be2ad0367fe360c9e1b2059d` | committed (scratch/bt3x/evidence.json) |
| /tmp/claude-0/bt3x/summary.md | 732 | `c5823674e2fbdfc3f3de787c4f52fef390337b55fcd946cb05ad2ab65c1bf318` | committed (scratch/bt3x/summary.md) |
| /tmp/claude-0/cache-break-state-c36c328c-5b9e-5f52-b9ca-6c6652627f6e.json | 5175 | `b895c652085baeb6c64c69f3d8837031e697055b2a10dbdf7b293a1c31df06f6` | excluded: Claude Code harness internals, not project data |
| /tmp/claude-0/check.log | 2450 | `4a618d86e405dbbff15bbe0eca5f34d439970b8d118ba98cdeebc7934ce02757` | committed (scratch/check.log) |
| /tmp/claude-0/check2.log | 2407 | `0dc60f9dd8687eae186e068e50e53f02c3f81e274ad006925c89bbc05abe4056` | committed (scratch/check2.log) |
| /tmp/claude-0/check3.log | 2407 | `0f610a87fb4c6b7f5fe0bdae0d25139642c93367af6e351bcece3fbf2119a9a5` | committed (scratch/check3.log) |
| /tmp/claude-0/check4.log | 2584 | `89cce0fa264788c53ed66e7db65f6a113522cddbe032723ff94f934c444d633a` | committed (scratch/check4.log) |
| /tmp/claude-0/check5.log | 2584 | `575acfcef6c793d8e49c6ece9811363c855e72ca3b979cd5d65e7bfb29814cdd` | committed (scratch/check5.log) |
| /tmp/claude-0/check6.log | 2584 | `4d4db02f6fcb01d578985d4b255db1ac09094a5b0a2ba1def505c2859c246042` | committed (scratch/check6.log) |
| /tmp/claude-0/check7.log | 2584 | `5f23b5998add8eb13b666f1b698bf1e0219c5c577b7f608c1dccbe051a68c901` | committed (scratch/check7.log) |
| /tmp/claude-0/check9.log | 2755 | `0186cfda2415df777ea4a712f4921b5ad2a3acb7a65e179d8c8ae263383ded46` | committed (scratch/check9.log) |
| /tmp/claude-0/ci10.log | 4557 | `3da93f0cd5c48004d46b468393ca2e4dd12c79442bea32b357dcba18e170b6ca` | committed (scratch/ci10.log) |
| /tmp/claude-0/ci11.log | 5880 | `57c58939f538175d3f69c8163d35a85b252320263af0a5677a77986fb697d8c6` | committed (scratch/ci11.log) |
| /tmp/claude-0/ci4.log | 3826 | `7d846884518b7213db4a686ee22a46907362784d29f8b8a87218dfa9e3cbb402` | committed (scratch/ci4.log) |
| /tmp/claude-0/ci5.log | 3826 | `5c80b2d8a8c0eab33bf2b5ebb8a61e94aad07dc726f04bb9cd52d32f988301d1` | committed (scratch/ci5.log) |
| /tmp/claude-0/ci6.log | 3826 | `b96e601c09b83115cfeeac1ca0923c0552efd8c84776780f16a19682e3626553` | committed (scratch/ci6.log) |
| /tmp/claude-0/ci7.log | 3826 | `0e6b672dc76231fd0d645e4c52783e43eadc598746fbb95ca6ef51059623d033` | committed (scratch/ci7.log) |
| /tmp/claude-0/ci8.log | 4057 | `414b9b94093c07aa860ce7b26611b4c863c3a8d040d628fede0458898a74b1f2` | committed (scratch/ci8.log) |
| /tmp/claude-0/ci9.log | 4329 | `f26e15a55030a2e5cf460e9f97030a65bb6ca7a3eb00b6e93d06103e288b5cf0` | committed (scratch/ci9.log) |
| /tmp/claude-0/demo/bin/zeroed-rpcscan | 160 | `93a9b4fd24d66673139309d906089ef06f22f00a32ba55a06ca9b77a87a9146d` | committed (scratch/demo/bin/zeroed-rpcscan) |
| /tmp/claude-0/demo/ci/rpc-credits.sh | 1008 | `160e21d35f4aa8dc8efc7cbb57e0a9dc07a65c3002fa2e1b2274e029e7a09197` | committed (scratch/demo/ci/rpc-credits.sh) |
| /tmp/claude-0/demo/ci/rpc-day.sh | 3306 | `17eea502126fe1fd8c6d8d7ac3c496b2658d8af231c55b200df0cf6d2a92a8ed` | committed (scratch/demo/ci/rpc-day.sh) |
| /tmp/claude-0/demo/out/rpc-usage-run.json | 8 | `c6d683ba0c8618547bcad915542aeffdfb5c61075a1530d70650e6002fb55be3` | committed (scratch/demo/out/rpc-usage-run.json) |
| /tmp/claude-0/digest.bak | 15292 | `f834bf80a9c1bc387cb64c319f146de092c59751ae987f1e6ddf2f78586f79d1` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/ds.bak | 30679 | `087d7eab75a3250f2f6970222f32e6acf883a84e02ae99d6da4c842a3befef5e` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/fb.ts | 989 | `928c13e14d16433866340d51a3a558986ccdaaab7ca1fc6df273c63cccf795b9` | committed (scratch/fb.ts) |
| /tmp/claude-0/go11.log | 43 | `3fa74f5ced951bffceae604882935f5e6734ef1b411d64d78873ed9383fc2d14` | committed (scratch/go11.log) |
| /tmp/claude-0/go4.log | 43 | `a08dd521e19c62d43a02f2c36939cd8632608f753a60cf1fbcd39ce3bcce5ee0` | committed (scratch/go4.log) |
| /tmp/claude-0/go5.log | 43 | `c10e97a77247b5bba98f0413e18f30c1c713287394833295f69b9d1aeeb0ea24` | committed (scratch/go5.log) |
| /tmp/claude-0/go6.log | 43 | `2c1e95e784ce360e7515d4e2212bddd1f33bf6b48ab247b8837e58307d1b3f7c` | committed (scratch/go6.log) |
| /tmp/claude-0/go7.log | 43 | `360f97cebfbf120b0d7d9641cf36423b5af72813abe36b47cae4e3ef5900073d` | committed (scratch/go7.log) |
| /tmp/claude-0/go8.log | 45 | `45e5dd00acfdb6a663010623a2044129228a9e85d6ca8a9acd4ca4752eb61c8a` | committed (scratch/go8.log) |
| /tmp/claude-0/go9.log | 43 | `83380718fca01dd4508be4b77ce1e871691c4ded587bc77cfd41a3054c9d49bc` | committed (scratch/go9.log) |
| /tmp/claude-0/inst.log | 991 | `988804a3007ad876ba830680a1ae807fa83ae6a2932cb8b5c6250eceeb6355ca` | committed (scratch/inst.log) |
| /tmp/claude-0/m.bak | 4753 | `d90c55af40aaec4816c78e00b38ab8fb4b91ba40fbbec31c80afbb6801b8e896` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/m.out | 8313 | `fa13b4aec8182e16b97a5e14ae649eb94ad2103adb78f94d2cc8bf198fceae88` | committed (scratch/m.out) |
| /tmp/claude-0/m3.sh | 1847 | `0c87a3636d9fe44eb3d4ff24f4dcefd764373fb762b156e8b021e16f45e7c4d4` | committed (scratch/m3.sh) |
| /tmp/claude-0/m3.txt | 344 | `e9dbabe6c069e8d52b9405802cacac4cccaebb5e40a7a8a856f67c8338283086` | committed (scratch/m3.txt) |
| /tmp/claude-0/m4.bak | 5009 | `51ff79f4f52a34fcbbbfdb6b9172a5ef4e461948f32955cffeec5839965265c2` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/m4.out | 10157 | `715bd30ce813fb2fc6bee52d64c8752d7aeb088ae70cf54ea67451f0c4778ed9` | committed (scratch/m4.out) |
| /tmp/claude-0/m4.sh | 1702 | `b825011c8de71d01bb9730d7ab442acb6da328a11c3a69327f3efcd9e3299598` | committed (scratch/m4.sh) |
| /tmp/claude-0/m4.txt | 346 | `cab3be6853f94099ef010a62e7fa77ccee7106c6da91118925c0f69464785a9f` | committed (scratch/m4.txt) |
| /tmp/claude-0/mut.sh | 1717 | `2314bc9b4bc17427b61d6935e72e393c4292c1c4671129d7ce8ca50cf870d583` | committed (scratch/mut.sh) |
| /tmp/claude-0/mut2.sh | 1529 | `df06da45675c545e3ba47586ccc2b740753e538a3accf5980ab16a95b2ece66a` | committed (scratch/mut2.sh) |
| /tmp/claude-0/new.json | 2281436 | `6725fa9976f802f4126e3ee9e8af4688b3ce6f66c39a9eb2cc75ec4859e15599` | excluded: zstd decompression of old.zst/new.zst (regenerate with klauspost zstd, see scratch/unz/unz_test.go) |
| /tmp/claude-0/new.zst | 804893 | `3569b6536f007693b09becaa90f2d12115d2e673c39ee7717b2add4caaccad28` | excluded: identical to research/historical/pilot/baseline-1046-452277000-452281499.json.zst at 8389984 (old) and 956bb7f (new); git show <sha>:<path> |
| /tmp/claude-0/old.json | 2281436 | `35669b8ab3d7907f6f4e7fc64368b371a47510887d9dec9a39d51df69504f601` | excluded: zstd decompression of old.zst/new.zst (regenerate with klauspost zstd, see scratch/unz/unz_test.go) |
| /tmp/claude-0/old.zst | 804651 | `d4b36eed1da3bd3333c823ab1c72ae55986b367de847730efbd7b03a544b585a` | excluded: identical to research/historical/pilot/baseline-1046-452277000-452281499.json.zst at 8389984 (old) and 956bb7f (new); git show <sha>:<path> |
| /tmp/claude-0/oldvol.ts | 5551 | `3f1d2b7ce54867669f0762d4b1d9da86495d5817ed411cb1b02befd549401b35` | committed (scratch/oldvol.ts) |
| /tmp/claude-0/qa4.log | 70 | `1e1aab40d6943252e7e4e8f8462fb5c047a66f4027de3cdcacb5be2de2382130` | committed (scratch/qa4.log) |
| /tmp/claude-0/qa5.log | 19 | `22ee37f0e11a38131225089ab95cfcae5f99f36d9c992553211586019e959db1` | committed (scratch/qa5.log) |
| /tmp/claude-0/qa6.log | 19 | `4850817784cbb8d2d9e97e25e986e6e33ff6ba05a0cb5dd0de998de843da3fc0` | committed (scratch/qa6.log) |
| /tmp/claude-0/qa7.log | 19 | `98ea16855649af7a904e15d8d41ef02bebdc1f3428835a35739e9cbeff1057ae` | committed (scratch/qa7.log) |
| /tmp/claude-0/qa9.log | 19 | `e8a72b6667db342a75001a24bd23341b9dd59d13e3d403a909436d4e0a6d850b` | committed (scratch/qa9.log) |
| /tmp/claude-0/r.txt | 262 | `0da5c6a9b458f82c640b72fe3c0ec6461b7378d82e8194c5ee38363d8d4caab9` | committed (scratch/r.txt) |
| /tmp/claude-0/rd.bak | 3513 | `f79fc21415c1714aae9f547f5f217dfaba7ccfeefd3bf20f0805945c896ff31f` | excluded: copy of a repo file taken before a local mutant (regenerate: git show <head>:<path>) |
| /tmp/claude-0/s.txt | 323 | `e9b051a5e412435b60b7a50b68f920d82e442754abdd3bdb8f2cfa99dc728701` | committed (scratch/s.txt) |
| /tmp/claude-0/testci.log | 2415 | `a4c2e5374fcb43a55afeb1fe149688ec0dec61fe781ee13ec4f00b3124f0b321` | committed (scratch/testci.log) |
| /tmp/claude-0/unz/unz_test.go | 315 | `6bb827aa7e8eed8c6e1823f1f00708a47648fef7eed8d19c433bd6534d099b4e` | committed (scratch/unz/unz_test.go) |

## Other files outside the checkout (excluded)
These are listed by group rather than one by one: there are hundreds of short-lived test directories.
- `/tmp/qa-*`, `/tmp/run1-*` (including `run1-cli-*`, `run1-e-*`, `run1-scan-*`, `run1-stub-*`), `/tmp/tmp.*`, `/tmp/facts-supplement-*`: excluded.
  - These are temporaries written by `research/historical/ci/test-ci.sh`, the QA and backtest tests, and `mktemp`, about 50 MB in total.
  - Regenerate them with `bash research/historical/ci/test-ci.sh`, `pnpm test`, or `go test ./...` in scanner and rpcscan.
- `/tmp/bt3-*`: excluded. They are BT-3 evidence work directories, about 9.8 MB each.
  - Regenerate with `packages/backtest/scripts/evidence.ts` (see #89). The summaries are committed as `scratch/bt3*/`.
- `/tmp/claude-code*.log`, `/tmp/environment-manager*`, `/tmp/mcp-config-*.json`, `/tmp/codesign-mcp-config.json`, `/tmp/claude-*`, `/tmp/code-sign`, `/tmp/cc-socks`, `/tmp/hsperfdata_root`, `/tmp/node-compile-cache`, `/tmp/v8-compile-cache-0`, `/tmp/uv-*.lock`, `/tmp/ruby-build*.log`, `/tmp/147.0.7727.24`: excluded.
  - These are the container and harness's own logs, configs and caches, not project data, and may hold session configuration.
- `/root/.claude/projects/-home-user-Meme-snipe/c36c328c-5b9e-5f52-b9ca-6c6652627f6e.jsonl` (about 8.4 MB) and its folder: excluded.
  - This is the session transcript. It contains account details (personal data). Everything project-relevant from it is in `docs/handover/sessions/session_01DKMnUiqVLxVjHbaqdoBnJD.md`.
- No secrets, keys, raw provider data or third-party pages were ever written by this session. No Helius key was used: every helius check ran against stubs or recorded fixtures.
