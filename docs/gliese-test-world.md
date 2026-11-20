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
