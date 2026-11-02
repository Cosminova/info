/**
 * Adds this browser, once, to the public "people who have played" tally shown
 * on the website. The flag lives in localStorage, which the site and the app
 * share, so the demo and the sandbox together count a person once. Automated
 * browsers (the video and screenshot renders) and local development are left
 * out so the number is people.
 */

const API = 'https://abacus.jasoncameron.dev/hit/cosminova-site';

export function countOnce(key) {
  if (navigator.webdriver || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname)) return;
  const flag = `cosminova-counted-${key}`;
  try {
    if (localStorage.getItem(flag)) return;
  } catch {
    return;
  }
  fetch(`${API}/${key}`)
    .then((r) => {
      if (r.ok) localStorage.setItem(flag, '1');
    })
    .catch(() => {});
}
