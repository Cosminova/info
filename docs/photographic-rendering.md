# Photographic planetary lighting and stellar glare

The shared planet shader now uses the Lunar-Lambert radiance blend without an
extra viewing-cosine multiplier. That multiplier was darkening the limbs of
regolith-covered worlds. Eclipse transmission is applied after reflectance.
Each body's existing photometry weight, measured maps, atmosphere and palette
remain in use. The Moon's albedo/exposure calibration is raised modestly.

The model is documented by USGS ISIS:
https://isis.astrogeology.usgs.gov/8.1.0/Application/presentation/PrinterFriendly/photemplate/photemplate.html

A bright, large planet suppresses the faint background stars as a camera exposed
for the planet would. Small/dark bodies and night surfaces retain the starfield.
The existing ACES tone mapping and bloom remain in place; no new fullscreen pass
or texture downloads were added.

The shared stellar flare adds a white saturated core, fine rays, a horizontal
streak and broad wavelength-separated lens halo. These are an artistic camera
response inspired by the supplied references, not a measured lens simulation.
The lens layer sits ahead of the stellar photosphere so the star cannot occlude
its own optical glare. Stellar surface detail returns when viewed close up.

A spherical-disc overlap calculation fades flare brightness during eclipses by
the selected planet/moon, including partial and annular cases. Other foreground
geometry continues to use depth testing; off-target occluders are not included
in the analytic lens-transmission calculation.

Tests:

- `node scripts/check-lens-transmission.mjs`: unobscured, full, partial and annular
  eclipse cases; continuous transitions and foreground/background order.
- `node scripts/check-camera-look.mjs`: Moon, Mars, Jupiter, Earth and Sun captures,
  actual rendered FPS, and browser/WebGL errors.
- `node scripts/check-camera-occlusion.mjs`: visible solar flare, complete lunar
  occultation, and an Earth-facing lunar view using the real maps.
- `npm run build` and `git diff --check`.

At 1280×800 High on the Apple M4 test machine, sampled orbital views measured
approximately 59.7–60.0 FPS before and 59.8–59.9 FPS after the shared lighting/glare
changes. The final halo softness and photosphere-overlay adjustments passed the
separate capture/occlusion check. These short, capped measurements do not establish
performance in surface-walking scenes or at Retina resolution.

The rendering is closer to the requested photographic presentation, not identical
to SpaceEngine. Lunar terrain also differs with viewpoint: near-side maria and
far-side highlands must retain their actual mapped geography.
