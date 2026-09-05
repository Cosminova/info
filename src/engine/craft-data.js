/**
 * Spacecraft and historic landing sites.
 *
 * Orbital elements for everything still flying were taken from JPL Horizons for
 * the epoch below, as osculating elements: a spacecraft's orbit is a snapshot
 * rather than a fixed property, since thrusters, gravity assists and drag all
 * move it. Where a craft is planet-centred the elements are referenced to that
 * planet's body equator, which is the plane the renderer puts satellite orbits
 * in; heliocentric craft are referenced to the J2000 ecliptic, matching the
 * orbitOverride fields in bodies-data.js.
 *
 * orbitKm is always measured from the parent's centre, not as an altitude. The
 * radii used for the conversions are the ones in bodies-data.js: Earth 6371,
 * Moon 1737.4, Mars 3389.5, Jupiter 69911, Saturn 58232.
 *
 * Landing site longitudes are east-positive in the range -180 to 180. That is
 * what the renderer wants: dirToUv in planet.js computes lon = atan2(z, -x) and
 * maps it to u = 0.5 + lon/2pi, so u increases with lon and the prime meridian
 * sits at the centre of the equirectangular map, which is the ordinary east
 * convention the source maps are drawn in. Sources that quote west longitude or
 * a 0-360 east range have been converted.
 */

const ELEMENT_EPOCH = '2026-08-27';

export { ELEMENT_EPOCH };

export const CRAFT = [
  {
    key: 'iss',
    name: 'International Space Station',
    parent: 'earth',
    kind: 'station',
    // 6790 km from Earth's centre is an altitude of about 420 km. The station
    // loses a few hundred metres a week to drag and is reboosted back up, so
    // this figure wanders by tens of kilometres over a year.
    orbitKm: 6790,
    orbitDays: 0.06445,
    orbitInclDeg: 51.6,
    orbitEcc: 0.001,
    launched: '1998-11-20',
    active: true,
    note: 'The inclination is 51.6 degrees because that is the latitude of Baikonur, the launch site Soyuz had to be able to reach it from.',
  },
  {
    key: 'hubble',
    name: 'Hubble Space Telescope',
    parent: 'earth',
    kind: 'telescope',
    // About 484 km altitude. Hubble has been decaying since the last servicing
    // mission in 2009 raised it, and nothing has reboosted it since.
    orbitKm: 6855,
    orbitDays: 0.065373,
    orbitInclDeg: 28.47,
    orbitEcc: 0.0013,
    launched: '1990-04-24',
    active: true,
    note: 'Its main mirror was ground to the wrong shape by two microns, and for three years the telescope was a punchline before a corrective optic fixed it.',
  },
  {
    key: 'jwst',
    name: 'James Webb Space Telescope',
    parent: 'sun',
    kind: 'telescope',
    // Webb orbits the Sun-Earth L2 point, not the Earth, and L2 itself is not a
    // body: it is a spot 1.5 million km beyond Earth that keeps station with it.
    // Webb loops around that spot every six months on a halo orbit, which is a
    // three-body path with no Keplerian equivalent. What is modelled here is the
    // one thing that is genuinely Keplerian about it: the L2 point's own path
    // round the Sun, an Earth-matching orbit 1.5 million km further out. The
    // telescope will therefore be drawn on the Sun-Earth line rather than
    // circling it, and its distance from Earth will be right to a few per cent.
    // Horizons quotes osculating elements of a = 1.05 AU and e = 0.034 for this
    // date, but those are an artefact of the halo motion rather than a real
    // ellipse, so they are not used.
    orbitKm: 151100000,
    orbitDays: 365.25,
    orbitInclDeg: 0,
    orbitEcc: 0.0167,
    launched: '2021-12-25',
    active: true,
    note: 'Its sunshield holds the mirrors near 40 kelvin, cold enough that the telescope glows less in the infrared than the light it is trying to see.',
  },
  {
    key: 'lro',
    name: 'Lunar Reconnaissance Orbiter',
    parent: 'moon',
    kind: 'orbiter',
    // A quasi-frozen orbit, roughly 30 x 165 km altitude, which LRO was moved
    // into in 2011 to stop spending fuel on station-keeping. Since 2016 even the
    // frozen-orbit maintenance has been dropped and the apses drift freely.
    orbitKm: 1827.7,
    orbitDays: 0.081155,
    // Polar at insertion; the inclination has fallen about 0.4 degrees a year
    // ever since, and is predicted to bottom out near 83.5 degrees in 2028.
    orbitInclDeg: 83.1,
    orbitEcc: 0.0147,
    launched: '2009-06-18',
    active: true,
    note: 'Its cameras are sharp enough to pick out the Apollo landers and the rover tracks around them, which is how the flag shadows were found.',
  },
  {
    key: 'chandrayaan3',
    name: 'Chandrayaan-3 Propulsion Module',
    parent: 'earth',
    kind: 'orbiter',
    // Uncertain, and the least trustworthy entry here. The propulsion module was
    // flown back from lunar orbit to a high Earth orbit in late 2023, then two
    // unplanned lunar flybys in November 2025 stretched that orbit from roughly
    // 100,000 x 300,000 km to 409,000 x 727,000 km and tilted it by an unstated
    // amount. These elements come from those two apsis figures; the inclination
    // is the pre-flyby value of 27 degrees and is probably wrong now. The orbit
    // reaches the Moon's distance, so it is strongly perturbed and not really
    // Keplerian at all. Not in Horizons, so nothing better was available.
    orbitKm: 568000,
    orbitDays: 49,
    orbitInclDeg: 27,
    orbitEcc: 0.28,
    launched: '2023-07-14',
    active: true,
    note: 'It was never meant to come home: with 100 kg of propellant left over, ISRO flew the spent carrier stage back from the Moon as a rehearsal for a sample return.',
  },
  {
    key: 'juno',
    name: 'Juno',
    parent: 'jupiter',
    kind: 'orbiter',
    // Perijove 79,000 km from Jupiter's centre, barely 9,000 km above the cloud
    // tops, and apojove 5.8 million km. Successive Ganymede, Europa and Io
    // flybys cut the period from 53 days to 33.
    orbitKm: 2945150,
    orbitDays: 32.66,
    orbitInclDeg: 98.8,
    orbitEcc: 0.9731,
    launched: '2011-08-05',
    active: true,
    note: 'It threads the gap between the cloud tops and the radiation belts twice a month, taking a dose in a few hours that would kill a person many times over.',
  },
  {
    key: 'europa-clipper',
    name: 'Europa Clipper',
    parent: 'sun',
    kind: 'orbiter',
    // Still in cruise at this epoch, so it is heliocentric rather than at
    // Jupiter: it flies past Earth in December 2026 for the assist that throws
    // it outward, and does not arrive until April 2030. These are its actual
    // current elements, which is why the orbit shown crosses the asteroid belt
    // rather than circling Jupiter.
    orbitKm: 239216800,
    orbitDays: 738.6,
    orbitInclDeg: 2.05,
    orbitEcc: 0.4754,
    launched: '2024-10-14',
    active: true,
    note: 'Rather than orbit Europa, it will orbit Jupiter and dip past the moon 49 times, so it spends most of each pass outside the worst of the radiation.',
  },
  {
    key: 'parker',
    name: 'Parker Solar Probe',
    parent: 'sun',
    kind: 'probe',
    // Perihelion 6.9 million km from the Sun's centre, about 9.9 solar radii,
    // reached by shedding orbital energy at seven Venus flybys.
    orbitKm: 58108400,
    orbitDays: 88.42,
    orbitInclDeg: 3.39,
    orbitEcc: 0.882,
    launched: '2018-08-12',
    active: true,
    note: 'At perihelion it moves at 191 km/s, fast enough to cross the United States in twenty seconds, and it has flown through the solar corona itself.',
  },
  {
    key: 'solar-orbiter',
    name: 'Solar Orbiter',
    parent: 'sun',
    kind: 'probe',
    // Perihelion 0.29 AU, aphelion 0.90 AU. Repeated Venus flybys are still
    // tilting the orbit out of the ecliptic; ESA quotes the inclination against
    // the solar equator, currently about 17 degrees, but the figure here is the
    // ecliptic inclination to match everything else in this file.
    orbitKm: 89317900,
    orbitDays: 168.5,
    orbitInclDeg: 12.62,
    orbitEcc: 0.5073,
    launched: '2020-02-10',
    active: true,
    note: 'It took the first pictures ever made of the Sun\u2019s poles, which no telescope on Earth can see because we orbit almost exactly over its equator.',
  },
  {
    key: 'bepicolombo',
    name: 'BepiColombo',
    parent: 'sun',
    kind: 'orbiter',
    // Also still in cruise: the ion engines were shut down for good in June 2026
    // and Mercury orbit insertion is on 21 November 2026, with the science orbit
    // reached in early 2027. The elements are its current heliocentric ellipse,
    // which by now almost matches Mercury's own.
    orbitKm: 58874400,
    orbitDays: 90.18,
    orbitInclDeg: 6.98,
    orbitEcc: 0.196,
    launched: '2018-10-20',
    active: true,
    note: 'Getting to Mercury takes more braking than getting to Pluto takes acceleration, which is why this one needed nine planetary flybys over eight years.',
  },
  {
    key: 'cassini',
    name: 'Cassini',
    parent: 'saturn',
    kind: 'orbiter',
    // The Grand Finale orbits of 2017, which is the last state it had: periapsis
    // 61,000 km from Saturn's centre, inside the D ring, and apoapsis out near
    // Titan. Cassini was deliberately flown into the atmosphere on 15 September
    // 2017, so this orbit no longer exists.
    orbitKm: 668675,
    orbitDays: 6.4564,
    orbitInclDeg: 61.7,
    orbitEcc: 0.9079,
    launched: '1997-10-15',
    active: false,
    note: 'It was destroyed on purpose: with the fuel gone there was no way to guarantee it would never drift into Enceladus and contaminate the ocean it had found.',
  },
  {
    key: 'voyager1',
    name: 'Voyager 1',
    parent: 'sun',
    kind: 'flyby',
    // Hyperbolic, so there is no semi-major axis or period to give. Past the
    // planets it is coasting in a straight line at constant speed, and a
    // direction, a distance and a rate describe it exactly.
    escape: {
      directionRaDec: [258.75, 12.33],
      distanceAuAtEpoch: 171.56,
      epoch: ELEMENT_EPOCH,
      speedAuPerYear: 3.569,
    },
    launched: '1977-09-05',
    active: true,
    note: 'It is the most distant human object, 23 light-hours out, and is due to pass one light-day from Earth in late 2026.',
  },
  {
    key: 'voyager2',
    name: 'Voyager 2',
    parent: 'sun',
    kind: 'flyby',
    // Also hyperbolic. The Neptune encounter bent it sharply south, which is why
    // the declination is so far below the ecliptic.
    escape: {
      directionRaDec: [301.75, -59.97],
      distanceAuAtEpoch: 143.67,
      epoch: ELEMENT_EPOCH,
      speedAuPerYear: 3.219,
    },
    launched: '1977-08-20',
    active: true,
    note: 'The only spacecraft to have visited Uranus and Neptune, and still the only close look anyone has had at either.',
  },
  {
    key: 'new-horizons',
    name: 'New Horizons',
    parent: 'sun',
    kind: 'flyby',
    // Hyperbolic; heading out through Sagittarius almost exactly in the ecliptic
    // plane, unlike either Voyager.
    escape: {
      directionRaDec: [289.0, -20.23],
      distanceAuAtEpoch: 65.36,
      epoch: ELEMENT_EPOCH,
      speedAuPerYear: 2.863,
    },
    launched: '2006-01-19',
    active: true,
    note: 'The Pluto flyby lasted a few hours and the recorded data took sixteen months to trickle home over a link slower than a dial-up modem.',
  },
  {
    key: 'pioneer10',
    name: 'Pioneer 10',
    parent: 'sun',
    kind: 'flyby',
    // Hyperbolic. Contact was lost in 2003; the position is a propagated
    // trajectory rather than a tracked one, though on a straight coast that
    // hardly matters.
    escape: {
      directionRaDec: [78.75, 26.02],
      distanceAuAtEpoch: 141.7,
      epoch: ELEMENT_EPOCH,
      speedAuPerYear: 2.503,
    },
    launched: '1972-03-03',
    active: false,
    note: 'First through the asteroid belt and first to Jupiter, carrying the engraved plaque that was humanity\u2019s first attempt at a message to anyone who finds it.',
  },
  {
    key: 'pioneer11',
    name: 'Pioneer 11',
    parent: 'sun',
    kind: 'flyby',
    // Hyperbolic; last contact 1995, so again a propagated position.
    escape: {
      directionRaDec: [283.5, -8.85],
      distanceAuAtEpoch: 119.11,
      epoch: ELEMENT_EPOCH,
      speedAuPerYear: 2.347,
    },
    launched: '1973-04-06',
    active: false,
    note: 'It used Jupiter to fling itself clear across the solar system to Saturn, the manoeuvre that proved gravity assists could reach the outer planets.',
  },
  {
    key: 'mro',
    name: 'Mars Reconnaissance Orbiter',
    parent: 'mars',
    kind: 'orbiter',
    // Near-circular sun-synchronous orbit, about 255 x 320 km altitude, with
    // periapsis frozen over the south pole.
    orbitKm: 3656,
    orbitDays: 0.077681,
    orbitInclDeg: 91.7,
    orbitEcc: 0.008,
    launched: '2005-08-12',
    active: true,
    note: 'Its HiRISE camera resolves objects a metre across from orbit, and has photographed landers descending under their parachutes.',
  },
  {
    key: 'tianwen1',
    name: 'Tianwen-1',
    parent: 'mars',
    kind: 'orbiter',
    // Elements are derived from amateur tracking of the spacecraft's own
    // telemetry rather than a published ephemeris: periapsis 275 km altitude and
    // apoapsis about 14,300 km after a 2024 burn that raised it. Not in
    // Horizons, so these are the best figures available and are approximate.
    orbitKm: 9000,
    orbitDays: 0.29995,
    orbitInclDeg: 86,
    orbitEcc: 0.593,
    launched: '2020-07-23',
    // Silent through the early 2026 solar conjunction and seen in a low-rate
    // safe mode in August 2026, so 'active' is generous.
    active: true,
    note: 'China\u2019s first Mars mission arrived as an orbiter, a lander and a rover all at once, and all three worked.',
  },
  {
    key: 'psyche',
    name: 'Psyche',
    parent: 'sun',
    kind: 'orbiter',
    // Cruise orbit after the May 2026 Mars gravity assist; arrival at the
    // asteroid Psyche is in mid-2029.
    orbitKm: 310922900,
    orbitDays: 1094.4,
    orbitInclDeg: 2.62,
    orbitEcc: 0.3318,
    launched: '2023-10-13',
    active: true,
    note: 'Its target may be the exposed iron core of a planet that never finished forming, the only chance anyone has of seeing what is under our feet.',
  },
  {
    key: 'lucy',
    name: 'Lucy',
    parent: 'sun',
    kind: 'flyby',
    // A genuine ellipse, not an escape trajectory: perihelion near Earth and
    // aphelion at 5.7 AU, out among the Jupiter Trojans. Two Earth gravity
    // assists stretched it to this six-year period.
    orbitKm: 501777100,
    orbitDays: 2243.8,
    orbitInclDeg: 4.42,
    orbitEcc: 0.7134,
    launched: '2021-10-16',
    active: true,
    note: 'It will visit eleven asteroids in one mission by cycling between the two Trojan swarms that lead and trail Jupiter, and will keep doing so for millions of years after the mission ends.',
  },
  {
    key: 'osiris-apex',
    name: 'OSIRIS-APEX',
    parent: 'sun',
    kind: 'probe',
    // Formerly OSIRIS-REx, renamed after it dropped the Bennu sample off in
    // 2023. Almost exactly in the ecliptic plane, which is why the inclination
    // is a few thousandths of a degree.
    orbitKm: 159217700,
    orbitDays: 401.05,
    orbitInclDeg: 0.004,
    orbitEcc: 0.2268,
    launched: '2016-09-08',
    active: true,
    note: 'It is going to meet Apophis in April 2029, when that asteroid passes closer to Earth than our own geostationary satellites.',
  },
  {
    key: 'perseverance',
    name: 'Perseverance',
    parent: 'mars',
    kind: 'rover',
    // On the surface, so it has coordinates rather than an orbit. This is
    // Octavia E. Butler Landing in Jezero crater; the rover has driven many
    // kilometres from it since. JPL and some map-registered sources differ by
    // about 0.05 degrees, roughly 3 km.
    latDeg: 18.4447,
    lonDeg: 77.4508,
    launched: '2020-07-30',
    active: true,
    note: 'It carries sealed sample tubes waiting on the ground for a mission that has not yet been built to come and collect them.',
  },
  {
    key: 'curiosity',
    name: 'Curiosity',
    parent: 'mars',
    kind: 'rover',
    // Bradbury Landing, on the floor of Gale crater. Curiosity has since climbed
    // several hundred metres up Mount Sharp.
    latDeg: -4.5895,
    lonDeg: 137.4417,
    launched: '2011-11-26',
    active: true,
    note: 'Its wheels wear holes in the aluminium from driving over sharp rock, so the route is now chosen partly to spare them.',
  },
];

/**
 * Surface sites. Philae on comet 67P and NEAR Shoemaker on Eros are omitted:
 * neither body exists in bodies-data.js, so there is nothing to place them on.
 */
export const LANDING_SITES = [
  // Apollo positions are the lunar module coordinates from Wagner et al. 2017,
  // measured off LRO images to better than 12 m, which is why they carry five
  // decimal places where the Soviet sites carry two.
  {
    key: 'apollo11',
    name: 'Apollo 11',
    body: 'moon',
    latDeg: 0.67416,
    lonDeg: 23.47314,
    date: '1969-07-20',
    crewed: true,
    // The Eagle's ascent engine fired a few metres from the flag and blew it
    // over; Buzz Aldrin watched it go down through the window. LRO images of the
    // other five sites show flag shadows, and there is none here.
    flag: false,
    note: 'The flag was knocked flat by the ascent engine as the crew left, and is the only one of the six no longer standing.',
  },
  {
    key: 'apollo12',
    name: 'Apollo 12',
    body: 'moon',
    latDeg: -3.0128,
    lonDeg: -23.4219,
    date: '1969-11-19',
    crewed: true,
    flag: true,
    note: 'It landed 180 m from the Surveyor 3 probe of two years earlier, and the crew walked over and cut pieces off it to bring home.',
  },
  {
    key: 'apollo14',
    name: 'Apollo 14',
    body: 'moon',
    latDeg: -3.64589,
    lonDeg: -17.47194,
    date: '1971-02-05',
    crewed: true,
    flag: true,
    note: 'Alan Shepard hit two golf balls here, in a suit too stiff to let him swing with more than one hand.',
  },
  {
    key: 'apollo15',
    name: 'Apollo 15',
    body: 'moon',
    latDeg: 26.13239,
    lonDeg: 3.6333,
    date: '1971-07-30',
    crewed: true,
    flag: true,
    note: 'The first mission with a rover, which let the crew reach the edge of Hadley Rille, a lava channel a kilometre wide.',
  },
  {
    key: 'apollo16',
    name: 'Apollo 16',
    body: 'moon',
    latDeg: -8.9734,
    lonDeg: 15.5011,
    date: '1972-04-21',
    crewed: true,
    flag: true,
    note: 'It was sent to the highlands expecting volcanic rock and found the whole site was made of impact debris instead.',
  },
  {
    key: 'apollo17',
    name: 'Apollo 17',
    body: 'moon',
    latDeg: 20.1911,
    lonDeg: 30.7723,
    date: '1972-12-11',
    crewed: true,
    flag: true,
    note: 'The last crewed landing anywhere, and the only one with a trained geologist aboard, who found orange volcanic glass on the second walk.',
  },
  {
    key: 'luna2',
    name: 'Luna 2',
    body: 'moon',
    // Very approximate. The impact crater has never been found in orbital
    // imagery, and published estimates spread over 29-31 N and 1 W to 1 E; this
    // is the NSSDCA figure.
    latDeg: 29.1,
    lonDeg: 0.0,
    date: '1959-09-13',
    crewed: false,
    flag: false,
    note: 'The first object to reach another world, carrying pennants designed to shatter and scatter Soviet emblems across the surface on impact.',
  },
  {
    key: 'luna9',
    name: 'Luna 9',
    body: 'moon',
    // The historical NSSDCA position. Work published in 2026 puts the lander
    // about 5 km away at 7.03 N, 64.33 W; the difference is below anything this
    // renderer will show.
    latDeg: 7.08,
    lonDeg: -64.37,
    date: '1966-02-03',
    crewed: false,
    flag: false,
    note: 'First soft landing on another world: an airbag-wrapped ball that bounced clear, opened four petals and sent back the first pictures from the surface.',
  },
  {
    key: 'luna16',
    name: 'Luna 16',
    body: 'moon',
    latDeg: -0.5137,
    lonDeg: 56.3638,
    date: '1970-09-20',
    crewed: false,
    flag: false,
    note: 'The first robotic sample return from anywhere: it drilled, sealed 101 grams of soil in a capsule and launched it straight back to Earth.',
  },
  {
    key: 'luna17',
    name: 'Luna 17',
    body: 'moon',
    latDeg: 38.23764,
    lonDeg: -35.00163,
    date: '1970-11-17',
    crewed: false,
    flag: false,
    note: 'It delivered Lunokhod 1, the first rover on another world, driven from Earth by a crew of five with a three-second delay on every command.',
  },
  {
    key: 'change3',
    name: "Chang'e 3",
    body: 'moon',
    latDeg: 44.1214,
    lonDeg: -19.5117,
    date: '2013-12-14',
    crewed: false,
    flag: false,
    note: 'The first soft landing in 37 years, and its lander is still working: the ultraviolet telescope on top has outlasted everything else about the mission.',
  },
  {
    key: 'change4',
    name: "Chang'e 4",
    body: 'moon',
    // Far side, in Von Karman crater, so it can only talk to Earth through the
    // Queqiao relay satellite parked beyond the Moon.
    latDeg: -45.4446,
    lonDeg: 177.5991,
    date: '2019-01-03',
    crewed: false,
    flag: false,
    note: 'The first landing on the far side, which needed a dedicated relay satellite because the Moon itself blocks any direct radio path home.',
  },
  {
    key: 'change5',
    name: "Chang'e 5",
    body: 'moon',
    latDeg: 43.0574,
    lonDeg: -51.9156,
    date: '2020-12-01',
    crewed: false,
    // A cloth flag was unfurled on the lander, but it is a fixture on the deck
    // rather than something planted in the ground.
    flag: false,
    note: 'Its samples turned out to be two billion years old, far younger than anything Apollo brought back, and rewrote how long the Moon stayed volcanically alive.',
  },
  {
    key: 'change6',
    name: "Chang'e 6",
    body: 'moon',
    // Also far side, in the Apollo basin. The LROC position is used here so it
    // sits in the same frame as the Apollo and Luna sites; the Chinese
    // terrain-model position differs by about 440 m.
    latDeg: -41.6385,
    lonDeg: -153.9852,
    date: '2024-06-01',
    crewed: false,
    flag: false,
    note: 'The first sample ever returned from the far side, from inside the vast South Pole-Aitken basin.',
  },
  {
    key: 'chandrayaan3-site',
    name: 'Chandrayaan-3 (Vikram)',
    body: 'moon',
    latDeg: -69.373,
    lonDeg: 32.319,
    date: '2023-08-23',
    crewed: false,
    flag: false,
    note: 'The furthest south anything has landed, close enough to the pole that the Sun never rises far and the shadows run for hundreds of metres.',
  },
  {
    key: 'viking1',
    name: 'Viking 1',
    body: 'mars',
    // Map-registered position from the PDS landing-site list. Sources differ by
    // up to 0.3 degrees in latitude depending on whether they use the tracking
    // solution or the image registration.
    latDeg: 22.269,
    lonDeg: -47.951,
    date: '1976-07-20',
    crewed: false,
    flag: false,
    note: 'The first spacecraft to land on Mars and work, and it kept working for six years, four of them past the end of its design life.',
  },
  {
    key: 'viking2',
    name: 'Viking 2',
    body: 'mars',
    // Same caveat: the PDS list gives 47.668 N, NASA's mission page 47.968 N.
    latDeg: 47.668,
    lonDeg: 134.28,
    date: '1976-09-03',
    crewed: false,
    flag: false,
    note: 'It came down on ground so flat and featureless that the orbiters could never pin down exactly where it was.',
  },
  {
    key: 'pathfinder',
    name: 'Mars Pathfinder',
    body: 'mars',
    latDeg: 19.095,
    lonDeg: -33.253,
    date: '1997-07-04',
    crewed: false,
    flag: false,
    note: 'It landed by bouncing across the ground inside airbags, a technique invented because it was cheap, and carried the first rover to drive on Mars.',
  },
  {
    key: 'spirit',
    name: 'Spirit',
    body: 'mars',
    latDeg: -14.5692,
    lonDeg: 175.4729,
    date: '2004-01-04',
    crewed: false,
    flag: false,
    note: 'Designed for 90 days, it drove for six years before a wheel broke through a crust of soft sand and left it stuck for good.',
  },
  {
    key: 'opportunity',
    name: 'Opportunity',
    body: 'mars',
    latDeg: -1.9462,
    lonDeg: -5.5266,
    date: '2004-01-25',
    crewed: false,
    flag: false,
    note: 'It landed by chance inside a small crater whose walls exposed exactly the water-formed rock it had been sent to look for, and drove 45 km over fifteen years.',
  },
  {
    key: 'curiosity-site',
    name: 'Curiosity (Bradbury Landing)',
    body: 'mars',
    latDeg: -4.5895,
    lonDeg: 137.4417,
    date: '2012-08-06',
    crewed: false,
    flag: false,
    note: 'Too heavy for airbags, it was lowered on cables from a rocket-powered stage that then flew off and crashed a safe distance away.',
  },
  {
    key: 'insight',
    name: 'InSight',
    body: 'mars',
    latDeg: 4.5024,
    lonDeg: 135.6234,
    date: '2018-11-26',
    crewed: false,
    flag: false,
    note: 'Its seismometer heard marsquakes and meteorite strikes, and the travel times of those waves gave the first measurement of the Martian core.',
  },
  {
    key: 'perseverance-site',
    name: 'Perseverance (Octavia E. Butler Landing)',
    body: 'mars',
    latDeg: 18.4447,
    lonDeg: 77.4508,
    date: '2021-02-18',
    crewed: false,
    flag: false,
    note: 'It landed in a crater that was once a lake with a river delta running into it, which is about the best place on the planet to look for fossil life.',
  },
  {
    key: 'zhurong',
    name: 'Zhurong',
    body: 'mars',
    latDeg: 25.066,
    lonDeg: 109.925,
    date: '2021-05-14',
    crewed: false,
    flag: false,
    note: 'China landed a rover on its first attempt at Mars, something no other country has managed.',
  },
  {
    key: 'venera7',
    name: 'Venera 7',
    body: 'venus',
    // Only known to about a degree: the landing was uncontrolled after the
    // parachute failed, and there is no imagery of the surface to register
    // against.
    latDeg: -5,
    lonDeg: -9,
    date: '1970-12-15',
    crewed: false,
    flag: false,
    note: 'Its parachute tore and it hit the ground at 17 m/s, then transmitted for 23 minutes on its side: the first data ever sent from the surface of another planet.',
  },
  {
    key: 'venera13',
    name: 'Venera 13',
    body: 'venus',
    // Also approximate, quoted only to the nearest half degree.
    latDeg: -7.5,
    lonDeg: -57,
    date: '1982-03-01',
    crewed: false,
    flag: false,
    note: 'It lasted 127 minutes at 457 degrees and 84 atmospheres, four times its design life, and recorded the first sounds from another planet.',
  },
  {
    key: 'huygens',
    name: 'Huygens',
    body: 'titan',
    // Uncertain. The usual published position is 10.3 S, 192.3 W, converted here
    // to east longitude; some sources give 163.2 E instead, which is 4 degrees
    // away, and the discrepancy has not been resolved here.
    latDeg: -10.3,
    lonDeg: 167.7,
    date: '2005-01-14',
    crewed: false,
    flag: false,
    note: 'It landed on damp sand in what turned out to be a dry river bed, and the descent microphone recorded the wind of another world.',
  },
];

export const CRAFT_BY_KEY = new Map(CRAFT.map((c) => [c.key, c]));
export const LANDING_SITE_BY_KEY = new Map(LANDING_SITES.map((s) => [s.key, s]));
