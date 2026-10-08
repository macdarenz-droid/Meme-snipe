# @bot/dashboard

The operator dashboard (design: `docs/UI.md`). React 19 and TypeScript, bundled by Vite 8 (its build API, `test/tooling/build.ts`) into static files
that the bot's API serves on its own origin. There is no Node server in production.

Every module under `src/` is a `.ts` file (the repository allows no other module type under `packages/`), so components
are written with `createElement` rather than JSX. Styles are plain CSS with design tokens (`src/styles/`); the build
inlines their `@import` rules and hashes their assets.

## Running the dashboard locally against fixtures

Node from `.node-version` and `pnpm install --frozen-lockfile` at the repository root first. From `packages/dashboard`:

| Command | What it does |
|---|---|
| `pnpm dev` | Builds into `.dev-build/` and serves it on `http://127.0.0.1:5173/`, rebuilding when `src/` changes (reload the page). `/api/` answers from `test/fixtures/` (see below). |
| `pnpm storybook` | The same, plus the component catalogue at `http://127.0.0.1:5173/catalogue` (`?section=<id>` for one section). It replaces Storybook 10, which the dependency policy refuses (its `esbuild` dependency has an install script). |
| `pnpm build` | Production build into `dist/`: `index.html` and hashed assets, no source maps. |
| `pnpm preview` | Serves `dist/` on `http://127.0.0.1:4173/` with the fixture API. |
| `pnpm test` | Unit and component tests (Vitest with happy-dom). The root `pnpm test` runs them too. |
| `pnpm test:e2e` | Builds the app and catalogue into `.e2e-build/` and runs the Playwright behaviour and axe accessibility tests. |
| `pnpm test:visual` | The same build, then the screenshot comparisons in `test/e2e/__screenshots__/`; `pnpm test:visual:update` rewrites them. |
| `pnpm typecheck` / `pnpm lint` | The type check (DOM lib) and the repository's ESLint rules for this package. |

The servers listen on `127.0.0.1` only and send the production Content-Security-Policy, so a CSP violation shows up in
development. Browser tests need a Chromium: set `DASHBOARD_CHROMIUM` to its executable (for example
`/opt/pw-browsers/chromium`) or `DASHBOARD_BROWSER_CHANNEL=chrome` for an installed Chrome.

The screenshot baselines are rendered by the CI runner's Chrome (154.0.8037.57 on the `ubuntu24/20260927.320` image),
because text rasterisation differs between Chrome versions. Another Chrome fails them on glyph edges only. When the
runner's Chrome changes, a failed `dashboard` job uploads `dashboard-test-results`; after checking each `*-diff.png`
shows glyph edges only, its `*-actual.png` files become the new baselines.

The fixture API (`test/tooling/mock-api.ts`) makes no network request:

- `GET /api/v1/vm/VM-nn` returns `test/fixtures/vm/VM-nn.json`.
- `GET /api/v1/stream` is a Server-Sent Events stream: `retry`, a heartbeat from `vm/VM-01.json` every 2 s, and with
  `?script=<name>` the events of `test/fixtures/stream/<name>.json`, each after its `delay_ms`. A reconnect with
  `Last-Event-ID: n` continues at `n + 1`.

Catalogue pages for the DataTable (UI-T06): `?section=positions` is the Positions fixture page (`GET /api/v1/vm/VM-05`);
`?section=table-perf` scrolls 5,000 generated rows (`&rows=` up to 10,000) and has a 20-updates-a-second cell. Set
`DASHBOARD_PERF_GATE=1` to make the browser test fail below 55 frames a second; otherwise the frame rate is only
recorded (`test-results/table-perf.json`, and the CI job summary).
