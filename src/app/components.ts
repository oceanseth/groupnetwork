/**
 * Shared render pieces.
 *
 * The post card is the important one: it is the surface where the difference
 * between a person, an agent and an unattributed-but-verified human has to be
 * unmistakable at a glance. Getting that labelling wrong is the failure mode
 * that would make the whole network untrustworthy, so it lives in one place.
 */
import type { Actor, Group, GroupMember, Post, Presence } from '../lib/types';
import { html, raw, formatBody, type RawHtml } from '../lib/dom';
import { accentFor, groupKindLabel, initials, presenceLabel, timeAgo } from '../lib/format';

export function avatar(name: string, url: string | null, seed: string, size = 40): RawHtml {
  if (url) {
    return html`<img class="avatar" src="${url}" alt="" width="${size}" height="${size}"
      style="width:${size}px;height:${size}px">`;
  }
  return html`<span class="avatar avatar--initials"
    style="width:${size}px;height:${size}px;background:${accentFor(seed)}">${initials(name)}</span>`;
}

export function presenceDot(presence: Presence | undefined): RawHtml {
  const status = presence?.status ?? 'offline';
  const title = presence?.detail
    ? `${presenceLabel[status]} — ${presence.detail}`
    : presenceLabel[status];
  return html`<span class="dot dot--${status}" title="${title}" aria-label="${title}"></span>`;
}

/** The badge that says what kind of thing wrote this. */
function authorBadge(post: Post): RawHtml {
  if (post.attribution === 'anonymous') {
    const strength = post.verification?.strength === 'voice' ? 'voice-verified' : 'captcha-verified';
    return html`<span class="badge badge--anon" title="Published without attribution. Group Network verified a human wrote it (${strength}), but not who.">
      Unattributed · verified human
    </span>`;
  }
  if (post.authorKind === 'agent') {
    return html`<span class="badge badge--agent" title="Written by an agent">Agent</span>`;
  }
  if (post.viaTwin) {
    return html`<span class="badge badge--twin" title="Posted by this member's digital twin on their behalf">via twin</span>`;
  }
  return raw('');
}

export function postCard(post: Post): RawHtml {
  const anonymous = post.attribution === 'anonymous';
  const name = anonymous ? 'Someone' : (post.author?.displayName ?? 'Unknown member');
  const handle = anonymous ? null : post.author?.handle ?? null;
  const seed = anonymous ? post.postId : post.author?.actorId ?? post.postId;

  return html`
    <article class="post ${anonymous ? 'post--anon' : ''}" data-post-id="${post.postId}">
      <div class="post__avatar">
        ${anonymous
          ? html`<span class="avatar avatar--anon" title="Author withheld">?</span>`
          : avatar(name, post.author?.avatarUrl ?? null, seed)}
      </div>
      <div class="post__main">
        <header class="post__head">
          ${handle
            ? html`<a class="post__author" href="/app.html#/member/${handle}">${name}</a>
                   <span class="post__handle">@${handle}</span>`
            : html`<span class="post__author">${name}</span>`}
          ${authorBadge(post)}
          <time class="post__time" datetime="${new Date(post.createdAt).toISOString()}">${timeAgo(post.createdAt)}</time>
        </header>
        <div class="post__body">${formatBody(post.body)}</div>
      </div>
    </article>
  `;
}

export function memberRow(member: Actor | GroupMember): RawHtml {
  const role = 'role' in member ? member.role : null;
  return html`
    <li class="member" data-actor-id="${member.actorId}">
      <a class="member__link" href="/app.html#/member/${member.handle}">
        ${avatar(member.displayName, member.avatarUrl, member.actorId, 32)}
        <span class="member__text">
          <span class="member__name">
            ${member.displayName}
            ${member.kind === 'agent' ? html`<span class="badge badge--agent">Agent</span>` : raw('')}
          </span>
          <span class="member__meta">
            ${presenceDot(member.presence)}
            ${member.presence?.detail ?? presenceLabel[member.presence?.status ?? 'offline']}
            ${role ? html`· ${role}` : raw('')}
          </span>
        </span>
      </a>
      <button class="btn btn--ghost btn--sm" data-action="message" data-member="${member.handle}">Message</button>
    </li>
  `;
}

export function groupCard(group: Group): RawHtml {
  return html`
    <article class="group-card" data-group-id="${group.groupId}">
      <a class="group-card__link" href="/app.html#/group/${group.groupId}">
        <h3 class="group-card__name">${group.name}</h3>
        <p class="group-card__desc">${group.description || 'No description yet.'}</p>
      </a>
      <footer class="group-card__foot">
        <span class="badge badge--kind badge--${group.kind}">${groupKindLabel[group.kind]}</span>
        <span class="group-card__count">${group.memberCount} ${group.memberCount === 1 ? 'member' : 'members'}</span>
        ${group.viewer
          ? html`<span class="group-card__joined">Joined</span>`
          : html`<button class="btn btn--sm" data-action="join-group" data-group-id="${group.groupId}">Join</button>`}
      </footer>
    </article>
  `;
}

export function emptyState(title: string, detail: string): RawHtml {
  return html`<div class="empty"><h3>${title}</h3><p>${detail}</p></div>`;
}

export function errorState(message: string): RawHtml {
  return html`<div class="empty empty--error"><h3>Something went wrong</h3><p>${message}</p></div>`;
}

export function spinner(label = 'Loading'): RawHtml {
  return html`<div class="loading" role="status"><span class="spinner"></span>${label}…</div>`;
}
