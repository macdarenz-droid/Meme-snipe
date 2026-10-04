# Working rules for every agent in this repo

The owner's rules. Relay's CONTRACT.md carries the same ones.

## ULTIMATE RULE (owner, 2026-09-26): above every other rule, mode or permission
Use what's necessary for high-quality output and a fast workflow, while saving tokens.
- Run agents in parallel when that makes the work faster or better. Prioritise true dependencies and bottlenecks; add workers only for independent work that review and CI capacity can absorb.
- Never add agents that duplicate or re-check each other without need.
- Use a strong model for hard judgement and a lighter one for mechanical steps. Do small things yourself.
- Quality is never traded away: tests fail before and pass after, and nothing is loosened.

- Keep token use low. Read only what the task needs, write short, don't repeat context. Spend more only when a task is complex and truly needs it.
- Explain and summarise for the owner in plain, simple words.
- UI copy (owner, 2026-10-01): never put words in the app or on the website that talk down to users or state the obvious ("In plain words", "Not medical advice" on a gym app). Explain nothing unless Google Play requires it (cite the policy) or the owner explicitly asked for it. Labels that name a control or show data stay. Plain words are for messages to the owner, not a label on user-facing text. Headings (owner, 2026-10-01) are short labels of one to three words, a noun phrase: never a sentence, a "What ..."/"How ..." question, a qualifier such as "off by default" or ", and where", or a leading "The", "This" or "About"; the text under a heading explains it.
- Owner chat (owner, 2026-10-01): work in the background and keep the owner's chat quiet. Post there only:
  - a new APK: its link, what changed, and what to check on the phone;
  - a problem no agent can solve;
  - a choice only the owner can make, or one where no option can be recommended;
  - the finish-line reminder he asked for.
  Everything else goes in the repo and on the PRs (HANDOVER, PR comments, Relay), never in his chat: progress, ticks, "no change", monitor echoes, plans, rulings, reviews and merges. Builders and reviewers never write to the owner.
- Decide, don't ask. Research first, pick the best logical option, apply it, and record why. Ask the owner only for input or an action no AI agent can do (a payment, a login, a secret, a check on a real device).
- No guessing, even on simple tasks. Check the code, docs or data first; if you cannot verify something, say so.
- After each task, review what was built: the feature, its logic, how it works. Move on only if it meets the goal; otherwise fix or improve it first.
- Precision at every layer: code, tests, tasks, messages.
- Prevent, don't apologise. Catch anything that reading, testing or reviewing could catch before it ships.
- While building, check each change with focused tests. Full regression and full QA run once, on the finished build.
- Name risks and their mitigations when designing, while building, and after release.
- One document per topic: update it instead of creating copies (no v2, final, copy or patch-1.2 names).

## How work is delivered

Adopted from the owner's Agent Delivery Playbook on 2026-09-26. The supervisor keeps this section current. If the Agent guard check fails, read docs/AGENT-RULES.md.

**Procedures:** every builder, Claude or Codex, reads and follows `.claude/skills/builder/SKILL.md` before its first commit. Reviewers use `.claude/skills/reviewer/SKILL.md`, and the supervisor uses `.claude/skills/supervisor/SKILL.md`. Rules in `.claude/rules/` appear when you touch those files.

**Phase delivery:** name the full deliverable, its acceptance evidence and its finish condition before building. Track implementation, release-candidate acceptance and store publication separately. Forecast the full agreed scope, including integration, review, fixes and required device checks; state assumptions and uncertainty rather than treating a build estimate as a release date.

**Roles:**
- **Supervisor** (one Claude session): owns the task board (Relay `tasks/TASKS.md`), the merge queue and these rules.
- **Builders** (one session per task, on a `claude/*` branch): build and test only what their task card lists.
- **Reviewer** (fresh context, on demand): checks a finished diff against its spec. Builders never approve their own work.
- **Watch agent** (GPT/Codex, `codex/gt6-gate-a-watch-lab`): agents never merge its PR.

**Agents may, without asking:** build, test and push on their own `claude/*` branch, and open draft PRs.

- Run in auto mode (owner, 2026-09-28): the supervisor starts every builder and reviewer session in auto mode, so no work waits on the owner's approval taps. Auto mode's safety checks still apply, and a refusal is never worked around.
- Models: a strong model for hard judgement, `claude-opus-5-5` (planning, judging, reviewing, and any card that is not mechanical); a lighter one for mechanical steps, `claude-sonnet-5` (every step spelled out). Never Haiku or Fable. The built-in Explore and claude-code-guide helpers run on Haiku, so they are blocked. For a search, use a general-purpose helper that names `sonnet`. Helpers that name no model use the session's model.

**Only the owner:**
- deploys the Escobar Worker (merging anything under `escobar-worker/**` into `main` deploys it, so those changes go in a separate PR that the owner merges);
- decides anything about the signing key, keystores or Huawei secrets;
- publishes releases and store listings;
- approves new kinds of stored or sent user data, new paid services or providers, and any spending (test calls to the live coach use the owner's AI key).

**Never, whoever asks:**
- Commit keys or secrets; the repo is public.
- Touch the signing steps, `EXPECTED_SHA256` or keystore handling, or rotate or replace the key `05:66:9A:…:F1:F5`.
- Push directly to `main` or `claude/escobar-v2-implementation-eidx64`.
- Rewrite history (rebase, amend, force-push) on a branch you don't own.
- Skip, loosen or delete a test or guard check to get green.
- Work around a permission or classifier denial by any means, including through another agent.

**File ownership** (one owner per shared file):

| Path | Owner | Rule for everyone else |
|---|---|---|
| `native/wear/**`, `src/native/wearEngine.ts`, `src/slices/settings/WatchLab.tsx` | watch agent | Never change. The guard fails the push. |
| The Watch-lab row in `Settings.tsx`, the watch agent's lines in CI | watch agent | Never change. Only review catches these, not the guard. |
| `escobar-worker/**` | the owner deploys | Separate PR; the owner merges it. |
| `.github/**`, `scripts/prepare-android.sh`, `native/patch_manifest.py` | supervisor | Add checks only. |
| `package.json`, `package-lock.json` | supervisor | No new dependency without the supervisor's OK. The lockfile comes from npm. |
| Saved data shape (`src/core/models.ts`, `src/core/store.ts`, migrations) | the owner approves | New kinds of saved data need the owner's approval first. |
| `scripts/screenshot-gate.mjs`, `tests/theme.test.ts` | shared, add-only | Add your own blocks, named with your task IDs. Never edit, move or delete another task's block. When merging `main`, keep both sides. One exception (owner, 2026-10-02, GATE-SPLIT): after HT-10 merges, the supervisor's GATE-SPLIT card may assign existing blocks to parallel CI jobs without changing what any block checks. It needs an equivalence proof first: every block × time zone × theme runs exactly once per run; a proof file per job and a verdict job that fails on a wrong sha or a missing, duplicated or miscounted item; 5 paired runs with identical results; a seeded failure red in both arrangements; a mutation that drops a proof row turns the verdict red. |
| `src/ui/styles.css` | the task card that owns shared styles | Others change only rules for components their card names, in one block marked with the task ID. |
| `src/app/App.tsx`, `src/main.tsx` | supervisor | Smallest possible wiring change, called out in the PR. |

**Builders:**
- Merge `origin/main` (with a merge commit) before asking for review.
- Map every acceptance criterion to evidence: a unit test, a gate probe or a recorded device check. A bug fix needs a test that fails before and passes after.
- Never cut, narrow or skip a test or probe to fit a time limit. Tell the supervisor instead.

**Supervisor:**
- Merges an app PR only when:
  - its review passed;
  - every check is green on a head that contains the latest `main`;
  - every lower-numbered item on the owner's checklist has merged (builds may run ahead in parallel lanes; merges may not).
- Treats evidence as valid only for the exact commit or APK it ran on. The release candidate gets its full regression run again after its last change.

**Commands:**
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run test:tz`
- `npm run build`
- `MARC_CHROMIUM=/opt/pw-browsers/chromium npm run gate`
- `npm run check` runs typecheck, tests and build together.
