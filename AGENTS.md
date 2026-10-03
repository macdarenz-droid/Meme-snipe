# Working rules for every agent in this repo

The owner's rules, copied from `macdarenz-droid/M-arc` AGENTS.md (commit 56d6d6a, unchanged at 5bc4712) on 2026-10-03. Every agent reads and follows this file and `CLAUDE.md` before each response. The owner's rules below are verbatim; "How work is delivered" is adapted to this repo, because M-arc's Escobar Worker, watch agent, keystore and APK gates do not exist here.

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

Same delivery model as M-arc, applied to a trading app. Where M-arc says "APK", read "a deployed build or a paper-session report".

**Phase delivery:** name the full deliverable, its acceptance evidence and its finish condition before building. Track implementation, paper validation and live activation separately. State assumptions and uncertainty rather than treating a build estimate as a release date.

**Roles:**
- **Supervisor** (one Claude session): owns the task board, the merge queue and these rules.
- **Builders** (one session per task, on a `claude/*` or assigned branch): build and test only what their task lists.
- **Reviewer** (fresh context, on demand): checks a finished diff against its spec. Builders never approve their own work.

**Agents may, without asking:** build, test and push on their own branch, and open draft PRs.

- Run in auto mode. Auto mode's safety checks still apply, and a refusal is never worked around.
- Models: follow the owner's model range in `CLAUDE.md`. Never Haiku or Fable. The built-in Explore and claude-code-guide helpers run on Haiku, so they are blocked. For a search, use a general-purpose helper that names `sonnet`.

**Only the owner:**
- funds the bot wallet, moves money, and switches any session from paper to live;
- sets the live risk limits (daily and session loss, per-trade loss, emergency slippage, spending authority);
- provides and rotates API keys, RPC keys and the bot wallet key;
- approves new paid services or providers, and any spending;
- approves new kinds of stored or sent user data.

**Never, whoever asks:**
- Commit keys, secrets, seed phrases or wallet files; treat the repo as public.
- Put a private key in frontend code, browser storage, logs, analytics or an LLM prompt.
- Enable live trading, raise a risk limit or remove a stop from code, config or an agent session.
- Push directly to `main`.
- Rewrite history (rebase, amend, force-push) on a branch you don't own.
- Skip, loosen or delete a test or guard check to get green.
- Work around a permission or classifier denial by any means, including through another agent.

**File ownership:**

| Path | Owner | Rule for everyone else |
|---|---|---|
| `packages/core/src/risk/**` | risk reviewer | Changes need a reviewer pass and tests that fail before and pass after. Limits only tighten without the owner. |
| `packages/signer/**` (when added) | owner approves | No change merges without the owner's approval. |
| `.github/**` | supervisor | Add checks only. |
| `package.json`, `pnpm-lock.yaml` | supervisor | No new dependency without the supervisor's OK. The lockfile comes from pnpm. |
| Saved data shape (`packages/core/src/ledger/**`, migrations) | owner approves | New kinds of saved data need the owner's approval first. |

**Builders:**
- Merge `origin/main` (with a merge commit) before asking for review.
- Map every acceptance criterion to evidence: a unit test, a replay test or a recorded paper-session check. A bug fix needs a test that fails before and passes after.
- Never cut, narrow or skip a test to fit a time limit. Tell the supervisor instead.

**Supervisor:**
- Merges a PR only when its review passed and every check is green on a head that contains the latest `main`.
- Treats evidence as valid only for the exact commit it ran on.

**Documents** (one per topic, updated in place): `docs/ARCHITECTURE.md`, `docs/RESEARCH.md`, `docs/DECISIONS.md`, `PROJECT_STATE.md`.

**Commands:**
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check` runs typecheck and tests together.
