/**
 * The signed-in application: shell, hash router, and the realtime connection
 * every view shares.
 */
import '../styles/base.css';
import '../styles/app.css';

import type { AppConfig } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { session, requireSignIn } from '../lib/session';
import { realtime } from '../lib/realtime';
import { html, render, $ } from '../lib/dom';
import { avatar, errorState, presenceDot, spinner } from './components';
import { renderFeed } from './views/feed';
import { renderGroups, renderGroup } from './views/groups';
import { renderWall } from './views/wall';
import { renderChat } from './views/chat';
import { renderSettings } from './views/settings';

export interface ViewContext {
  config: AppConfig;
  outlet: HTMLElement;
  params: string[];
  navigate: (path: string) => void;
}

type View = (ctx: ViewContext) => void | Promise<void>;

const ROUTES: Array<[RegExp, View]> = [
  [/^\/?$/, renderFeed],
  [/^\/groups$/, renderGroups],
  [/^\/group\/([^/]+)$/, renderGroup],
  [/^\/member\/([^/]+)$/, renderWall],
  [/^\/chat(?:\/([^/]+))?$/, renderChat],
  [/^\/settings$/, renderSettings],
];

let config: AppConfig | null = null;
/** Lets a view cancel its own in-flight work when the route changes underneath it. */
let renderToken = 0;

function currentPath(): string {
  return location.hash.replace(/^#/, '') || '/';
}

function navigate(path: string) {
  if (currentPath() === path) void route();
  else location.hash = path;
}

function shell() {
  const actor = session.actor();
  if (!actor) return;

  render($('#app'), html`
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="/">
          <span class="brand__mark" aria-hidden="true"></span>
          <span class="brand__name">Group Network</span>
        </a>
        <nav class="topbar__nav">
          <a href="#/" data-nav="/">Feed</a>
          <a href="#/groups" data-nav="/groups">Groups</a>
          <a href="#/chat" data-nav="/chat">Messages</a>
          <a href="#/settings" data-nav="/settings">Settings</a>
        </nav>
        <div class="topbar__me">
          <span class="topbar__conn" data-role="conn" title="Realtime connection"></span>
          <a class="topbar__profile" href="#/member/${actor.handle}">
            ${avatar(actor.displayName, actor.avatarUrl, actor.actorId, 32)}
            <span class="topbar__name">${actor.displayName}</span>
            ${presenceDot(actor.presence)}
          </a>
          <button class="btn btn--ghost btn--sm" data-action="sign-out">Sign out</button>
        </div>
      </header>
      <main class="outlet" id="outlet">${spinner()}</main>
    </div>
  `);

  $('#app')?.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-action="sign-out"]')) {
      realtime.disconnect();
      session.clear();
      location.href = '/';
    }
  });
}

function markActiveNav() {
  const path = currentPath();
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((link) => {
    const target = link.dataset.nav ?? '/';
    const active = target === '/' ? path === '/' : path.startsWith(target);
    link.classList.toggle('is-active', active);
  });
}

function paintConnection() {
  const el = $('[data-role="conn"]');
  if (!el) return;
  const status = realtime.enabled ? realtime.connectionStatus : 'offline';
  el.className = `topbar__conn topbar__conn--${status}`;
  el.title = realtime.enabled
    ? `Realtime ${status}`
    : 'Realtime is not configured for this build — the app polls instead.';
}

async function route() {
  if (!config) return;
  const path = currentPath();
  const stale = $('#outlet');
  if (!stale) return;

  // Views bind delegated listeners to the outlet, and the outlet itself
  // survives navigation — so replacing it with an empty clone is what stops
  // handlers from accumulating and firing N times on the Nth visit.
  const outlet = stale.cloneNode(false) as HTMLElement;
  stale.replaceWith(outlet);

  markActiveNav();
  const token = ++renderToken;

  for (const [pattern, view] of ROUTES) {
    const match = pattern.exec(path);
    if (!match) continue;
    try {
      await view({ config, outlet, params: match.slice(1).filter(Boolean), navigate });
    } catch (err) {
      // A stale view losing a race should not overwrite the current one.
      if (token !== renderToken) return;
      const message = err instanceof ApiError ? err.message : 'Unexpected error.';
      render(outlet, errorState(message));
    }
    return;
  }

  render(outlet, html`<div class="empty"><h3>Nothing here</h3><p>That page does not exist.</p></div>`);
}

async function boot() {
  if (!requireSignIn()) return;

  try {
    // Confirm the stored session is still good before drawing a signed-in shell.
    const [loadedConfig, me] = await Promise.all([api.config(), api.auth.me()]);
    config = loadedConfig;
    session.setActor(me.actor);

    if (!me.onboarded) {
      location.replace('/join.html?step=profile');
      return;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      session.clear();
      location.replace('/join.html');
      return;
    }
    render($('#app'), html`
      <div class="boot-error">
        ${errorState(err instanceof Error ? err.message : 'Could not start the app.')}
        <button class="btn" onclick="location.reload()">Retry</button>
      </div>`);
    return;
  }

  shell();
  void realtime.connect();

  // Repaint the connection indicator as the socket comes and goes.
  realtime.on(() => paintConnection());
  window.setInterval(paintConnection, 2000);
  paintConnection();

  window.addEventListener('hashchange', () => void route());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) realtime.setStatus('online');
  });

  await route();
}

// Keep the shell's own avatar and name in step with profile edits.
session.onChange((actor) => {
  if (!actor) return;
  const name = $('.topbar__name');
  if (name) name.textContent = actor.displayName;
});

void boot();

export { navigate };
