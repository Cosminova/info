/**
 * Analytic sunlight visibility, shared by every surface that has to decide how
 * much of the Sun it can see.
 *
 * The Sun is not a point. It subtends about half a degree from Earth, and every
 * soft edge in the solar system — the terminator you see along a planet's day
 * boundary, the penumbra of an eclipse, the fuzzy edge of Saturn's shadow on its
 * rings — is that half degree projected onto something. So rather than fading
 * shadows with a hand-tuned `smoothstep`, everything here answers one question
 * exactly: what fraction of the Sun's disc is visible from this point?
 *
 * Two occlusions matter, and both have closed forms:
 *
 * - The local horizon cuts the disc with a straight line, leaving a circular
 *   segment. This is the terminator.
 * - Another body covers it with a disc, leaving a circular lens. This is an
 *   eclipse, and the same formula gives the umbra (the covering disc is larger
 *   and concentric, so nothing is left), the annular case (the covering disc is
 *   smaller and entirely inside, so a ring of Sun survives) and every partial
 *   phase in between, with no special cases in the caller.
 *
 * Getting these exactly right rather than approximately is what makes an eclipse
 * behave: a total lunar eclipse has to reach a genuine umbra, and an annular
 * solar eclipse has to leave the correct residual fraction of sunlight rather
 * than going dark.
 *
 * Angles are in radians throughout, and every result is a fraction in [0, 1].
 */
export const SUN_RADIUS_KM = 695700;

/**
 * Sunlight refracted into an umbra by the occulting body's atmosphere, as a
 * fraction of direct sunlight.
 *
 * A totally eclipsed Moon is around ten magnitudes fainter than a full one, so
 * the true figure is nearer a ten-thousandth. As with reflected light, that lands
 * below one display level at an exposure set for a sunlit surface while remaining
 * perfectly visible to the eye, and it is the whole reason anyone watches a lunar
 * eclipse. This is the viewing value: dim enough to read as deep shadow, bright
 * enough to show the colour.
 */
export const UMBRA_REFRACTED_LIGHT = 0.05;

/**
 * Illuminated fraction of a nearby body, seen from the point being shaded.
 *
 * This is the phase of the host planet as seen from its moon, which is what sets
 * how much reflected light the moon's night side receives. Both arguments are
 * unit vectors from the shaded body: one towards the Sun, one towards the host.
 *
 * The sign is the whole point, and it is the opposite of what it looks like. The
 * host is fully lit as seen from the moon when the moon lies between the host and
 * the Sun — the two directions then point opposite ways, and the dot product is
 * -1. For the Earth and the Moon that is new Moon, which is exactly when
 * earthshine is at its strongest and the "old Moon in the new Moon's arms" is
 * visible. At full Moon the Earth is new as seen from the Moon and there is no
 * earthshine at all.
 */
export function illuminatedFraction(toSun, toHost) {
  return Math.max(0, 0.5 * (1 - toSun.dot(toHost)));
}

/**
 * Reflected light a moon receives from its host, as a fraction of the direct
 * sunlight falling on the same surface.
 *
 * Geometrically this is the host's albedo, times the fraction of the moon's sky
 * the host fills, times how much of the host is lit. For the Earth and the Moon
 * it comes to about 1e-4, which agrees with the measured brightness of earthshine.
 */
export function reflectedFraction({ hostRadiusKm, separationKm, hostAlbedo, phase }) {
  const solidAngle = (hostRadiusKm / Math.max(separationKm, 1)) ** 2;
  return hostAlbedo * solidAngle * phase;
}

/**
 * Display gain applied to reflected light.
 *
 * Earthshine really is four orders of magnitude below direct sunlight, and at an
 * exposure set for the sunlit surface it lands far below one display level — yet
 * the eye sees it plainly, because the eye is not linear. This is the correction
 * for that, and it is a viewing constant rather than a physical one, which is why
 * it is a single named number here instead of being folded into the maths above.
 */
/**
 * Hard ceiling on reflected light, as a fraction of direct sunlight, so that no
 * combination of geometry can bring it within sight of sunlight. A night side has
 * to stay a night side.
 */
export const REFLECTED_MAX_FRACTION = 0.08;

/**
 * Reflected light as the shader should receive it, given the physical fraction.
 *
 * A straight multiplier does not work here, because the cases differ by two
 * orders of magnitude and the requirement pulls both ways. Earthshine is about
 * 1e-4 of sunlight, far below one display level at any exposure that suits the
 * sunlit surface, and yet plainly visible to the eye, which is not linear.
 * Jupiter-shine on Europa is about 1e-2 — genuinely sixty times stronger, since
 * Jupiter fills a large part of Europa's sky. Multiply both by enough to bring
 * the first into view and the second arrives at a third of full sunlight, at
 * which point Europa's night side stops reading as night at all.
 *
 * A square root is the smallest honest compromise. It keeps the ordering — a moon
 * beside a giant is still brighter than the Moon beside the Earth — while pulling
 * the range from sixty to one down to eight to one, which fits in a display. It
 * is a viewing curve, not physics, which is why it lives in one named place
 * rather than being folded into the geometry above.
 */
export function displayedReflectance(fraction) {
  return Math.min(Math.sqrt(Math.max(fraction, 0)) * 0.55, REFLECTED_MAX_FRACTION);
}

export const SHADOW_GLSL = /* glsl */ `
  /**
   * Fraction of the Sun's disc above a local horizon.
   *
   * sinElevation is the sine of the Sun's centre elevation above the plane —
   * which is exactly dot(surfaceNormal, sunDirection) — and sunRadius is the
   * Sun's angular radius. Working in units of the Sun's radius, the horizon is a
   * chord at signed distance -u from the centre, and what remains is a circular
   * segment.
   *
   * The small-angle approximation here is harmless: the Sun's angular radius is
   * a quarter of a degree at Earth and smaller everywhere further out, so
   * treating its disc as flat over that span is accurate to parts in ten
   * thousand.
   */
  float sunAboveHorizon(float sinElevation, float sunRadius) {
    float u = clamp(sinElevation / max(sunRadius, 1e-6), -1.0, 1.0);
    return (acos(-u) + u * sqrt(max(1.0 - u * u, 0.0))) / PI;
  }

  /**
   * Fraction of the Sun's disc covered by an opaque disc.
   *
   * separation is the angle between the two disc centres, occRadius the
   * occulter's angular radius and sunRadius the Sun's. The three regimes fall
   * out of the geometry: no contact, one disc entirely inside the other, and
   * partial overlap, where the shared area is the standard two-circle lens.
   */
  float sunCoveredByDisc(float separation, float occRadius, float sunRadius) {
    float R = max(sunRadius, 1e-7);
    float r = max(occRadius, 0.0);
    float d = max(separation, 0.0);

    if (d >= R + r) return 0.0;          // clear of each other
    if (d <= r - R) return 1.0;          // total: the Sun is behind the occulter
    if (d <= R - r) return (r * r) / (R * R);  // annular: occulter inside the disc

    // Partial. Area of the lens between two overlapping circles, over the area
    // of the Sun's disc.
    float d2 = d * d;
    float r2 = r * r;
    float R2 = R * R;
    float alpha = acos(clamp((d2 + r2 - R2) / (2.0 * d * r), -1.0, 1.0));
    float beta = acos(clamp((d2 + R2 - r2) / (2.0 * d * R), -1.0, 1.0));
    float triangle = sqrt(max((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R), 0.0));
    float lens = r2 * alpha + R2 * beta - 0.5 * triangle;
    return clamp(lens / (PI * R2), 0.0, 1.0);
  }

  /**
   * Fraction of the Sun covered by a sphere of the given radius whose centre lies
   * at toCentre from the shaded point. Returns 0 when the point is inside the
   * sphere or the sphere is on the wrong side of the sky.
   */
  float sunCoveredBySphere(vec3 toCentre, float radius, vec3 sunDir, float sunRadius) {
    float dist = length(toCentre);
    if (dist <= radius * 1.0001) return 0.0;
    float occRadius = asin(clamp(radius / dist, 0.0, 0.999999));
    float separation = acos(clamp(dot(toCentre / dist, sunDir), -1.0, 1.0));
    return sunCoveredByDisc(separation, occRadius, sunRadius);
  }

  /**
   * Transmission through a slab of scattering material, Beer-Lambert, along a
   * path at the given elevation above the slab.
   *
   * This is what a ring shadow is: not a stencil, but an optical depth that the
   * sunlight has to cross at whatever angle the Sun happens to be at. Low Sun
   * means a longer path and a darker, wider shadow, which is why Saturn's ring
   * shadow is a thin dark line near equinox and a broad band otherwise.
   */
  float slabTransmission(float opticalDepth, float sinElevation) {
    if (opticalDepth <= 0.0) return 1.0;
    float mu = max(abs(sinElevation), 0.015);
    return exp(-opticalDepth / mu);
  }
`;
