# Android preview

An installable build of the dashboard for checking the UI on a phone. It wraps `apps/web` with Capacitor 8 (app name Zeroed, id `com.macdarenz.zeroed`). It has no live data, no wallet and no store listing.

Download (always the newest build): https://github.com/macdarenz-droid/Meme-snipe/releases/download/preview/zeroed-preview.apk

## Install
1. Open the link on the phone and allow installs from the browser when Android asks.
2. Open the file. A newer build installs over an older one because every build is signed with the same key.
3. Only if Android refuses the update (the signing key changed, see Keystore): uninstall Zeroed, then install again.

## Build
- `pnpm --filter @meme-snipe/web build:preview` builds the web app with `VITE_PREVIEW=1`. That flag adds the Samples tab and the "Sample data" marker, and is used only for the APK. A normal `pnpm build` leaves the fixtures out, and `scripts/check-build.mjs` fails it if any remain (the preview build is checked the other way round).
- `cap sync android` copies `dist/` into `apps/web/android`. Gradle `assembleDebug` makes the APK.
- Workflow: `.github/workflows/android-preview.yml`. Version code is the run number; version name is `preview-<short sha>`. The job verifies the APK with `apksigner` and `aapt` (package id, version) before uploading it.
- Pull requests and other branches upload the APK as a workflow artifact only. A push or manual run on `ccr-14987baf-i6lrsl` also moves the `preview` tag, updates the prerelease notes and replaces its single asset `zeroed-preview.apk`. A release run skips itself if the branch has moved on.

## Keystore
A debug keystore is created on a cache miss and kept in `actions/cache` under the key `zeroed-preview-debug-keystore-v1`. Nothing key-like is committed (`*.keystore` and `*.jks` are ignored). If GitHub evicts the cache (unused for 7 days, or storage pressure), the next build creates a new key and the phone needs one uninstall. Caches made by a pull request are not visible to the integration branch, so releases always use the integration branch's own key.

## Native behaviour
- Edge to edge. `viewport-fit=cover`, and `--inset-top/right/bottom/left` in `styles.css` take the larger of `env(safe-area-inset-*)` and the `--safe-area-inset-*` values the Capacitor SystemBars plugin sets. Header, tab bar, page padding and sheets use only those variables (`test/safe-area.test.ts`).
- Status and gesture bar icons follow the theme (`src/lib/native.ts`): light icons on Silent Black, dark icons on Paper. Splash and window background follow the system light or dark setting (`res/values-night`).
- Back button (`MainActivity.java`, `src/lib/backStack.ts`): every open sheet adds one history entry; the native callback goes back while the WebView has history and exits otherwise. Order: close the sheet, then earlier screens, then leave the app (`test/back-stack.test.ts` models this).
- Controls have no text selection and no long-press callout.
- Offline: the app is bundled in the APK and served from the device; fonts are bundled. The `INTERNET` permission is declared for later work only.

## Manual check on the phone
1. Install; the icon is the Slot mark on a dark tile and the splash shows the mark.
2. Both bars: status bar icons readable in Paper and in Silent Black, and after switching theme in the app.
3. Rotate to landscape: content stays clear of the notch and gesture bar.
4. Wallet, Deposit: press Back once (the sheet closes, still on Wallet), again (previous screen), again at Home (the app closes).
5. Samples tab: "Sample data" shows in the header; open a trade, the marker shows in the sheet too.
6. Long-press a tab or button: no selection handles or menu.
7. Airplane mode, then open the app: every screen still loads.
