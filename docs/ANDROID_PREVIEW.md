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
- Pull requests and other branches upload the APK as a workflow artifact only. A push or manual run on `ccr-14987baf-i6lrsl` also replaces the single asset `zeroed-preview.apk` of the `preview` prerelease (`.github/scripts/publish-preview.sh`): the new file is uploaded as `zeroed-preview.apk.new` first and checked (state uploaded, same size), the old asset is swapped out only after that succeeds (and put back if the swap fails), and the tag and notes change last, so a failed upload leaves the fixed link working. A release run skips itself if the branch has moved on.

## Keystore
Signing (SEC-1, `.github/scripts/preview-signing.sh`):
- Pull requests and every other branch sign with a throwaway key made for that build. The signing step injects both signing secrets only for a `push` or `workflow_dispatch` on the exact integration branch; otherwise both environment values are empty, including on same-repo pull requests. Throwaway builds never restore the keystore cache.
- Those integration builds sign with the owner's key from the `PREVIEW_KEYSTORE_B64` and `PREVIEW_KEYSTORE_PASSWORD` secrets. The build refuses to sign unless the key's certificate SHA-256 equals the `PREVIEW_CERT_SHA256` repository variable; the APK's one signer is checked against it after the build and again in the release job before the link changes (`verify-preview-cert.sh`).
- Until the owner adds them, the integration branch keeps the APP-1 key in `actions/cache` (`zeroed-preview-debug-keystore-v1`) and every run warns. That key is exposed: any pull-request workflow, including one a fork edits, can restore a cache of its base branch (confirmed on 2026-10-04: run 37188909095 of pull request #134 restored it, its "Create debug keystore" step skipped on a cache hit). Whoever holds it can sign an APK that installs over Zeroed on the phone. A YAML guard cannot stop a fork, because a fork's pull request runs the fork's workflow files.

Nothing key-like is committed (`*.keystore`, `*.jks`, `*.p12` and `*.b64` are ignored).

### Owner steps
On any computer with Java 17 or newer (a free GitHub Codespace works):
1. `keytool -genkeypair -keystore zeroed-preview.p12 -storetype PKCS12 -alias zeroed-preview -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Zeroed preview,O=Zeroed,C=AU"`. Enter a new password of at least 16 characters twice and save it in your password manager.
2. `keytool -list -v -keystore zeroed-preview.p12 | grep SHA256:` and copy the fingerprint (the part after `SHA256:`).
3. `base64 -w0 zeroed-preview.p12 > zeroed-preview.b64` (on a Mac: `base64 -i zeroed-preview.p12 -o zeroed-preview.b64`).
4. GitHub, the repository, Settings, Secrets and variables, Actions:
   - Secrets, New repository secret: `PREVIEW_KEYSTORE_B64` with the whole content of `zeroed-preview.b64`; then `PREVIEW_KEYSTORE_PASSWORD` with the password.
   - Variables, New repository variable: `PREVIEW_CERT_SHA256` with the fingerprint from step 2.
5. Keep `zeroed-preview.p12` and its password in your password manager as the only backup, then delete `zeroed-preview.b64` and the Codespace.
6. Actions, Caches: delete `zeroed-preview-debug-keystore-v1`.
7. On the phone, once the next preview is out: uninstall Zeroed, then install from the link. The key changed, so Android refuses an update; app data is not backed up and is lost.

Rotating the key later is the same steps with a new key, and the same uninstall on the phone.

Every third-party action in `.github/workflows` is pinned to a full commit SHA with its tag in a comment (`test/android-workflow.test.ts` fails on a tag-only pin).

## Native behaviour
- Edge to edge. `viewport-fit=cover`, and `--inset-top/right/bottom/left` in `styles.css` take the larger of `env(safe-area-inset-*)` and the `--safe-area-inset-*` values the Capacitor SystemBars plugin sets. Header, tab bar, page padding and sheets use only those variables (`test/safe-area.test.ts`).
- Status and gesture bar icons follow the theme (`src/lib/native.ts`): light icons on Silent Black, dark icons on Paper. Splash and window background follow the system light or dark setting (`res/values-night`).
- Back button (`MainActivity.java`, `src/lib/backStack.ts`): every open sheet adds one history entry; the native callback goes back while the WebView has history and exits otherwise. Order: close the sheet, then earlier screens, then leave the app (`test/back-stack.test.ts` models this).
- No backup: `allowBackup="false"`, `fullBackupContent="false"` and `data_extraction_rules.xml` exclude all app data from cloud backup and device transfer.
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
