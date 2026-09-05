/**
 * Universal search.
 *
 * The catalogue is tens of thousands of entries, so matching happens over a
 * prepared index of lowercased names built once, and scoring is deliberately
 * cheap: an exact hit, then a prefix hit, then a word-boundary hit, then a bare
 * substring. That ordering is what makes typing "and" put Andromeda above the
 * hundreds of catalogue numbers that merely contain the letters.
 *
 * Results carry what you need to decide whether it is the object you meant —
 * class, distance, parent system and coordinates — because "NGC 1300" is not a
 * name anyone recognises on sight.
 */

import { el, css, show, clear, append } from './dom.js';
import { formatDistance } from '../engine/units.js';
import { BODY_BY_KEY } from '../engine/bodies-data.js';

/**
 * The catalogue calls everything with a surface a 'body'. What a reader wants to
 * know is whether it orbits a planet, which is exactly whether it has a primary
 * other than the Sun.
 */
function classOf(dest) {
  // A spacecraft's own class is the useful badge: "rover" and "orbiter" tell you
  // what you found, where "craft" tells you what you already typed.
  if (dest.kind === 'craft') return dest.craft?.kind ?? 'craft';
  if (dest.kind !== 'body') return dest.kind;
  const spec = BODY_BY_KEY.get(dest.key);
  if (spec?.parent && spec.parent !== 'sun') return 'moon';
  return 'planet';
}

const MAX_RESULTS = 60;

/** Strip what separates the words of a designation, so only the letters remain. */
const squash = (s) => s.replace(/[\s-]/g, '');

/** Score a query against a prepared entry. Higher is better; 0 means no match. */
function score(entry, query, squashedQuery) {
  const name = entry.lower;
  if (name === query) return 1000;
  const at = name.indexOf(query);
  if (at === 0) return 800 - name.length;
  if (at > 0) {
    // A match at a word boundary is a real match ("large magellanic" for
    // "magellanic"); one in the middle of a token usually is not.
    const boundary = name[at - 1] === ' ' || name[at - 1] === '-';
    return (boundary ? 500 : 200) - name.length - at;
  }
  // Also try the designation with its separators removed, so "ngc1300" finds
  // "NGC 1300" — which is how catalogue numbers are usually typed.
  //
  // Both sides have to be stripped, not just the catalogue's. Stripping only
  // the entry meant a query still carrying a hyphen could never match, and that
  // is not a rare shape: the catalogue writes "TRAPPIST-1 e" and "Kepler-186 f"
  // while everybody writes TRAPPIST-1e and Kepler-186f, so searching for the
  // best-known planets by the name they are known by returned nothing at all.
  const squashed = entry.squashed;
  if (!squashed) return 0;
  if (squashed.startsWith(squashedQuery)) return 700 - squashed.length;
  if (squashed.includes(squashedQuery)) return 150 - squashed.length;
  return 0;
}

export function createSearch({ destinations, resolve, craftStatus, onPick, onAction, prefs }) {
  // Prepared once. `squashed` is only stored where it differs, to keep the index
  // from doubling in size for the tens of thousands of entries without spaces.
  const index = destinations.map((dest) => {
    const lower = dest.name.toLowerCase();
    const squashed = squash(lower);
    return { dest, lower, squashed: squashed === lower ? null : squashed };
  });

  const input = el('input', {
    class: 'input search-input',
    type: 'search',
    placeholder: 'Search objects\u2026',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search objects',
  });
  const results = el('ul', { class: 'search-results takes-pointer', hidden: true, role: 'listbox' });
  const root = el('div', { class: 'search takes-pointer' }, [input, results]);

  let rows = [];
  let cursor = 0;

  function distanceLabel(dest) {
    if (dest.distPc) return `${dest.distPc.toFixed(1)} pc`;
    if (dest.distMpc) return `${dest.distMpc.toFixed(1)} Mpc`;
    if (dest.system?.distPc) return `${dest.system.distPc.toFixed(1)} pc`;
    // For solar system bodies the useful number is how far away it is right now,
    // which only the live scene knows.
    const resolved = resolve(dest.key);
    if (resolved?.cameraDistanceKm != null) return formatDistance(resolved.cameraDistanceKm);
    // A spacecraft has no distance on a date it does not exist on, and saying so
    // is more use than a blank column: it is why the row cannot be flown to.
    if (dest.kind === 'craft') return craftStatus?.(dest.key)?.phase ?? '';
    return '';
  }

  function metaLabel(dest) {
    const parts = [];
    if (dest.kind === 'craft') {
      const c = dest.craft;
      if (c.agency) parts.push(c.agency);
      if (c.mission) parts.push(c.mission);
      const status = craftStatus?.(dest.key);
      if (status?.locationName && status.present) parts.push(status.locationName);
      else if (dest.group && dest.group !== 'Spacecraft') parts.push(dest.group);
      if (c.launched) parts.push(`launched ${String(c.launched).slice(0, 4)}`);
      return parts.join('  \u00b7  ');
    }
    if (dest.system?.host) parts.push(dest.system.host);
    else if (dest.group) parts.push(dest.group);
    const resolved = resolve(dest.key);
    if (resolved?.ra != null && resolved?.dec != null) {
      const ra = resolved.ra;
      const h = Math.floor(ra);
      const m = Math.round((ra - h) * 60);
      const sign = resolved.dec < 0 ? '\u2212' : '+';
      parts.push(`${h}h ${String(m).padStart(2, '0')}m ${sign}${Math.abs(resolved.dec).toFixed(1)}\u00b0`);
    }
    return parts.join('  \u00b7  ');
  }

  function render(query) {
    clear(results);
    rows = [];
    if (!query) {
      show(results, false);
      return;
    }

    const scored = [];
    const squashedQuery = squash(query);
    for (const entry of index) {
      const value = score(entry, query, squashedQuery);
      if (value > 0) scored.push({ entry, value });
    }
    scored.sort((a, b) => b.value - a.value || a.entry.dest.name.length - b.entry.dest.name.length);

    if (!scored.length) {
      append(results, el('li', { class: 'search-empty', text: `Nothing matches \u201c${query}\u201d.` }));
      show(results, true);
      return;
    }

    for (const { entry } of scored.slice(0, MAX_RESULTS)) {
      const dest = entry.dest;
      const kind = classOf(dest);
      const row = el('li', {
        class: 'search-row',
        role: 'option',
        dataset: { key: dest.key },
      }, [
        el('div', { class: 'r-name' }, [
          el('span', { text: dest.name }),
          el('span', { class: `badge k-${kind}`, text: kind.replace('-', ' ') }),
        ]),
        el('div', { class: 'r-meta', text: metaLabel(dest) }),
        el('div', { class: 'r-dist', text: distanceLabel(dest) }),
        el('div', { class: 'search-actions' }, [
          el('button', { type: 'button', class: 'btn',
            text: dest.kind === 'craft' ? 'Go to spacecraft' : 'Go',
            title: 'Travel to it',
            onClick: (e) => { e.stopPropagation(); commit(dest.key, 'goto'); } }),
          el('button', { type: 'button', class: 'btn', text: 'Center', title: 'Center the camera without travelling',
            onClick: (e) => { e.stopPropagation(); commit(dest.key, 'center'); } }),
          el('button', { type: 'button', class: 'btn', text: 'Target', title: 'Set as target',
            onClick: (e) => { e.stopPropagation(); commit(dest.key, 'target'); } }),
          el('button', { type: 'button', class: 'btn', text: '\u2606', title: 'Bookmark',
            onClick: (e) => { e.stopPropagation(); onAction(dest.key, 'bookmark'); } }),
        ]),
      ]);
      row.addEventListener('click', () => commit(dest.key, 'goto'));
      // Moving the mouse moves the keyboard cursor too, so the row the actions
      // are attached to is always the row under the pointer.
      row.addEventListener('pointerenter', () => setCursor(rows.indexOf(row)));
      rows.push(row);
      append(results, row);
    }
    setCursor(0);
    show(results, true);
  }

  function setCursor(next) {
    if (!rows.length) return;
    cursor = Math.max(0, Math.min(next, rows.length - 1));
    rows.forEach((row, i) => css(row, 'is-cursor', i === cursor));
    rows[cursor].scrollIntoView({ block: 'nearest' });
  }

  function commit(key, action) {
    close();
    if (action === 'goto') onPick(key);
    else onAction(key, action);
  }

  function close() {
    show(results, false);
    input.blur();
    input.value = '';
    rows = [];
  }

  let debounce = 0;
  input.addEventListener('input', () => {
    // The index scan is fast but not free at forty thousand entries, and running
    // it on every keystroke of a fast typist is wasted work.
    clearTimeout(debounce);
    debounce = setTimeout(() => render(input.value.trim().toLowerCase()), 90);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(cursor + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(cursor - 1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows[cursor]) commit(rows[cursor].dataset.key, event.shiftKey ? 'center' : 'goto');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) render(input.value.trim().toLowerCase());
  });

  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) show(results, false);
  }, true);

  return {
    root,
    input,
    focus() {
      input.focus();
      input.select();
    },
    close,
    get isOpen() {
      return !results.hidden;
    },
  };
}
