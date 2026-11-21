// SPDX-License-Identifier: Apache-2.0
// The motion of the drawings (site/tools/art.mjs draws them, with SMIL). Each one moves only while it
// is on screen, and starts the first time it is seen: the vignette of a letter plays when its letter
// is reached. Whoever asks their system for less motion sees each drawing still, on the frame it
// names (data-still, in seconds), and the stamp of the demo does not move either (lucid.css).

const less = matchMedia('(prefers-reduced-motion: reduce)');
const drawings = [...document.querySelectorAll('svg.art')];

function hold(drawing) {
  drawing.pauseAnimations();
  drawing.setCurrentTime(Number(drawing.dataset.still) || 0);
}

const watcher =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          if (less.matches) return;
          for (const { target, isIntersecting } of entries) {
            if (isIntersecting) target.unpauseAnimations();
            else target.pauseAnimations();
          }
        },
        { threshold: 0.2 },
      )
    : null;

for (const drawing of drawings) {
  if (less.matches) {
    hold(drawing);
  } else if (watcher) {
    drawing.pauseAnimations();
    watcher.observe(drawing);
  }
}
// WebKit starts the clock of a drawing at 0 right after the page has loaded, and takes no time set before
// that, not even while the load event is being handled: one held earlier is held again once it has started.
if (document.readyState !== 'complete') {
  addEventListener('load', () => setTimeout(() => less.matches && drawings.forEach(hold)), { once: true });
}

less.addEventListener('change', () => {
  for (const drawing of drawings) {
    if (less.matches) hold(drawing);
    else drawing.unpauseAnimations();
  }
});
