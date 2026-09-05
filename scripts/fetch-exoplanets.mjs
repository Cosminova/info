/**
 * Builds public/data/exoplanets.json from the NASA Exoplanet Archive.
 *
 * The archive's `pscomppars` table is the right source here: it carries one row
 * per planet with a best-available value for each parameter, drawn from across
 * the literature. The per-publication `ps` table would give several rows per
 * planet and leave the choice of which to believe to us.
 *
 * Only systems with a measured distance survive, because without one a system
 * cannot be placed in a scene where everything sits at its true separation.
 *
 * Run: npm run fetch:exo
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'exoplanets.json');

const COLUMNS = [
  'pl_name',
  'hostname',
  'sy_dist', // parsecs
  'ra',
  'dec',
  'pl_orbsmax', // AU
  'pl_orbper', // days
  'pl_orbeccen',
  'pl_rade', // Earth radii
  'pl_bmasse', // Earth masses
  'pl_eqt', // K
  'pl_dens', // g/cm3
  'discoverymethod',
  'disc_year',
  'st_teff',
  'st_rad',
  'st_mass',
  'st_spectype',
  'sy_snum',
  'sy_pnum',
];

const query = `select ${COLUMNS.join(',')} from pscomppars where sy_dist is not null order by sy_dist asc`;
const url =
  'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?' +
  new URLSearchParams({ query, format: 'json' });

console.log('querying the NASA Exoplanet Archive');
const response = await fetch(url, { headers: { 'user-agent': 'cosminova asset fetch' } });
if (!response.ok) {
  console.error(`archive returned HTTP ${response.status}`);
  console.error((await response.text()).slice(0, 400));
  process.exit(1);
}
const rows = await response.json();
console.log(`  ${rows.length} planets with a distance`);

/**
 * Groups planets under their host star. Multi-star systems are kept as one
 * entry keyed on the host name the archive gives, which is the star the planet
 * orbits rather than the system as a whole.
 */
const systems = new Map();
for (const row of rows) {
  let system = systems.get(row.hostname);
  if (!system) {
    system = {
      host: row.hostname,
      distPc: row.sy_dist,
      ra: row.ra,
      dec: row.dec,
      teff: row.st_teff,
      radiusSol: row.st_rad,
      massSol: row.st_mass,
      spectralType: row.st_spectype ?? null,
      starCount: row.sy_snum ?? 1,
      planets: [],
    };
    systems.set(row.hostname, system);
  }
  system.planets.push({
    name: row.pl_name,
    aAu: row.pl_orbsmax,
    periodDays: row.pl_orbper,
    eccentricity: row.pl_orbeccen ?? 0,
    radiusEarth: row.pl_rade,
    massEarth: row.pl_bmasse,
    densityGcc: row.pl_dens,
    equilibriumK: row.pl_eqt,
    method: row.discoverymethod,
    year: row.disc_year,
  });
}

// Sort planets inward to outward, which is how they will be laid out and drawn.
for (const system of systems.values()) {
  system.planets.sort((a, b) => (a.aAu ?? 9e9) - (b.aAu ?? 9e9));
}

const ordered = [...systems.values()].sort((a, b) => a.distPc - b.distPc);
const payload = {
  source: 'NASA Exoplanet Archive, pscomppars',
  retrieved: new Date().toISOString().slice(0, 10),
  systems: ordered,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
const size = fs.statSync(OUT).size;
console.log(
  `  ${ordered.length} systems, nearest ${ordered[0].host} at ${ordered[0].distPc.toFixed(2)} pc`,
);
console.log(`wrote ${path.relative(ROOT, OUT)} ${(size / 1024).toFixed(0)} KB`);

const withGeometry = ordered.filter((s) => s.planets.some((p) => p.aAu && p.radiusEarth)).length;
console.log(`  ${withGeometry} systems have both an orbit size and a planet radius`);
