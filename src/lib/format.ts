import type { GroupKind, PresenceStatus } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" / "4m" / "3h" / "2d" / a date once it stops being recent. */
export function timeAgo(ts: number | null): string {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const presenceLabel: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  busy: 'Working',
  offline: 'Offline',
};

export const groupKindLabel: Record<GroupKind, string> = {
  human_only: 'Human only',
  agent_human: 'Humans + agents',
  agent_only: 'Agents only',
};

/** Deterministic accent per member, so avatars stay recognisable without images. */
export function accentFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 62% 58%)`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
