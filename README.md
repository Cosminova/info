# Cosminova

A real-scale solar system you can fly through. Bodies sit at their true
distances in kilometres and are rendered from measured imagery and elevation, so
one continuous scene runs from four billion kilometres out to a few metres above
a crater floor — thirteen orders of magnitude without a cut or a scale change.

Built with [Three.js](https://threejs.org) and WebGL2. No game engine, and no
pre-rendered imagery of the scene itself.

## Two views

The same catalogues and ephemerides drive two pages, and the top bar of each
links to the other.

- **`index.html`** — the solar system in 3D. You pick a body and fly to it;
  surfaces are spacecraft imagery over measured or procedural relief.
- **`sky.html`** — the sky from a point on Earth's surface. The celestial
  sphere is rotated into your local horizon frame for a given latitude,
  longitude and instant, with the atmosphere scattering sunlight into twilight
  and the visibility limit tracking sky brightness, so moonlight and light
  pollution wash out faint stars the way they do outdoors. Its **Free space**
  mode lifts the horizon away to show the whole sphere at once.

## Running it

```bash
npm install
npm run dev
```

Then open the printed URL. For a production build:

```bash
npm run build
npm run preview
```

The runtime assets in `public/data` and `public/textures` are committed, so the
app runs straight after `npm install`. You only need the asset pipeline if you
want to regenerate them (see [Asset pipeline](#asset-pipeline)).

### As a desktop application

The desktop build is the same renderer loaded off disk instead of over HTTP,
which works without any path juggling because `base` is `'./'`. What it buys
over a browser tab is the GPU: a packaged Chromium can be told to prefer the
discrete adapter, which a page cannot ask for.

```bash
npm run desktop     # builds, then opens it in Electron
npm run dist:win    # builds a Windows installer into release/
```

`dist:win` produces an NSIS installer and only really works on Windows; the
[Windows build workflow](.github/workflows/windows.yml) runs it on a Windows
runner and attaches the result to a release when a `v*` tag is pushed. The
installer is not code-signed, so SmartScreen warns once on first run.

`desktop/main.js` is the whole of the shell: one window, a menu that switches
between the two views, and a preload bridge exposing nothing but the platform
name.

### The landing page

`site/` is a hand-written static page — no build step of its own. It is
published alongside the app by [the Pages workflow](.github/workflows/pages.yml),
which assembles both into `_site`:

```bash
npm run build                  # the app, into dist/
node scripts/build-site.mjs    # _site/ = landing page at /, app at /app/
```

Its screenshots are not hand-exported. `node scripts/site-stills.mjs` captures
them from the running app at the same camera positions the film uses, so they
can be regenerated when the renderer changes, and `node scripts/site-check.mjs`
screenshots the page at two widths and asserts the download buttons are wired
the way they are meant to be.

### Serving it

`npm run dev` is for editing: it rebuilds on save and is slower to load, because
nothing is bundled. To run the real thing on your own machine, build it once and
serve the build:

```bash
npm run serve      # builds, then serves on 0.0.0.0:5180
```

That is reachable at `http://localhost:5180` and, from a phone or another machine
on the same network, at the host's LAN address on the same port. Anything on that
network can reach it while it runs, and nothing outside can.

There is no server-side anything: `npm run build` writes a static `dist/` with no
API keys and no calls off the origin, and `base` is `'./'` so it works from a
subdirectory as happily as from a domain root. Any static file server will do,
including one with no Node in it at all:

```bash
npm run build
cd dist && python3 -m http.server 8099
```

Two numbers are worth knowing before serving it to anyone else. `dist/` is about
177 MB, nearly all of it body imagery and the lunar elevation pyramid, the
largest single file being `moon-dem-4096.png` at 17 MB. A first visit transfers
about 38 MB over 50 requests — the far texture tier for whatever is in view, the
star catalogue, and the spacecraft trajectory table. Near-surface textures are
only fetched on approach, so the cost grows with how far a visitor travels rather
than with the size of `dist/`.

Serve it with compression on if you can. The imagery is already JPEG and PNG and
will not shrink, but the trajectory table and catalogues are raw binary and the
bundle is plain JavaScript: gzip takes roughly 3 MB off that first load, measured
as the difference between `vite preview` and a static server with compression
switched off.

One caveat over a LAN address: the sky view's *locate me* button uses browser
geolocation, which is only permitted on HTTPS or on localhost, so it does nothing
over plain HTTP to an IP address. The latitude and longitude fields beside it
still work.

## Controls

Flying (`index.html`):

| Input | Action |
| --- | --- |
| Drag | Orbit the current body; right-drag looks around |
| Scroll / pinch | Approach and retreat, from far outside the orbit to ground level |
| Click | Select what is under the cursor |
| Right-click | Object menu — go to, orbit, follow, track, land, find parent or moons |
| `G` `O` `T` `L` | Go to, orbit, track, land on the selection |
| `W` `S` | Thrust along the view; `A` `D` slide across it |
| `E` `Q` | Climb and dive |
| `Shift` | Four times the speed, held |
| `F` | Swap between orbiting the target and flying free of it |
| Space, arrows, `N` | Pause, step the rate, jump to now |

Thrust goes wherever the camera is pointing, not towards the target, so drag to
aim and then hold `W`. Speed is proportional to your altitude — metres per
second on a surface and a good fraction of a light year out in the halo —
because a single fixed speed cannot serve a scene thirteen orders of magnitude
deep.

Pressing any of those switches the camera out of orbit by itself, so flying
does not have to be armed first. Choosing **Free** or **Track** under camera
mode does the same thing deliberately, and brings up an on-screen pad laid out
the way the keys sit under your left hand — usable with the mouse alone, and
there mostly so that the keys above are discoverable without reading this.

From the ground (`sky.html`):

| Input | Action |
| --- | --- |
| Drag | Turn your head; the horizon never tilts |
| Scroll / pinch | Zoom from a 110° naked-eye field to seven arcseconds |
| Click | Identify a star or deep sky object, and hold it centred |
| Arrows, `+`, `−`, `R` | Pan, zoom, reset the view |
| `G` / `F` | Ground or free-space view |
| `C`, `Z`, `T`, Space | Constellation figures, frame the selection, release it, pause time |

Both views share the same interface keys:

| Key | Action |
| --- | --- |
| `F1` | Help, including the full key list |
| `F2` | Search |
| `F3` / `F4` | Object information, navigation or coordinates |
| `F5` | Object labels |
| `F10` | Interface settings — scale, opacity, accent |
| `F11` | Immersive mode: hide the entire interface |
| `Esc` | Close the topmost thing, innermost first |

Every one of those is rebindable: open help and click the key you want to
change, then press the new one. Bindings are saved with the rest of your
preferences.

Search takes proper names, Bayer letters, Messier and NGC numbers,
constellations, planets and moons. A result can be travelled to, centred, set as
the target or bookmarked without leaving the keyboard.

## Interface

The interface is meant to stay out of the way of the thing it is looking at.
Panels are pinned to the edges of the window, the centre column of the layout
holds nothing but the reticle, and everything can be collapsed to a header or
hidden outright. `F11` removes all of it for a clean screenshot.

Both views are built from one design system:

- **`src/ui/theme.css`** — tokens and primitives. Scale, panel opacity and accent
  hue are custom properties on the document element, so changing any of them
  retints and resizes the whole interface in a single write, with no stylesheet
  or component involved. Panels, buttons, fields, readouts, menus, dialogs, the
  navigation rail, the search results and the region layout all live here.
- **`src/style.css`** and **`src/sky.css`** — only what belongs to one view: the
  explorer's bottom HUD, scale bar, system tree and hover bracket; the
  planetarium's sky labels, selection ring and coordinate grid.
- **`src/ui/dom.js`** — write-only-on-change helpers. Readouts are driven from
  the render loop, and `textContent` invalidates layout whether or not the string
  differs, so `text()` compares first and `reconcile()` rebuilds a list only when
  its shape changed. That is what keeps the object panel from being rebuilt sixty
  times a second because the distance ticked over.
- **`src/ui/prefs.js`** — everything the user can change about the interface,
  persisted to `localStorage` with debounced writes and merged over defaults so an
  older saved shape still loads.
- **`src/ui/shortcuts.js`** — the binding registry behind the rebindable keys.
- **`src/ui/components.js`** — the shared panel, slider, checkbox, segmented
  control, tooltip, menu and dialog.
- **`src/ui/explorer-ui.js`** and **`src/ui/sky-ui.js`** — one composition module
  per view. The planetarium's controls were already wired by element in
  `main.js`, so its shell drives those same elements rather than taking them
  over; there is one handler per control, and one handler per key.

Labels are budgeted rather than drawn for everything visible. Candidates are
ranked by whether they are the target, whether the object is major, how close to
the centre of the screen it is and how large it appears, then culled against a
screen-space grid so only one label survives per cell — so the names you get are
the ones you would have wanted, and there are never thousands of them.

## How the rendering works

**Scale and precision.** Positions are held in float64 on the CPU in a
heliocentric frame; because Three.js builds the model-view matrix in double
precision, the values reaching the GPU are already relative to the camera. A
logarithmic depth buffer covers the remaining range. The composer's offscreen
target is allocated with a stencil so its depth attachment is 24-bit rather than
the 16-bit a depth-only target would get, which is not enough to carry that
range: displaced terrain seen at a shallow angle collapses into z-fighting.

**Terrain.** Each solid body is a cube-sphere subdivided quadtree-style until
patches are small enough on screen, drawn as one instanced call with per-patch
basis vectors. Patches outside the view cone are not subdivided — at low
altitude nearly all of the near hemisphere is behind the camera, and without
that cull the patch budget is spent out of sight.

Refinement is best-first rather than depth-first, and that is what keeps terrain
from going missing. The selection begins as the six cube faces, which already
cover the sphere, and repeatedly replaces whichever patch has the largest
screen-space error with its four children. Every state along the way is a
complete cover, so exhausting the instance buffer can only leave the ground
coarse. Descending face by face instead commits the budget to whichever face
comes first in the list rather than to the one being looked at, and at low
altitude that does not degrade the view so much as delete it: from 40 km up, the
Moon was a black screen.

**No popping.** Four children replace their parent the moment the parent's error
crosses the threshold, and on its own that swap moves every second vertex at
once. So each child carries a factor that slides its vertices onto its parent's
lattice — rounding each grid index to the nearest even one, which lands the
in-between vertices on top of their neighbours and leaves a surface passing only
through points the parent also has. The factor reaches 1 exactly as the parent's
error returns to the threshold, so by the time the swap happens the children are
already the parent, triangle for triangle, and nothing moves.

The factor comes from the parent's error, not the child's own. The two are not a
clean factor of two apart — a patch's error is measured from the chord across it
and the distance to its own centre, and the cube-sphere's distortion and the
parent's different centre both move the ratio around — and it is the parent's
error the merge is actually tested against.

One discontinuity remains, in the elevation maps rather than the geometry: the
map tier is chosen from the deepest level in use, so it swaps between resolutions
as the camera descends and the terrain changes slightly when it does. Blending
across tiers would fix it.

**Geology.** Craters, fractures and ridges are statistically identical everywhere
they are applied, and a body built only from them reads as one texture wrapped
round a sphere however good the individual features are. Real surfaces are
provincial, and the divisions are the largest thing on them: the Moon is half
smooth mare and half saturated highland, and Mars has an entire hemisphere five
kilometres below the other. So a single coarse crust field is built first, and
everything regional keys off it — where lava ponds, where a rift opens, where
volcanoes stand.

Three processes act on it. Flooding is the one that matters most, and it is an
operator rather than a contribution: a smooth maximum against a datum, which
buries whatever lies below and leaves the half-drowned craters at the shoreline and
the ghost craters showing through the fill. Adding a smooth plain on top produces
none of that. The datum carries wrinkle ridges, the compressional ridges that cross
every mare on the Moon and every smooth plain on Mercury.

Flooding took four bugs to get working, and all four were invisible on screen —
the surface simply looked unchanged, which is indistinguishable from a camera that
is not over a province. Worth recording, because three of them were failures of
measurement rather than of the shader:

- The lava level was set from real mare elevations. The crater and roughness terms
  are deliberately exaggerated, one to two kilometres, so a real datum sits below
  the rendered rims and fills nothing. The level is now derived from a fill
  fraction of the province's own depth.
- `uMacroRelief`, the ridged-noise stand-in for regional relief, is a few
  thousandths of the radius and always positive: on Mars it lifted the whole
  surface seven kilometres above where the crust field put it, so no basin was ever
  below the lava. A body with geology no longer gets it — the crust field is what
  replaces it.
- The coverage-to-threshold mapping assumed the crust field's spread was 0.31 when
  it is nearer 0.19, which put every threshold into the tail: a province asked to
  cover a quarter of a body covered a twelfth.
- The check sampled a day and a half of dates for every body. That turns Mars over
  more than once, but Mercury through eight degrees and Venus through two, so every
  view landed on the same ground. It now samples one full rotation of whichever
  body it is looking at.

Rifts are
flat-floored and terraced rather than V-shaped notches, because a collapsed graben
is not a crack. Shield volcanoes are convex-up domes with summit calderas, placed
on high ground since a volcanic province is built up by its own output — Olympus
Mons is 600 km across and 22 high, a slope of four degrees, and drawing one as a
mountain gets it wrong in the most visible way.

Which processes acted on a body, and how far, is its history rather than anything
to derive from noise, and for the bodies we have visited it is known. So this
follows the figures: measured values for Mars, Mercury, Venus and Io, and a
derivation elsewhere. A body with a measured elevation map is left alone, since
its real geology is already in the map — flooding the Moon procedurally would lay
invented mare over the actual ones.

The derivation turns on how long a body stayed hot. It resurfaces itself while it
has heat to drive the process, generates that heat throughout its volume and loses
it through its surface, so the timescale goes with radius: small bodies froze early
and kept every crater, large ones are still going. That one argument puts the Moon
and Ceres at one end with nothing, Mercury with plains but no edifices, Mars with
everything in moderation, and Venus resurfaced almost entirely — which is the
observed order. Tidal heating overrides it, which is why Io is molten at a quarter
of Earth's radius while Callisto, larger, is a dead cratered iceball.

Each process has its own uniform so it can be switched off by itself. Telling a
procedural artefact apart from a real feature means rendering the same frame with
one term missing, and `npm run shoot diagMarsRiftOnly` and its neighbours do
exactly that. `diagMarsFloodMap` goes further and draws the province mask and the
fill depth directly rather than leaving them to be inferred from shading, which is
what finally located the bugs above; `scripts/uniform-probe.mjs` prints a body's
terrain uniforms off the running page, since a term that is zero, a term being
swamped by another, and a term whose uniform never existed all look the same.

`npm run check:geology` measures how much of a body is anomalously flat against the
same body with its geology removed. Mars comes out 45% plains against 2%, Mercury
13% against 1%, Venus 21% against 1%. It measures relief rather than colour on
purpose: every body already has its own palette, so any statistic that responded to
hue would pass whatever the terrain was doing, which is the exact failure the whole
exercise is meant to prevent.

**Figure.** No body is drawn as a sphere unless it is one. Twenty-eight carry
published limb fits, which is the only way to get the shapes a formula cannot
predict: Iapetus is 4.5% oblate on a 79-day rotation far too slow to raise such a
bulge, because the bulge is a fossil of the much faster spin it had while still
warm, and Vesta is flattened further still by the impact that took most of its
southern hemisphere. Where there is no measurement but the body is large enough
to have relaxed, the equilibrium figure follows from its own mass, its primary's
and its orbit — `(a - c)/R = (25/6)q` with the axes in a 4:1 ratio, which lands
within a factor of 1.4 of every published figure it can be checked against.
Below the relaxation crossover the shape is a collision shape, drawn as an
ordered random ellipsoid with low-frequency relief on top; the shortest axis is
the spin axis, because a body spinning about its long axis is not in the lowest
energy state for its angular momentum and friction takes it out of that state
long before anyone sees it.

**Relief.** Measured elevation drives displacement, and procedural craters carry
the detail below what the elevation map resolves. Both are band-limited to what
the screen can actually resolve at each point, including a foreshortening factor
for ground seen at a shallow angle, and both fade continuously — a decision made
per patch instead would build different terrain either side of every subdivision
boundary and leave a cliff along it.

**Craters.** Worley-based octaves, each with a parabolic cavity, raised rim and
ejecta blanket, layered destructively so newer craters cut into older ones.
Gradients come out analytically alongside the height. The lattice is hashed with
integer arithmetic (PCG3D) rather than the usual `fract(sin(dot(...)))`: the
finest octave samples a grid tens of thousands of cells across, where a sine of
that argument has no float32 precision left and the terrain collapses into
streaks.

**Shading.** Albedo from photographic maps, slopes from a normal map baked
alongside each elevation tier, and inverse-square sunlight. Airless bodies use
Lommel-Seeliger photometry rather than Lambert, which is why a full moon reads
flat instead of limb-darkened. Sunlight is referenced to the body being looked
at, the way a camera is stopped down for its subject: Mercury receives five
times Earth's irradiance and Neptune a thousandth, and either would clip or
vanish on a fixed scale.

**Sunlight and shadow.** The fraction of the Sun's disc a point can see is
solved analytically rather than smoothed with a step function. Two terms
multiply: how much of the disc clears the local horizon, and how much of it each
occulting body covers. Both come from the same circular-segment and lens-area
formulae, so a total eclipse, an annular one and a grazing partial fall out of a
single expression, and the penumbra is exactly as wide as the Sun is large
instead of as wide as a tuned constant. Two occulters are tracked, which is what
a moon inside its planet's shadow and another moon's needs. Nothing is floored:
an eclipsed surface reaches zero direct sunlight.

**Secondary light.** What remains on the night side is earthshine and its
equivalents — the host's albedo times the solid angle it subtends times its
illuminated fraction as seen from the moon, which puts the Moon's at 1.2e-4 of
sunlight and Europa's from Jupiter fifty times higher. A body eclipsed by one
with an atmosphere also gets refracted light through it, which is why a totally
eclipsed Moon is copper rather than absent. Both are capped well below direct
sunlight and compressed for display, so they are visible without ever competing
with day.

**Rings.** Optical depth, not opacity: the shadow the rings cast on the planet
is Beer-Lambert through a slab, so the band widens and deepens as the Sun
approaches the ring plane. The rings' own brightness is the single-scattering
solution for a slab lit at one elevation and viewed from another, which inverts
correctly when back-lit — dense sections go dark while the Cassini division
brightens, the reverse of the front-lit case. A gain restores the multiple
scattering the single-scattering form omits.

**Sky.** Stars and the Milky Way are drawn into their own pass with depth
cleared afterwards, so they stay behind objects billions of kilometres away
without having to sit inside the depth range. Output is ACES tone mapped with a
bloom pass.

## Spacecraft

A hundred and nineteen spacecraft, landers, rovers and landing sites are in the
same universe as the bodies, at whatever position the simulation date puts them
in. Selecting one draws its trajectory and its velocity vector; VIEW FROM
SPACECRAFT puts the camera on it.

Where each one is comes from one of four mechanisms, in order of preference:

- **A sampled trajectory.** `public/data/craft-paths.bin` holds 359,204 state
  vectors for 100 craft, fetched from [JPL
  Horizons](https://ssd.jpl.nasa.gov/horizons/) and interpolated with a cubic
  Hermite spline through position and velocity, which reproduces the sampled
  motion to a fraction of a percent. Samples are spaced by how much the path
  bends rather than by time, so a Jupiter flyby is dense and a cruise is nearly
  empty — Cassini's Saturn tour is 216 points where a fixed cadence would need
  160,630.
- **Kepler elements**, propagated from a single epoch. Used for craft in orbit
  around a body, where Horizons publishes an ephemeris too short to sample or
  none at all, and for the escape asymptotes of the craft that have left.
- **A surface fix.** A rover or a landing site is a latitude and longitude on a
  body, placed on the elevation the renderer actually draws there — read back
  from the terrain shader, not recomputed in JavaScript, so a lander cannot end
  up under the ground it is standing on.
- **A generated orbit**, for the invented craft around procedurally generated
  systems.

Each craft carries a provenance tier, and the inspector always shows it:

| Tier | Means |
| --- | --- |
| Fitted trajectory | A Horizons solution fitted to tracking data, at a date it covers. The path shown is the path flown. |
| Predicted trajectory | The same solution extrapolated past the last tracking data. |
| Osculating elements | Elements from one epoch solved as a Kepler orbit. Accurate near the epoch, drifting away from it. |
| Measured position | A surface position measured from orbital imagery. |
| Estimated position | A surface position known only approximately. |
| Procedural | Generated for this system. Not a real spacecraft. |

The tier follows how each frame's position was actually arrived at, not what the
mission record wishes it were: a craft can be a fitted trajectory during cruise,
Kepler elements in orbit, and a fixed point once it has landed, and the label
changes with it.

Trajectories are refetched with:

```bash
node scripts/craft-fetch.mjs                          # all craft
node scripts/craft-fetch.mjs --only=voyager1,cassini  # named craft only
node scripts/craft-fetch.mjs --probe                  # what Horizons has, and for what dates
```

`--probe` asks Horizons for each craft and reads the coverage out of its own
error messages, which is the only way to find out what a spacecraft's ephemeris
actually spans.

Missions Horizons has no solution for — Magellan, the Viking orbiters, the Venera
landers, every Apollo command and lunar module except Apollo 10's — are not in
the roster at all. The ones that reached a surface are there as landing sites, at
coordinates measured from orbital imagery; the rest are absent. A spacecraft with
no data is better missing than placed somewhere plausible and labelled as real.

## Asset pipeline

```bash
npm run fetch:assets   # downloads raw imagery and elevation into data-src/
npm run build:tex      # writes public/textures/bodies + manifest
npm run build:data     # star catalogue, deep sky objects, Milky Way panorama
```

Colour maps are emitted at two tiers, a small one fetched up front so nothing is
ever untextured and a large one fetched on approach.

Elevation gets a per-width pyramid so the renderer can match texel size to
vertex spacing. Two details in there are easy to get wrong and expensive to
diagnose:

- The 16-bit source is decoded with `toColourspace('grey16')` and
  `raw({ depth: 'ushort' })`. Left to its defaults sharp hands back three 8-bit
  channels, and reading those bytes as 16-bit samples shreds the data — two
  bytes per sample against three per pixel puts every row a third of a pixel out
  of phase, which shows up as ridges across the whole surface.
- Heights ship as a lossless PNG with the value split across two 8-bit channels,
  and are unpacked in the browser into a single-channel half-float texture. A
  packed pair cannot be filtered, because averaging a high byte against a low
  byte invents kilometre cliffs. The mip chain is built on the CPU: a
  one-channel half-float texture is not colour-renderable, so `generateMipmap`
  does nothing for it and every request for a coarser level silently returns
  full resolution.

Surface normals are baked from each elevation tier into an ordinary 8-bit
texture, which the hardware can mipmap and anisotropically filter. Differencing
the packed elevation in the shader instead needs a sample stencil wide enough to
smear the surface into streaks at a shallow angle.

`data-src/` is not committed. `npm run fetch:assets` retrieves body imagery from
[Solar System Scope](https://www.solarsystemscope.com/textures/) (CC-BY) and
lunar elevation from NASA's LOLA-derived CGI Moon Kit. For the sky data you also
need:

- `hygdata_v41.csv` — [HYG database v4.1](https://github.com/astronexus/HYG-Database)
- `dsos.*.json`, `constellations*.json`, `asterisms.json`, `starnames.json`,
  `milkyway.json` — [d3-celestial](https://github.com/ofrohn/d3-celestial) data
- `milkyway_eso.jpg` — [ESO Milky Way panorama](https://www.eso.org/public/images/eso0932a/)
  by S. Brunier, downsampled to 6000×3000

## Verification

```bash
npm run shoot                    # all scenarios
npm run shoot moonSurface earth  # named scenarios only
```

This serves the built app, drives it through headless Chrome and writes PNGs to
`shots/`, reporting altitude, patch count, resident elevation tier, decoded
relief range, brightness statistics and console errors. Time is frozen so a
scenario is reproducible to the frame, and each scenario frames its subject
relative to the sun so it is reliably lit wherever the body is in its orbit.

Brightness is measured from the saved file rather than the live canvas: without
`preserveDrawingBuffer` the canvas reads back empty once the frame is
composited, which silently reports every scene as pure black.

Scenarios prefixed `diag` isolate one term of the surface shader at a time —
procedural relief alone, measured relief alone, elevation flattened but its
normals kept, skirts collapsed, mip level pinned. They only run when named, and
they are the fastest way to tell which of several overlapping terms an artefact
belongs to.

`window.cosminova` exposes the same hooks for use in the browser console:
`target`, `lookFromSun`, `loadDetail`, `setDate`, `setRate`, `setExposure`,
`setBloom`, `setUniform`, `stats`.

### The lighting

```bash
npm run check:light
```

Sixty-three checks in three layers. The first compiles the shadow functions into
a throwaway fragment shader and compares them on the GPU against numerical
integration of the same geometry, which catches a wrong formula independently of
any scene. The second checks the secondary-light physics against measured
values — earthshine at 1.2e-4 of sunlight, Jupiter-shine on Europa fifty-one
times that. The third drives the real views: night sides stay dark on seven
bodies, the terminator sits where `(1 + cos θ)/2` says it should at three phase
angles, an occulter blacks a moon out and an undersized one leaves the predicted
annulus, and the rings shadow the planet and the planet the rings.

The scene layer measures ratios rather than absolute levels, so exposure changes
cannot quietly satisfy it. Two details matter: lit width is the longest
contiguous run of lit pixels, because taking first-to-last lets a background star
count as surface; and frames are settled by counting `requestAnimationFrame`
callbacks rather than sleeping, because the camera flight is frame-driven and a
wall-clock wait measures whatever half-arrived state exists at that moment.

### The shapes

```bash
npm run check:shape              # tables, derivation, rendered outlines
node scripts/shape-check.mjs scene
```

The layer worth having is the middle one. Nine bodies have both a published limb
fit and a known mass, so the equilibrium figure can be derived and then compared
against the measurement it never saw — the derivation lands between 0.66 and 1.39
times observed across all nine, which is a test of the physics rather than of the
transcription.

The last layer renders four bodies and measures their outlines, because
everything above it would still pass if the axis scales never reached the GPU.
The predicted outline is the ellipsoid projected along the actual view direction,
computed as the singular values of the axis scaling restricted to the screen
basis; assuming the pole is vertical instead would be checking a number with no
reason to be right, since a locked moon's pole follows its primary's tilt. The
outline is measured by row extents rather than an area fill, and the gain is
opened several stops first — Iapetus has an albedo of 0.05 on one hemisphere and
0.6 on the other, and at a natural exposure its dark limb sits at the detection
floor and the body measures rounder than it is. One check exists purely to catch
that class of mistake: no view of an ellipsoid can be more eccentric than its
longest axis against its shortest, so a measurement past that bound is a bad
measurement rather than a shape, which is the failure that looks most like a real
result.

### Terrain continuity

```bash
npm run check:lod                # Moon, Mars, Mercury
node scripts/lod-check.mjs moon
```

A pop lasts one frame, so it is measured rather than watched for. The sharp test
holds the camera still and compares a tessellation against the same one with a
level added: capped one level shallower to get the parent, then uncapped with the
new level pinned fully collapsed, which must reproduce the parent exactly, and
then pinned uncollapsed, which is the pop itself in the units the eye sees. Across
three bodies and three altitudes the collapsed render matches the parent to the
pixel, against pops of 4e-5 to 4e-4.

Pinning has to target one level. Pinning every level at once collapses each onto
its own parent, so the deep patches get compared against a coarsened version of
the thing they are meant to match rather than against the thing itself — which
reads as the morph making matters worse.

Three things had to be arranged before any of it meant anything. The dither pass
animates noise every frame and alone puts 2e-3 between two identical frames,
which is more than most of the pops; with it off, two renders of the same state
are bit-identical, so any difference is signal. The elevation map tier is chosen
from the deepest level in use, so capping the level can swap the map and change
the terrain underneath the comparison — the test reads the tier back and skips the
altitude when it moved. And a transition that changes almost nothing is skipped
too, since there is no sense in reporting that nothing was removed from nothing.

The second test walks the camera from 2.4 radii down to 1.03 in 56 steps and
compares each frame against the last, asserting that no single step stands out
against the median. It is much blunter, because the camera's own motion dominates
every difference, but it covers what the first cannot: level changes, map tiers
and the patch budget running out, all at once.

The third descends at zero phase angle, with the sun directly behind the camera.
Nothing casts a shadow the camera can see in that geometry, so the terrain either
fills the frame or it has a hole in it, and any dark pixel is a hole. This is the
one that matters most, because the failure it guards against is not cosmetic:
running out of instance slots is allowed to cost detail and is not allowed to cost
geometry.

### The spacecraft

```bash
npm run check:craft
```

Ninety-one checks over the roster, the geometry, the motion, the trajectories,
the detail levels, picking, the onboard camera and the procedural fleets.

The useful ones are the invariants no eye would catch. Reported velocity is
compared against the craft's own motion between two dates a minute apart, which
catches a position that is right and a velocity that is not — the two come from
different columns of the same file and nothing else would notice them
disagreeing. Attitude quaternions are checked for unit length, because a
left-handed basis produces one that shears the model rather than turning it, and
the model still looks like a spacecraft while it does. A craft on a surface is
checked against the ground height reported for the point it stands on, rather
than against the reference radius: measured relief runs to kilometres, so the
only sound test is that the placement and the terrain agree with each other.
The detail levels are measured at three distances and asserted to cross over
rather than switch, and the marker is required to be gone by the time the mesh
is readable.

The procedural section is the one that proves the architecture is not
Solar-System-only: it loads a generated system, checks the invented craft are
placed, orbiting bodies of that system, searchable, and labelled procedural
rather than real; approaches one to within metres and clicks on it; then leaves
and checks the fleet was unloaded with the system. Approaching is the part that
had to be built for — a probe eleven parsecs out cannot be positioned by
subtracting absolute coordinates, since doubles are spaced thirty metres apart
out there, so the camera carries an exact offset from the body it is anchored to
and craft in that body's frame are placed from it.

### The interface

```bash
npm run check:ui                 # layout, both views, five resolutions
npm run check:interact           # behaviour, both views
node scripts/ui-check.mjs sky 4k # one view, one resolution
```

`ui-check.mjs` loads a view at 1080p, 1440p, 4K, ultrawide and 1280×720 with
every panel open at once — the worst case for both layout and cost — and asserts
the two rules the layout exists to enforce: nothing but a label may overlap the
middle 44% of the screen, and nothing may extend past the window unless
something scrolls to bring it back. It also reports console errors and the frame
cost of the interface, though on a software renderer the scene dominates so
heavily that the percentage is noise; it says so when that is the case.

`flight-check.mjs` covers free flight and the pad that advertises it:

```bash
npm run check:flight
```

Most of it is interface — the pad appears in the flying modes and not in orbit,
holding a button moves the camera and releasing it stops, a key press lights
the matching button, and nothing is left holding thrust down when the pad goes
away. The last assertion is about the flight model instead, and is the one
worth keeping: it turns the view ninety degrees off the target before
thrusting, and fails if the camera closes on the target anyway. That is the
difference between flying and being reeled in, and it is invisible in any test
that thrusts while already pointed at something.

`ui-interact.mjs` and `sky-interact.mjs` drive what a screenshot cannot show:
immersive mode, panel collapse, rebinding a key and confirming the old one stops
working, the time controller reaching reverse, right-click picking, and
preferences surviving a reload. Any console error at any point is a failure, as
is any native dialog — nothing in the interface should open one.

Both harnesses wait on rendered frames rather than wall-clock time, because
under software rendering these scenes run at a fraction of a frame per second
and a sleep long enough to be reliable would make the run take an hour. For the
same reason, anything measured in pixels is read with animations disabled: a CSS
transition only advances when the page produces a frame, so a measurement taken
mid-flight can report the value the animation started from.

### The score

`src/engine/ambient.js` is the soundtrack. There are no audio files: every tone
is synthesised in the Web Audio graph at runtime, and there is no loop — eight
stems play continuously and crossfade with where the camera is, so the music has
no downbeat and no end.

The stems are `home`, `leave`, `deep`, `approach`, `land`, `alien`, `void` and
`wonder`, and `sceneWeights` turns camera state into a weight for each. They
overlap deliberately: arriving somewhere fades the travelling layers down rather
than switching cues, and `awe` is separate from the stem weights because the
discovery build layers on top of whatever else is playing.

The thing that makes the crossfades work is the harmony clock. All four chords
in the progression are diatonic to A minor and share most of their tones, and
every stem moves to the same chord at the same moment, each in its own register
and each gliding at its own rate. Without that, stems audible together drift
into different chords and any combination sounds like mud.

```bash
node scripts/audition.mjs                  # every scene
node scripts/audition.mjs --tour deep void # named scenes, walking the harmony
node scripts/audition.mjs --seconds 60
```

Renders each scene through an `OfflineAudioContext` in headless Chrome and
reports level, crest factor, stereo width and the spread of energy across seven
bands, then writes a WAV per scene to `audio-check/` so it can also be listened
to. It fails on the faults that are hard to hear but easy to measure: a stem
that makes no sound, a mix that clips, a modulator driving a gain negative, DC
on the output, a scene with no midrange, and a bass-heavy scene whose low end
buries its own harmony. It also derives the loudest mix `sceneWeights` can
actually reach by sweeping the camera parameters, rather than trusting a
hand-written worst case.

Band levels come from summing FFT power across each band. An earlier version
probed each band at a few frequencies with a Goertzel, which is wrong in a way
worth recording: one bin is about 3 Hz wide, so a band spanning several kHz
reported a thousandth of the energy it held and every high band looked empty.

```bash
node scripts/audio-live.mjs
```

Checks the score inside the running app — that the context starts from a
gesture, that no camera position leaves every stem silent, and what the graph
costs the frame rate. It measures fps before and after enabling audio and
asserts the view was identical for both; without that guard the numbers are
meaningless, because terrain LOD is still settling for several seconds after a
view change and a synthetic click on the canvas flies the camera somewhere
cheaper to draw.

### The ground view

```bash
node scripts/ground-shots.mjs                    # every target
node scripts/ground-shots.mjs jupiter moonDeep   # named targets only
```

Points the sky view at a body, magnifies it until the terrain renderer has taken
over, and reports how the disc is exposed: the mean level of the lit surface, the
peak, the sky it sits against, and how much of it has clipped to white. That last
figure is the one worth watching — an overexposed planet still looks like a planet
in a thumbnail while having lost every marking on it, which is exactly how the
belts of Jupiter went missing.

Each target picks its own moment rather than sharing one timestamp, searching
forward for a night when the body is up, in a dark sky, and at a phase that shows
relief. A full Moon is the wrong target for a surface shot: at zero phase angle
every shadow hides behind the thing that cast it and the ground photographs flat.
Three quarters lit puts the Sun forty degrees off vertical over the middle of the
disc.

### Watching a reference video

```bash
node scripts/video-frames.mjs <youtube-url-or-file> [frames] [outputDir]
```

Writes evenly spaced frames from a video to `reference/`, which is how footage
gets used as direction for how a surface should look. Frames come out of Chrome
rather than ffmpeg — not a preference, but there is no package manager here to
install ffmpeg with, and it turns out not to need the video downloaded at all.
yt-dlp is refused by YouTube on this machine: the current version needs a newer
Python than is available, and the version that does run gets a 403 on every
fragment. Chrome is a real browser with real cookies and simply plays the thing.

## Known limitations

- Only the Moon has measured elevation; every other body's relief is procedural,
  so its topography is plausible rather than correct.
- Moons follow circular orbits about their primaries rather than full theories.
- Close-range views cost the most: the crater field is evaluated per fragment,
  and a few kilometres above the surface is the slowest case by a wide margin.
- The camera still keeps a target even in free flight: thrust goes wherever you
  are looking and nothing pulls you back, but distance and bearing are held
  relative to the selected body, so there is no such thing as being nowhere.
- Spacecraft attitude is illustrative: nose along the track, panels towards the
  Sun. Real pointing histories are published for very few missions and are not
  in Horizons.
- Galaxies and nebulae are still billboards from the sky renderer rather than
  volumetric models.
- No ring shadows on the disc, and no eclipses between bodies.
- Zoom from the ground stops at seven arcseconds. Below that, magnifying by
  narrowing the frustum runs out of single precision — the terrain quads become
  finer than the precision of coordinates measured from the shell the bodies are
  drawn on, every triangle collapses, and the screen goes black. It is a limit on
  the field of view itself, so rescaling cannot move it; going deeper means
  travelling to the body rather than magnifying it from here.

## Credits

Body imagery from [Solar System Scope](https://www.solarsystemscope.com/textures/)
(CC-BY 4.0), derived from NASA elevation and imagery. Lunar elevation from the
NASA Scientific Visualization Studio CGI Moon Kit, from Lunar Orbiter Laser
Altimeter data. Star data from the HYG database compiled by David Nash from
Hipparcos, Yale Bright Star and Gliese catalogues. Deep sky, constellation and
asterism data from Olaf Frohn's d3-celestial. Milky Way panorama by Serge
Brunier (ESO). Planetary elements from JPL; lunar theory from ELP2000 as
presented in Meeus, *Astronomical Algorithms*. Spacecraft trajectories from the
[JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) system, Solar System Dynamics
group, Jet Propulsion Laboratory. Landing site coordinates from LROC and HiRISE
imagery as published by the Lunar and Planetary Institute and the USGS.
