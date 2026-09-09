# Development

How Logbook is laid out, run, tested and shipped. For what the app does and why
it behaves the way it does, see the [README](../README.md).

## Files

| File | |
| --- | --- |
| `index.html` | the whole app: markup, styles and logic |
| `sw.js` | service worker — precaches the app so it opens with no signal |
| `manifest.webmanifest` | name, colours and icons for installing to a home screen |
| `icon-*.png`, `apple-touch-icon.png`, `favicon-32.png` | app icons |
| `img/*.webp` | exercise photos, start and finish, 44 files |
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

## Tests

```sh
npm ci
npx playwright install chromium
npm test
```

229 tests in `tests/`, run on every pull request and again before any deploy.
They cover the things that actually broke: that a logged set survives a reload
and a service-worker update, that `Log set` and the RIR selector are never
underneath the rest timer at phone sizes, that unit switching converts rather
than corrupts, that a backup round-trips, that blocked storage is reported
instead of retried forever, that a pain rating written before sites existed
still lands under Lower back, and that the app opens and keeps working with the
network off.

Layout assertions read real bounding boxes at 375×667 and 390×844, so a
regression that hides a control fails the build rather than being noticed in a
gym. Failures upload a Playwright report with traces, screenshots and video.

If your machine has a preinstalled Chromium that Playwright cannot download,
point at it with `CHROMIUM_PATH=/path/to/chrome npm test`.

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
being entered. It waits for a tap. The running version is shown as a badge in
the Settings header, so confirming an update landed is one tap.

## Deploying

`.github/workflows/pages.yml` publishes the repository root on every push to
`main`, but only after the test workflow it calls has passed. Live at
<https://hype-armor.github.io/WorkoutLogBook/>.

Three repository settings have to be set once, by hand:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.** Until
  this is set the deploy fails with "Pages site not found".
- **Settings → Actions → General → Workflow permissions → Allow GitHub Actions
  to create and approve pull requests.** Without it Release Please fails with
  `GitHub Actions is not permitted to create or approve pull requests`, and no
  release PR is ever opened.
- **Settings → Branches → Add branch protection rule** on `main`, with **Require
  status checks to pass before merging** ticked and `playwright` — the job name
  in `ci.yml`, which is what the check is called — added as the required check.
  This is the only thing that stops a red pull request being merged. See below.

## Gating merges on the tests

`pages.yml` already refuses to publish a build the suite rejects, so a red merge
cannot reach anyone's phone. What it cannot do is keep `main` green: the deploy
fails, the app stays on the last good version, and the broken commit is still in
the history. Requiring the check on `main` is what closes that.

Set the required check to exactly **`playwright`**. Status checks are matched by
name, and that is the job id in `ci.yml`, not the workflow's name (`Tests`).

Do **not** also require approving reviews. GitHub does not let you approve your
own pull request, so on a repository with one maintainer that setting makes
every pull request unmergeable.

"Require branches to be up to date before merging" is a separate tick and is not
needed here: it forces a rebase of the release pull request every time anything
else lands, and with changes going in one at a time there is nothing for it to
catch. Leave it off unless two branches are ever in flight at once.

Leaving **Do not allow bypassing the above settings** unticked keeps an admin
override, which is worth having: `ci.yml` runs on `pull_request`, and a run that
fails to start leaves a pull request with no check at all rather than a failed
one — which a required check treats as "not passed" forever. That happened to
the 1.13.1 release pull request, though not to any release since. The override
is one way out; the other, which does not weaken the rule, is that `ci.yml` also
has `workflow_dispatch`, so **Actions → Tests → Run workflow** against the stuck
branch puts a real `playwright` check on its head commit.

Turning Pages on also offers to commit a starter workflow of its own,
`static.yml`. Decline it, or delete it afterwards: it uploads and deploys with
no test step, so a red build would publish anyway, and two workflows sharing
the `pages` concurrency group only queue behind each other.
