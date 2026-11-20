# Gliese 12 b biome lab

Gliese 12 b is an **artistic renderer test world**. The oceans, vegetation, atmosphere,
volcano and auroras are invented; they are not observations of the exoplanet.

Select Gliese 12 b and open **Gliese 12b · Biome lab** at the lower left. Choose a
region, press **Explore biome**, and use **Day** / **Night** to change lighting.
The polar site is the best place to see the aurora at night.

## Rendering and walking

- Terrain subdivision measures distance to the local land elevation, including
  the grazing-angle calculation. Native desktop pixel resolution is retained.
- A walker can only enter GPU-confirmed terrain. The support query samples an
  8×8 tile of the actual patch lattice, including its morph, and conservatively
  bounds neighbouring triangle heights. Unknown ground delays movement.
- Asynchronous height readbacks release the pixel-pack-buffer binding before
  any synchronous query. Teleports invalidate old collision results.
- Surface walking speed is bounded; sprinting no longer accelerates to km/s.
- Grass, sand and rock use photographic ground materials. Nearby rocks and
  vegetation are instanced. Water has moving normals and shoreline foam;
  volcanic terrain emits light; clouds and polar auroras animate.
- Terrain slopes and atmospheric radiance are cached. The sky lookup uses the
  same atmospheric integration with denser samples near the horizon.
- Hidden tabs stop rendering; unfocused windows render at most once per second.
  The foreground pipeline allows no more than two outstanding GPU frames.

## Validation and limitations

`npm run build`

`OUT=work/walk-safety node scripts/check-walk-safety.mjs`

The test audits sprinting, reversals, biome jumps, quality changes, mixed
synchronous/asynchronous GPU reads, and background rendering. It checks clearance
against actual rendered terrain triangles, not just the procedural point height.

On Apple M4, headless Chrome at 1280×800, the desert test measured roughly 19–20
rendered FPS on high/ultra with render scale 1. This is not a 60 FPS guarantee.
Performance is still limited in terrain-heavy views. Very small support tiles
can delay movement while GPU data arrives. Instanced vegetation is sparse;
clouds and auroras are inexpensive shell effects, not volumetric simulations.
This is a substantial test-world expansion, not photographic realism or parity
with SpaceEngine. Terrain collision checks do not make individual scattered
rocks solid obstacles.

## References

SpaceEngine describes adaptive terrain and layered surface materials:
- https://spaceengine.org/news/blog171120/
- https://spaceengine.org/news/blog171102/

This implementation uses those general techniques, not SpaceEngine code/assets.
Material sources and CC0 licensing are recorded in
`public/textures/ground/BIOME-CREDITS.md`; the rock material sources are recorded
in `scripts/build-ground-textures.py`.

## Persistent geographical scatter

The old scatter field was rebuilt from the walker's tangent plane every 22 m.
Reusing the same random offsets on a moving plane moved every rock, and replacing
all instance matrices in one callback caused abrupt appearances.

The replacement refines the existing instanced renderer:

- Fixed cube-face cells (96 m at the face centre), with 16 inset,
  seeded strata per cell. Cube edges and poles have unique, deterministic owners.
- IDs and transforms depend on planet seed, generator version, face, cell and
  object index; they do not depend on visit order, frame rate or camera LOD.
- A 256-cell LRU cache retains sampled foundations. Evicted cells reproduce the
  same positions. Persistence across application restarts comes from deterministic
  regeneration, not a growing save file.
- Cells are requested out to 170 m, while rocks fade between 60 and 95 m.
  Vegetation fades at 35–60 m. Initial arrivals fade in over 1.2 seconds; instant
  travel to an uncached location can still require that initial loading period.
- A reusable 128-cell instance pool keeps two draw calls. Only changed slots are
  uploaded. Rendering-origin rebases never change geographical positions.
- At most one 48-point scatter readback is pending, in a channel separate from
  collision queries. Each rock gets a centre and two slope samples; underwater
  placements and very steep slopes are rejected.
- Geological height detail stays fixed with camera distance, so a cached rock's
  foundation is not displaced by approaching it. Mesh LOD/morphing still works.

Validation:

```
node scripts/check-scatter.mjs
node scripts/check-scatter-browser.mjs
OUT=work/scatter-benchmark node scripts/benchmark-scatter.mjs
```

The benchmark runs the same 80 m out-and-back path in 20 seconds at 1280×800,
High, native render scale, fixed daylight. It counts rendered frames, not browser
animation callbacks. `BASELINE_DIR` can replay saved original versions of the
three changed engine modules through request interception, without modifying the
working tree. Only run one GPU benchmark at a time.

The mountain refinement retains the existing noise basis and quadtree: rounded
multiscale crests, a gently warped range, broader valley masks, and restrained
blue-gray/pale mineral bedding. A more expensive erosion experiment was rejected
following benchmark regression. This is procedural shaping, not simulated
hydraulic erosion or a replacement planetary engine.

Final paired benchmark on Apple M4 / Chrome / 1280×800 / High, native scale:

| Metric | Original modules | Persistent scatter + terrain refinement |
| --- | ---: | ---: |
| Rendered FPS | 20.23 | 19.65 |
| Median rendered-frame interval | 50.0 ms | 50.0 ms |
| 95th-percentile frame interval | 66.7 ms | 66.7 ms |
| Longest observed frame interval | 100.1 ms | 116.8 ms |
| Scatter update CPU p95 | 0.1 ms | 0.1 ms |

These short runs do not establish a speedup or stable 60 FPS. Mean FPS was about
3% lower in the final paired run; earlier comparable scatter-only runs were
21.44 versus 21.19 FPS. The main gain is persistence. The final run loaded ten
new cells and reused twelve cached cells during movement, with no new late loads
inside the visible radius after initial warmup. Largest measured per-cell CPU
instance preparation was 0.8 ms, including initial loading.
