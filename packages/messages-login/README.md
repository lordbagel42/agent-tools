# @agent-tools/messages-login

This one-time local Electron helper signs in to Google in a fresh, temporary session and hands the Google session cookies required by the Messages server to a pairing portal you choose. The helper is not a background bridge; after pairing, the server runs independently and the helper can be closed.

## Security warning

The transferred values are **broad Google Account session credentials, not a Messages-only token**. The destination server will store them server-side. Run this only for a server origin you control and trust. The helper never reads an existing browser profile, and its Google and portal sessions are nonpersistent and isolated from each other.

## Run

Install Node.js 22.12 or newer, then extract the bundle and run:

```sh
npm install
npm start -- https://pairing.example.com
```

The argument must be exactly one HTTPS origin. Paths, queries, fragments, user information, and HTTP URLs are rejected. TLS errors are not bypassed.

To update the helper, close it, download the latest bundle from the pairing portal, and extract it into a new folder. Run the commands above there; refreshing the portal alone does not update the local helper code.

1. Complete the portal's normal PIN authentication in the first window.
2. Use the portal's connect action. A separate local Google window opens at Google's Account Chooser; it does not use a saved browser profile or automation.
3. Sign in to the intended account. No credentials or SMS codes are included with this helper.
4. At the native confirmation dialog, verify the exact destination origin and approve only if you accept server-side storage of broad Google session credentials.
5. A successful handoff means only that the server accepted the credentials. It does **not** mean pairing is complete. Follow the portal status, compare the emoji, and approve it on the phone.
6. Close the helper after the portal reports that pairing is complete.

The helper sends only `SID`, `HSID`, `SSID`, `OSID`, `APISID`, `SAPISID`, and, when present, `__Secure-1PSIDTS`. It does not expose those values to either renderer, log them, or save them locally. If a completion request has an uncertain outcome, the helper does not retry it; check the portal before starting over.

To revoke access, remove the saved server session and sign the session out from your Google Account's device/session controls.

## Development

From the repository root, install with `npm ci` using the single workspace lockfile. Run these commands from `packages/messages-login`. This Electron desktop companion intentionally has no CLI bin or Amp plugin entry point. Live Google authentication remains unverified; the underlying Messages protocol is unofficial and experimental.

```sh
npm test
npm run test:electron
npm run build
npm run check
npm run bundle
```

`test:electron` exercises the actual sandboxed helper through a separate-origin PIN form, using offline fixtures and both Continue and Enter. It needs a display; on headless Linux, use `xvfb-run --auto-servernum npm run test:electron`. It checks that the login page cannot trigger Google sign-in or navigate to an unrelated site, then starts authenticated setup with clock skew, opens the isolated Google window, and cancels without transferring credentials. It also checks safe HTTP-error and expired-portal diagnostics, including Electron's rejection of manual redirects.

`npm run bundle` creates `dist/messages-login-helper.zip`, served by the sibling `packages/messages` pairing listener. The archive has a single `messages-login-helper/` root and contains instructions, configuration, source/tests, and compiled runtime. It intentionally excludes workspace lockfiles, `node_modules`, platform binaries, browser profiles, and secrets. Extracted bundles use `npm install` to fetch Electron for the desktop's platform; unlike repository installs, their dependency resolution is not locked. Never commit the generated archive or Electron binaries. Linux needs Electron's desktop libraries, a display (or Xvfb for fixtures), and working Chromium sandbox support.
