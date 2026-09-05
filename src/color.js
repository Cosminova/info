/**
 * Star colour derived from photometry rather than picked by hand: B-V colour
 * index -> effective temperature -> Planckian locus -> linear sRGB.
 */

/** Ballesteros (2012) temperature estimate from B-V colour index. */
export function colorIndexToTemperature(bv) {
  const x = Math.max(-0.4, Math.min(2.5, bv));
  return 4600 * (1 / (0.92 * x + 1.7) + 1 / (0.92 * x + 0.62));
}

/**
 * Kim et al. cubic approximation of the Planckian locus in CIE 1931 xy,
 * valid over roughly 1667 K - 25000 K.
 */
function planckianLocusXY(kelvin) {
  const T = Math.max(1667, Math.min(25000, kelvin));
  const t = 1000 / T;
  let x;
  if (T <= 4000) {
    x = -0.2661239 * t * t * t - 0.2343589 * t * t + 0.8776956 * t + 0.179910;
  } else {
    x = -3.0258469 * t * t * t + 2.1070379 * t * t + 0.2226347 * t + 0.240390;
  }
  let y;
  if (T <= 2222) {
    y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  } else if (T <= 4000) {
    y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

/** CIE xy at unit luminance -> linear sRGB (may contain small negatives). */
function xyToLinearSrgb(x, y) {
  const Y = 1;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/**
 * Linear-light RGB for a star, normalised so the three channels average to 1.
 * Keeping average energy constant means the magnitude term alone controls
 * brightness and hue never changes perceived exposure.
 *
 * `saturation` lets the UI pull colours towards white, which is closer to what
 * a dark-adapted eye actually reports for faint stars.
 */
export function colorIndexToLinearRgb(bv, saturation = 1) {
  const kelvin = colorIndexToTemperature(bv);
  const { x, y } = planckianLocusXY(kelvin);
  let [r, g, b] = xyToLinearSrgb(x, y);

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  const mean = (r + g + b) / 3 || 1;
  r /= mean;
  g /= mean;
  b /= mean;

  if (saturation !== 1) {
    r = 1 + (r - 1) * saturation;
    g = 1 + (g - 1) * saturation;
    b = 1 + (b - 1) * saturation;
  }
  return [r, g, b];
}

/**
 * Builds a lookup table over the B-V range so per-star colour assignment is a
 * couple of array reads instead of a full spectral evaluation.
 */
export function buildColorLookup(size = 1024, saturation = 1) {
  const BV_MIN = -0.4;
  const BV_MAX = 2.5;
  const table = new Float32Array(size * 3);
  for (let i = 0; i < size; i++) {
    const bv = BV_MIN + ((BV_MAX - BV_MIN) * i) / (size - 1);
    const rgb = colorIndexToLinearRgb(bv, saturation);
    table[i * 3] = rgb[0];
    table[i * 3 + 1] = rgb[1];
    table[i * 3 + 2] = rgb[2];
  }
  return {
    table,
    size,
    sample(bv, out, offset) {
      const t = (bv - BV_MIN) / (BV_MAX - BV_MIN);
      const i = Math.max(0, Math.min(size - 1, Math.round(t * (size - 1))));
      out[offset] = table[i * 3];
      out[offset + 1] = table[i * 3 + 1];
      out[offset + 2] = table[i * 3 + 2];
    },
  };
}

/** Rough spectral class from B-V, used for the info panel when unknown. */
export function colorIndexToSpectralHint(bv) {
  if (bv < -0.25) return 'O';
  if (bv < 0.0) return 'B';
  if (bv < 0.3) return 'A';
  if (bv < 0.58) return 'F';
  if (bv < 0.81) return 'G';
  if (bv < 1.4) return 'K';
  return 'M';
}
