/**
 * Session storage.
 *
 * The token lives in localStorage because the API is on a different origin
 * from the CloudFront-served app, which rules out a same-site cookie without
 * a proxy. The tradeoff is honest and worth stating: this is readable by any
 * script that gets injected into the page, so the CSP and dependency hygiene
 * are what keep it safe. Moving the API behind the same domain and switching
 * to an httpOnly cookie is the upgrade path.
 */
import type { Actor } from './types';

const TOKEN_KEY = 'gn.token';
const ACTOR_KEY = 'gn.actor';

type Listener = (actor: Actor | null) => void;
const listeners = new Set<Listener>();

let cachedActor: Actor | null = null;

function readActor(): Actor | null {
  if (cachedActor) return cachedActor;
  const raw = localStorage.getItem(ACTOR_KEY);
  if (!raw) return null;
  try {
    cachedActor = JSON.parse(raw) as Actor;
    return cachedActor;
  } catch {
    localStorage.removeItem(ACTOR_KEY);
    return null;
  }
}

function notify() {
  listeners.forEach((fn) => fn(cachedActor));
}

export const session = {
  token: () => localStorage.getItem(TOKEN_KEY),
  actor: readActor,
  isSignedIn: () => Boolean(localStorage.getItem(TOKEN_KEY)),

  start(token: string, actor: Actor) {
    localStorage.setItem(TOKEN_KEY, token);
    this.setActor(actor);
  },

  setActor(actor: Actor) {
    cachedActor = actor;
    localStorage.setItem(ACTOR_KEY, JSON.stringify(actor));
    notify();
  },

  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ACTOR_KEY);
    cachedActor = null;
    notify();
  },

  /** Subscribe to sign-in/out and profile changes. Returns an unsubscribe. */
  onChange(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Send an unauthenticated visitor to the join flow, remembering where they were. */
export function requireSignIn(): boolean {
  if (session.isSignedIn()) return true;
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.replace(`/join.html?next=${next}`);
  return false;
}
