/**
 * Keyboard shortcuts: a registry rather than a pile of keydown listeners.
 *
 * Actions declare a default key and a description; bindings are looked up
 * through saved preferences at dispatch time, so rebinding is a preference
 * write and nothing has to be re-registered. Holding the registry also means
 * the help panel and the tooltips can be generated from it instead of
 * documenting the keys separately and drifting out of date.
 */

/** Normalise a KeyboardEvent into the form used for bindings, e.g. 'Shift+F'. */
export function chord(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  // A shifted letter arrives as the shifted character, so 'Shift+?' would never
  // match a binding written as 'Shift+/'. Prefer the physical key for those.
  else if (key === 'Escape') key = 'Esc';
  parts.push(key);
  return parts.join('+');
}

export function prettyChord(binding) {
  return binding
    .replace('Meta', '\u2318')
    .replace('Shift', '\u21e7')
    .replace('Alt', '\u2325')
    .replace(/\+/g, '');
}

export function createShortcuts(prefs) {
  const actions = new Map();

  /**
   * `when` lets an action decline to fire — used so Esc closes the topmost thing
   * rather than everything at once.
   */
  function register({ id, key, label, group = 'General', run, when = null, allowInInput = false }) {
    actions.set(id, { id, key, label, group, run, when, allowInInput });
  }

  function binding(id) {
    const action = actions.get(id);
    if (!action) return '';
    return prefs.get(`keys.${id}`, action.key);
  }

  function rebind(id, next) {
    prefs.set(`keys.${id}`, next);
  }

  function reset(id) {
    const action = actions.get(id);
    if (action) prefs.set(`keys.${id}`, action.key);
  }

  function list() {
    const groups = new Map();
    for (const action of actions.values()) {
      if (!groups.has(action.group)) groups.set(action.group, []);
      groups.get(action.group).push({ ...action, binding: binding(action.id) });
    }
    return groups;
  }

  /**
   * Fire an action by id, as though its key had been pressed.
   *
   * The macOS shell drives its menu through this. A menu item and a key press
   * ought not to be two separate routes to the same behaviour, because two
   * routes drift; this way the menu is the registry with a different front
   * end, and an action added here appears in both.
   */
  function run(id) {
    const action = actions.get(id);
    if (!action) return false;
    if (action.when && !action.when()) return false;
    action.run();
    return true;
  }

  function handle(event) {
    // Typing in a field must not trigger navigation. Esc and the function keys
    // are the exceptions: they are how you get back out of a field.
    const target = event.target;
    const typing =
      target
      && (target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable);

    const pressed = chord(event);
    for (const action of actions.values()) {
      if (binding(action.id) !== pressed) continue;
      if (typing && !action.allowInInput) continue;
      if (action.when && !action.when()) continue;
      event.preventDefault();
      action.run(event);
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', handle);

  return { register, binding, rebind, reset, list, handle, run, actions };
}
