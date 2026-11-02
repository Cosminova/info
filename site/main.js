/**
 * Page behaviour: a header that reacts to scroll, and sections that arrive.
 *
 * Both are progressive. The reveal class is only armed once the observer is
 * attached, so with scripting unavailable the page renders fully visible
 * instead of staying transparent forever, and the hero video falls back to its
 * poster without any help from here.
 */

const nav = document.getElementById('nav');

if (nav) {
  // A threshold rather than any-scroll, so the header does not flicker its
  // background on the first pixel of an inertial scroll.
  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 40);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

const targets = document.querySelectorAll('.reveal');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (targets.length && 'IntersectionObserver' in window && !still) {
  for (const el of targets) el.classList.add('is-armed');

  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        // One-way: an element that has arrived should not fade out again when
        // scrolled back past.
        seen.unobserve(entry.target);
      }
    },
    // Fires a little before the element's top edge reaches the fold, so the
    // motion finishes about when it is properly in view.
    { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
  );

  for (const el of targets) seen.observe(el);
}

/*
 * Live counts under "At a glance".
 *
 * Visitors are counted here and players by the app, both once per browser:
 * the flag is in localStorage, which this page and the app at /app/ share.
 * Downloads are GitHub's own count of the installer across every release.
 * Any number that cannot be fetched is left out rather than shown as a guess,
 * and the row stays hidden if none can be.
 */
const live = document.querySelector('.stats__live');

if (live) {
  const COUNTER = 'https://abacus.jasoncameron.dev';
  const NS = 'cosminova-site';
  const human = !navigator.webdriver && !/^(localhost|127\.|\[::1\])/.test(location.hostname);

  const counter = async (key, hit) => {
    const res = await fetch(`${COUNTER}/${hit ? 'hit' : 'get'}/${NS}/${key}`);
    if (!res.ok) throw new Error(`${key}: ${res.status}`);
    return (await res.json()).value;
  };

  const visitors = (async () => {
    let seen = true;
    try {
      seen = !human || localStorage.getItem('cosminova-counted-visitors') === '1';
    } catch { /* storage blocked: read without counting */ }
    const value = await counter('visitors', !seen);
    if (!seen) localStorage.setItem('cosminova-counted-visitors', '1');
    return value;
  })();

  const downloads = (async () => {
    const res = await fetch('https://api.github.com/repos/Cosminova/info/releases?per_page=100');
    if (!res.ok) throw new Error(`downloads: ${res.status}`);
    let total = 0;
    for (const release of await res.json()) {
      for (const asset of release.assets ?? []) total += asset.download_count ?? 0;
    }
    return total;
  })();

  const show = (key, value) => {
    const el = live.querySelector(`[data-count="${key}"]`);
    if (!el) return;
    live.hidden = false;
    if (still || value < 10) {
      el.textContent = value.toLocaleString('en-US');
      return;
    }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min((now - t0) / 1400, 1);
      el.textContent = Math.round(value * (1 - (1 - k) ** 3)).toLocaleString('en-US');
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const entries = [['visitors', visitors], ['players', counter('players', false)], ['downloads', downloads]];
  for (const [key, promise] of entries) {
    promise.then((value) => show(key, value)).catch(() => {
      live.querySelector(`[data-count="${key}"]`)?.closest('li')?.remove();
    });
  }
}

/*
 * The hero slideshow.
 *
 * Everything below is an enhancement of markup that already works: the first
 * slide has a real src and is visible without any of this, so a failure here
 * costs the rotation and nothing else.
 */
const slides = [...document.querySelectorAll('.hero__slide')];

if (slides.length > 1) {
  // Kept in step with the hero-drift animation in styles.css.
  const DWELL = 7600;

  const dots = document.querySelector('.hero__dots');
  const title = document.querySelector('.hero__caption-title');
  const note = document.querySelector('.hero__caption-note');
  const caption = document.querySelector('.hero__caption');

  let index = 0;
  let timer = null;
  // Set once a dot is used. From then on the slideshow stays where it was put:
  // advancing under someone who has just chosen a picture is the web at its
  // most irritating.
  let surrendered = false;

  /** Fetches a slide's image if it has not been fetched yet. */
  const load = (slide) => {
    if (!slide || !slide.dataset.src) return;
    slide.src = slide.dataset.src;
    delete slide.dataset.src;
  };

  const show = (next) => {
    slides[index].classList.remove('is-active');
    index = (next + slides.length) % slides.length;
    const slide = slides[index];
    load(slide);
    slide.classList.add('is-active');

    if (title) title.textContent = slide.dataset.title ?? '';
    if (note) note.textContent = slide.dataset.note ?? '';
    // Restarting the animation needs a reflow between the removal and the
    // re-add, or the browser coalesces the two and nothing replays.
    if (caption) {
      caption.style.animation = 'none';
      void caption.offsetHeight;
      caption.style.animation = '';
    }

    for (const dot of dots?.children ?? []) {
      dot.setAttribute('aria-selected', String(Number(dot.dataset.index) === index));
    }

    // One ahead, so the next crossfade has something decoded to fade to.
    load(slides[(index + 1) % slides.length]);
  };

  const stop = () => {
    clearInterval(timer);
    timer = null;
  };

  const start = () => {
    if (timer || surrendered || still) return;
    timer = setInterval(() => show(index + 1), DWELL);
  };

  if (dots) {
    slides.forEach((slide, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'hero__dot';
      dot.dataset.index = String(i);
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-selected', String(i === 0));
      dot.setAttribute('aria-label', slide.dataset.title ?? `View ${i + 1}`);
      dot.addEventListener('click', () => {
        surrendered = true;
        stop();
        show(i);
      });
      dots.append(dot);
    });
  }

  show(0);

  // Nothing to gain from decoding images for a tab nobody is looking at, or
  // for a hero that has been scrolled past.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  const heroEl = document.querySelector('.hero');
  if (heroEl && 'IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      for (const entry of entries) (entry.isIntersecting ? start : stop)();
    }).observe(heroEl);
  } else {
    start();
  }
}
