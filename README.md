# Logbook

A lifting logbook that works offline. Sets, plate math, a rest timer, superset
pairing, and back-pain tracking. Data lives in the browser on your device —
nothing is uploaded anywhere.

## Files

| File | |
| --- | --- |
| `index.html` | the whole app: markup, styles and logic |
| `sw.js` | service worker — precaches the app so it opens with no signal |
| `manifest.webmanifest` | name, colours and icons for installing to a home screen |
| `icon-*.png`, `apple-touch-icon.png`, `favicon-32.png` | app icons |
| `version.txt`, `release-please-config.json` | release automation, see below |

## Running it

Open `index.html` directly and it works — logging, plate math and history all
run from the file. What you don't get that way is offline install: service
workers need `http(s)`, so from `file://` the app simply skips registration.

To get the installable version, serve the folder over HTTP:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

Any static host works — GitHub Pages, Netlify, a Raspberry Pi. Paths are all
relative, so serving from a subdirectory (`user.github.io/WorkoutLogBook/`) is
fine. On the phone, use the browser's "Add to Home Screen"; after that it opens
full-screen and offline.

## Shipping a change

Pushing to `main` deploys to GitHub Pages and updates a standing release PR.

Releases are handled by [Release Please](https://github.com/googleapis/release-please),
driven by commit messages:

```
feat: add a plate calculator for dumbbells     -> minor bump
fix: rest timer drifts when the tab is hidden  -> patch bump
docs: ...  ci: ...  chore: ...                 -> no release
```

Anything without one of those prefixes is ignored, so it never reaches the
changelog. Add `!` (`feat!:`) or a `BREAKING CHANGE:` footer for a major bump.

Merging the release PR tags the version, writes `CHANGELOG.md`, and rewrites
the version in `version.txt`, `sw.js` and `index.html`. That last part matters:
a browser only checks for a new service worker when `sw.js` itself changes, so
the bump is what makes installed clients notice a release at all. Edit
`index.html` alone and users pick the change up a launch later, via the
background refresh, without ever being offered it.

The update prompt never reloads the page on its own — that would discard a set
being entered. It waits for a tap. The running version is shown at the bottom
of Settings.

## Deploying

`.github/workflows/pages.yml` publishes the repository root on every push to
`main`. It needs Pages switched on once, by hand:

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Until that is set the workflow fails with a "Pages site not found" error.

## Your data

Stored in `localStorage` under `logbook-v1`, on the device only. Clearing site
data erases it, so use **Settings → Download backup (JSON)** now and then;
**Restore from backup** reads it back. There's a CSV export for spreadsheets,
but only the JSON backup round-trips.

If a device blocks storage (private mode, a full disk), a banner says so
instead of failing quietly.
