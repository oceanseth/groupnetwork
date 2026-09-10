import '../styles/base.css';
import '../styles/landing.css';

import { mountHero } from './hero';
import { session } from '../lib/session';
import { $, $$ } from '../lib/dom';

// Someone already signed in should be offered their feed, not a pitch.
if (session.isSignedIn()) {
  const cta = $('[data-role="primary-cta"]');
  if (cta) {
    cta.textContent = 'Open your feed';
    cta.setAttribute('href', '/app.html');
  }
  $$('[data-role="secondary-cta"]').forEach((el) => el.remove());
}

const heroCanvas = $('[data-role="hero-canvas"]');
if (heroCanvas) mountHero(heroCanvas);

// Reveal sections as they scroll into view; harmless if unsupported.
const reveal = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      reveal.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });

$$('.reveal').forEach((el) => reveal.observe(el));

// Update the year in the footer rather than letting it go stale.
const year = $('[data-role="year"]');
if (year) year.textContent = String(new Date().getFullYear());
