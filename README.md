# Logbook

A lifting logbook that works offline. Sets, plate math, a rest timer, superset
pairing, and pain tracking by site. Data lives in the browser on your device —
nothing is uploaded anywhere.

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

197 tests in `tests/`, run on every pull request and again before any deploy.
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

Two repository settings have to be set once, by hand:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.** Until
  this is set the deploy fails with "Pages site not found".
- **Settings → Actions → General → Workflow permissions → Allow GitHub Actions
  to create and approve pull requests.** Without it Release Please fails with
  `GitHub Actions is not permitted to create or approve pull requests`, and no
  release PR is ever opened.

Turning Pages on also offers to commit a starter workflow of its own,
`static.yml`. Decline it, or delete it afterwards: it uploads and deploys with
no test step, so a red build would publish anyway, and two workflows sharing
the `pages` concurrency group only queue behind each other.

## Estimated max

Built only from sets taken to 2 reps in reserve or harder, and shown rounded to
the smallest jump your plates allow.

Both rules exist for the same reason. Reps in reserve is added to reps in the
Epley formula, so a set left further from failure scores *higher* — the same
weight for the same reps read as a smaller max once you reported working
harder, and `4+`, the least precise point on the scale, produced the highest
number of all. Past 2 RIR the estimate was moving on how you rated the set
rather than on what you lifted.

Rounding follows the rack because that is the real resolution: with 2.5s the
step is 5, with 1.25s it is 2.5. The rounding happens once, where the series is
built, so the number on the card, the percentage beside it and the line under it
all describe the same values.

For a bodyweight lift the figure is what you could **add**, not you plus it — a
set of unweighted dips reporting "195 lb" read as a barbell number with nothing
on the belt.

A card whose sessions did not all qualify says so: `1 of 2 sessions counted`
rather than `first session`, which contradicted the rows listed underneath it.

## The exercise guide

The ⓘ on the exercise screen opens two photos — start and finish — with the
muscles worked and the steps. The photos and steps come from
[free-exercise-db](https://github.com/yuhonas/free-exercise-db), released under
the Unlicense (public domain), resized to 560px WebP: 44 files, about 830KB.
Two exercises have no exact photo in that set and show the nearest match, and
say so — a suitcase carry is shown by a farmer's walk, a Bulgarian split squat
by a plain split squat. The button is hidden for exercises the guide does not
know, which includes anything you add yourself.

The photos are precached, so the guide works in a gym with no signal, but in a
cache of their own: an app release purges the previous app cache and would
otherwise re-download 830KB of photos that had not changed. `MEDIA_VERSION` in
`sw.js` is bumped by hand when they do.

## Finishing an exercise

The set that completes a target does not start a rest timer — there is no next
set to rest for. In the timer's place a panel names what you just finished and
what comes next, with a button that takes you there: the next unfinished
exercise below this one, wrapping to the top only once nothing is left
underneath. On the last one it offers the way back to the list instead.

## Rep ranges

Under the reps field the app names what that count usually trains: 1–5 strength,
6–15 size, 16–30 endurance, past 30 a very long set. The cut points follow load —
5 reps is about 87% of a one-rep max, 15 about 65%, 30 about 50%.

The copy is deliberately hedged, because the evidence is softer than the usual
chart. Heavy low reps are the *best* way to raise a one-rep max, not the only
thing that builds strength. Muscle grows anywhere above roughly 30% of your max —
a rep count past 50 — provided the set is taken near failure, so "5 to 30" is a
practical convention rather than a finding. Whether high reps are specifically
better for endurance is the weakest claim on the chart; the review that
re-examined the repetition continuum calls it equivocal, hence "probably".

High reps are not cardio. That is a different session, not a rep count.

Every rendered line must stay under 92 characters: that is where it wraps to a
third row at 375px and the block starts jumping under your thumb. A test asserts
the height is identical across all four bands and the blank state.

## When the weight goes up

A session earns the next weight by being completed at the one it used: every
prescribed set, every prescribed rep, and nothing taken to failure. Fall short
of any of those and the same weight comes back, with the sheet saying which —
`repeating — 3 of 4 sets`, `short of 4 reps`, `a set went to failure`. RIR 0 is
failure by definition, wherever in the session it happened.

Adding load to a session you could not finish is how a lift stalls for a month.

## How long it will take

The exercise list carries an estimate of what is left of the day. It is not a
rest-plus-guess model: the interval stored on every set is the whole gap from
the previous set to it — the rest and the set itself together — so the lifting
time is already inside the numbers the app has recorded. The estimate is the
median of your own intervals for each exercise, times the sets you have left.

An exercise with fewer than three recorded intervals falls back to its rest
target plus the median amount by which your sets run over their rest, which is
as close as the log comes to measuring setup and lifting on their own. With no
history at all it is the rest target plus 45 seconds.

Medians rather than means, over intervals clamped to between 15 seconds and 15
minutes: a phone call in the middle of a session should not teach the app that
your sets take two hours.

Once the session is finished the same spot reports what it actually took, from
the first set to the moment you tapped Finish. History reads the same helper,
so the two cannot drift apart.

It shows nothing only when there is nothing to say — every target met but the
session still open, or a day whose targets carry no set count (`max` rather
than `3 × max`), since without one there is no way to know how many sets are
coming.

## Pain

Rated 0-5 per site, once a day, whether or not you trained — a rest day that
hurts is data. Eleven sites are available; the card shows only the ones you
track, plus any already rated on the day you are looking at, so an old rating
is never hidden from the only control that can edit it. Sites that come in
pairs take an optional left/right tag, which carries forward rather than being
re-answered daily.

History charts one site at a time. Putting a knee and a lower back on the same
strip would imply a relationship the data does not carry.

Six levels rather than eleven: the whole scale fits one row, and nobody can
tell a 6 from a 7 about their own back. Ratings written on the old 0-10 scale
are halved on load, once — the migration is gated on the stored version, since
every 0-5 rating is also a valid 0-10 one.

## Your data

Stored in `localStorage` under `logbook-v1`, on the device only. The app asks
the browser to mark that storage permanent so it is not evicted under storage
pressure — Settings reports whether the request was granted — but the grant is
the browser's to give, and clearing site data erases everything regardless.

So it still nags: after eight sessions without one, a banner offers a backup.
**Settings → Download backup (JSON)** round-trips through **Restore from
backup**. The CSV export is for spreadsheets and does not restore.

If a device blocks storage (private mode, a full disk), a banner says so
instead of failing quietly.
