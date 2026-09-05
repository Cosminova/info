/**
 * Shared interface primitives: panels, tooltips, context menus, dialogs and the
 * small controls the panels are built from.
 *
 * These exist so the two apps cannot drift apart visually. A panel is a panel
 * everywhere, and a slider carries its own label-and-value layout rather than
 * every caller assembling one.
 */

import { el, append, text, css, show } from './dom.js';

/**
 * A collapsible panel with a header.
 *
 * Collapsing is a class on the panel, animated by a grid row in the stylesheet,
 * so content of any height collapses correctly without a measured pixel value.
 */
export function panel({ id, title, actions = [], body = [], collapsed = false, onToggle }) {
  const content = el('div', { class: 'panel-body' }, body);
  const collapse = el('div', { class: 'panel-collapse' }, [content]);
  const caret = el('span', { class: 'panel-caret', 'aria-hidden': 'true' });

  const head = el('div', { class: 'panel-head takes-pointer' }, [
    caret,
    el('span', { class: 'panel-title', text: title }),
    ...actions,
  ]);

  const root = el('div', {
    class: `panel panel-dock${collapsed ? ' is-collapsed' : ''}`,
    dataset: { panel: id },
  }, [head, collapse]);

  function setCollapsed(value) {
    css(root, 'is-collapsed', value);
    onToggle?.(value);
  }

  // The whole header toggles, not just the caret: a 9-pixel caret is a poor
  // target, and there is nothing else in the header to hit by accident.
  head.addEventListener('click', (event) => {
    if (event.target.closest('button, input, a')) return;
    setCollapsed(!root.classList.contains('is-collapsed'));
  });

  return {
    root,
    body: content,
    head,
    setCollapsed,
    get collapsed() {
      return root.classList.contains('is-collapsed');
    },
    setTitle(value) {
      text(head.querySelector('.panel-title'), value);
    },
  };
}

/** A labelled range slider that shows its own formatted value. */
export function slider({
  label, min, max, step, value, format = (v) => v.toFixed(2), onInput, title,
}) {
  const out = el('span', { class: 'field-value', text: format(value) });
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    'aria-label': label,
  });
  input.addEventListener('input', () => {
    const next = Number(input.value);
    text(out, format(next));
    onInput?.(next);
  });
  const root = el('label', { class: 'field', title }, [
    el('span', { class: 'field-label', text: label }),
    out,
    input,
  ]);
  return {
    root,
    input,
    set(next) {
      input.value = String(next);
      text(out, format(next));
    },
  };
}

export function check({ label, checked, onChange, title }) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange?.(input.checked));
  return {
    root: el('label', { class: 'check', title }, [input, el('span', { text: label })]),
    input,
    set(next) {
      input.checked = Boolean(next);
    },
  };
}

/** Mutually exclusive buttons. Values are compared with ===. */
export function segmented({ options, value, onChange, title }) {
  const buttons = options.map((option) =>
    el('button', {
      type: 'button',
      text: option.label,
      title: option.title,
      dataset: { value: String(option.value) },
      onClick: () => onChange?.(option.value),
    }),
  );
  const root = el('div', { class: 'segmented takes-pointer', title }, buttons);
  function set(next) {
    for (const button of buttons) css(button, 'is-active', button.dataset.value === String(next));
  }
  set(value);
  return { root, set, buttons };
}

export function iconButton({ icon, label, onClick, shortcut, className = '' }) {
  const button = el('button', {
    type: 'button',
    class: `btn is-icon is-quiet ${className}`.trim(),
    'aria-label': label,
    onClick,
  }, [icon]);
  button.dataset.tip = label;
  if (shortcut) button.dataset.tipKey = shortcut;
  return button;
}

/**
 * One tooltip element reused for every target, driven by `data-tip`.
 *
 * Delegated from the document rather than per-element listeners so anything can
 * grow a tooltip by setting an attribute, including elements created later.
 */
export function createTooltips() {
  const node = el('div', { class: 'tooltip', role: 'tooltip' });
  document.body.append(node);
  let openFor = null;
  let timer = 0;

  function place(target) {
    const rect = target.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    // Prefer the right of the target, which is where the icon rail wants it;
    // flip to the left when that would run past the viewport edge.
    let left = rect.right + 8;
    if (left + own.width > window.innerWidth - 8) left = rect.left - own.width - 8;
    let top = rect.top + rect.height / 2 - own.height / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - own.height - 8));
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${top}px`;
  }

  function open(target) {
    const label = target.dataset.tip;
    if (!label) return;
    openFor = target;
    node.replaceChildren();
    append(node, [
      el('span', { text: label }),
      target.dataset.tipKey ? el('kbd', { text: target.dataset.tipKey }) : null,
    ]);
    node.style.left = '-9999px';
    css(node, 'is-open', true);
    place(target);
  }

  function close() {
    openFor = null;
    css(node, 'is-open', false);
  }

  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target || target === openFor) return;
    clearTimeout(timer);
    timer = setTimeout(() => open(target), 260);
  });

  document.addEventListener('pointerout', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (!target) return;
    clearTimeout(timer);
    close();
  });

  // A tooltip left hanging over the view after a click is exactly the kind of
  // chrome that gets into a screenshot.
  document.addEventListener('pointerdown', () => {
    clearTimeout(timer);
    close();
  }, true);

  return { close };
}

/**
 * Context menu. One at a time; opening another or clicking away closes it.
 *
 * Items are `{ label, run, shortcut, disabled }`, or the string '-' for a rule.
 */
export function createMenu() {
  let node = null;

  function close() {
    node?.remove();
    node = null;
  }

  function open({ x, y, title, subtitle, items }) {
    close();
    const children = [];
    if (title) {
      children.push(el('div', { class: 'menu-head' }, [
        el('div', { class: 't', text: title }),
        subtitle ? el('div', { class: 's', text: subtitle }) : null,
      ]));
    }
    for (const item of items) {
      if (item === '-') {
        children.push(el('hr'));
        continue;
      }
      children.push(el('button', {
        type: 'button',
        disabled: item.disabled,
        onClick: () => {
          close();
          item.run?.();
        },
      }, [
        el('span', { text: item.label }),
        item.shortcut ? el('span', { class: 'sh', text: item.shortcut }) : null,
      ]));
    }

    node = el('div', { class: 'menu takes-pointer', role: 'menu' }, children);
    // Positioned off-screen first so the size can be measured before deciding
    // which way to open; otherwise a menu near the right or bottom edge opens
    // partly outside the window.
    node.style.left = '-9999px';
    node.style.top = '-9999px';
    document.body.append(node);
    const rect = node.getBoundingClientRect();
    const left = x + rect.width > window.innerWidth - 8 ? x - rect.width : x;
    const top = y + rect.height > window.innerHeight - 8 ? y - rect.height : y;
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
    return node;
  }

  window.addEventListener('pointerdown', (event) => {
    if (node && !node.contains(event.target)) close();
  }, true);
  window.addEventListener('blur', close);

  return { open, close, get isOpen() { return Boolean(node); } };
}

/** A floating dialog, positioned by CSS via a placement class. */
export function dialog({ title, body, placement = 'center', actions = [], onClose }) {
  const close = el('button', {
    type: 'button',
    class: 'btn is-icon is-quiet',
    'aria-label': 'Close',
    text: '\u00d7',
    onClick: () => onClose?.(),
  });
  const content = el('div', { class: 'dialog-body scroll' }, body);
  const root = el('div', { class: `dialog is-${placement}`, role: 'dialog' }, [
    el('div', { class: 'dialog-head' }, [
      el('h2', { text: title }),
      ...actions,
      close,
    ]),
    content,
  ]);
  return { root, body: content, setOpen: (open) => show(root, open) };
}

/** Inline SVG icons. Thin strokes, 16px grid, currentColor. */
export const icons = {
  search: 'M6.5 1.5a5 5 0 1 0 3.2 8.85l3.6 3.6.7-.7-3.6-3.6A5 5 0 0 0 6.5 1.5Zm0 1a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  compass: 'M8 1.2a6.8 6.8 0 1 0 0 13.6A6.8 6.8 0 0 0 8 1.2Zm0 1a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2Zm2.9 2.9L7.3 6.6 5.1 10.9l4.3-2.2 1.5-3.6ZM8 7.3a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z',
  camera: 'M2 4.5h2.2l.9-1.3h5.8l.9 1.3H14v8H2v-8Zm1 1v6h10v-6h-1.7l-.9-1.3H5.6l-.9 1.3H3Zm5 .8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Zm0 1a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z',
  planet: 'M8 2a6 6 0 1 0 4.6 9.85 6 6 0 0 0-9.2-7.7A6 6 0 0 1 8 2Zm0 1a5 5 0 1 1 0 10A5 5 0 0 1 8 3Zm6.6 3.1c.9.5 1.4 1.1 1.4 1.7 0 1.3-2.6 2.4-6 2.4-1.2 0-2.3-.15-3.2-.4l.7-.7c.75.15 1.6.25 2.5.25 3 0 5-.9 5-1.55 0-.3-.4-.65-1.1-.95l.7-.75Z',
  system: 'M8 6.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8ZM8 1.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm-5.4 9a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm10.8 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6ZM8 4.6v1.4M6.9 9.1l-2.9 1.7M9.1 9.1l2.9 1.7',
  catalog: 'M2.5 2.5h4.2v11H2.5v-11Zm5.2 0h2.6v11H7.7v-11Zm3.6 0 2.2.4-1.7 10.6-2.2-.4 1.7-10.6Z',
  bookmark: 'M4 2h8v12l-4-3-4 3V2Zm1 1v9.1l3-2.25 3 2.25V3H5Z',
  settings: 'M6.9 1.5h2.2l.3 1.7 1 .4 1.5-.9 1.5 1.5-.9 1.5.4 1 1.7.3v2.2l-1.7.3-.4 1 .9 1.5-1.5 1.5-1.5-.9-1 .4-.3 1.7H6.9l-.3-1.7-1-.4-1.5.9-1.5-1.5.9-1.5-.4-1-1.7-.3V6.9l1.7-.3.4-1-.9-1.5 1.5-1.5 1.5.9 1-.4.3-1.7ZM8 5.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2Z',
  clock: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11ZM7.5 4h1v4.2l3 1.8-.5.85L7.5 8.8V4Z',
  eye: 'M8 3.5c3.4 0 6.1 2.3 7 4.5-.9 2.2-3.6 4.5-7 4.5S1.9 10.2 1 8c.9-2.2 3.6-4.5 7-4.5Zm0 1C5.3 4.5 3.1 6.2 2.1 8c1 1.8 3.2 3.5 5.9 3.5S13.9 9.8 14.9 8C13.9 6.2 11.7 4.5 9 4.5H8Zm0 1.3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z',
  help: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm0 1.9c1.3 0 2.2.8 2.2 1.95 0 .8-.35 1.25-1.1 1.75-.5.35-.6.5-.6.95v.35h-1v-.5c0-.75.25-1.1 1-1.6.55-.4.7-.6.7-.95 0-.55-.45-.95-1.2-.95s-1.2.4-1.25 1.1h-1C5.8 5.2 6.7 4.4 8 4.4Zm-.05 6a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z',
  gauge: 'M8 2.2a6.3 6.3 0 0 0-5.6 9.2l.87-.5A5.3 5.3 0 1 1 12.73 11l.87.5A6.3 6.3 0 0 0 8 2.2Zm3.1 2.85L8.6 8.2a1.1 1.1 0 1 0 .78.63l2.5-3.15-.78-.63ZM3.6 7.3a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm8.8 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM8 3.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z',
};

export function icon(name, size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icons[name] ?? icons.planet);
  // Filled glyphs, with the stroke only used by the few icons drawn as lines.
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('stroke', name === 'system' ? 'currentColor' : 'none');
  path.setAttribute('stroke-width', name === 'system' ? '1' : '0');
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}
