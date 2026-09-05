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
 * Autoplay is refused on some setups (low power mode in particular). The video
 * is decorative and the poster is the same frame, so the only thing worth
 * doing is making sure a refused play does not surface as an unhandled
 * rejection in the console.
 */
const hero = document.querySelector('.hero__video');
if (hero) {
  const attempt = hero.play();
  if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
}
