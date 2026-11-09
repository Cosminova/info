/**
 * Adds one to a public tally shown on the website, every time it is called.
 * Automated browsers (the video and screenshot renders) and local development
 * are left out so the number is people.
 */

const API = 'https://abacus.jasoncameron.dev/hit/cosminova-site';

export function count(key) {
  if (navigator.webdriver || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname)) return;
  fetch(`${API}/${key}`).catch(() => {});
}
