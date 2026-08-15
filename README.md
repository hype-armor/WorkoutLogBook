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

**Bump `VERSION` in `sw.js`.** A browser only checks for a new service worker
when that file's bytes change. Edit `index.html` alone and installed users pick
the change up a launch later, via the background refresh, without ever being
offered it. Bumping `VERSION` shows them a "new version is ready" prompt and
purges the old cache.

The prompt never reloads the page on its own — that would discard a set being
entered. It waits for a tap.

## Your data

Stored in `localStorage` under `logbook-v1`, on the device only. Clearing site
data erases it, so use **Settings → Download backup (JSON)** now and then;
**Restore from backup** reads it back. There's a CSV export for spreadsheets,
but only the JSON backup round-trips.

If a device blocks storage (private mode, a full disk), a banner says so
instead of failing quietly.
