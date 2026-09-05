/**
 * Small DOM helpers for the interface.
 *
 * The important one is `text`. Readouts here are driven from the render loop,
 * where distance, coordinates and time change every frame, and writing to
 * `textContent` invalidates layout for that element whether or not the string
 * differs. Comparing first costs a string compare and saves the browser
 * re-laying-out a dozen nodes sixty times a second for values that mostly have
 * not changed — the interface is meant to be free when nothing is happening.
 */

/** Create an element. Children may be nodes, strings, or nested arrays. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of Array.isArray(children) ? children.flat(4) : [children]) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Write only when the string differs. Returns whether it wrote. */
export function text(node, value) {
  if (!node) return false;
  const next = value === undefined || value === null ? '' : String(value);
  if (node.__text === next) return false;
  node.__text = next;
  node.textContent = next;
  return true;
}

/** Toggle a class only when it would change. */
export function css(node, name, on) {
  if (!node) return;
  const has = node.classList.contains(name);
  if (has === Boolean(on)) return;
  node.classList.toggle(name, Boolean(on));
}

/** Set an attribute only when it would change. */
export function attr(node, name, value) {
  if (!node) return;
  if (value === false || value === null || value === undefined) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const next = value === true ? '' : String(value);
  if (node.getAttribute(name) === next) return;
  node.setAttribute(name, next);
}

export function show(node, visible) {
  if (!node) return;
  const hide = !visible;
  if (node.hidden === hide) return;
  node.hidden = hide;
}

export function clear(node) {
  if (node) node.replaceChildren();
}

/**
 * Rebuild a list only when its shape changed.
 *
 * The signature is whatever identifies the contents — usually joined keys. A
 * list whose signature matches is left completely alone, which is what keeps
 * the inspector from tearing down and rebuilding its rows because the distance
 * to the target ticked over.
 */
export function reconcile(node, signature, build) {
  if (!node) return false;
  if (node.__sig === signature) return false;
  node.__sig = signature;
  node.replaceChildren();
  append(node, build());
  return true;
}

/** Frames-to-milliseconds throttle for readouts that need not be per-frame. */
export function throttle(ms, fn) {
  let last = -Infinity;
  return (...args) => {
    const now = performance.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}
