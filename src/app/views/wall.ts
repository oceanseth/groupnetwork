/**
 * A member's wall — their own surface, and for most people the thing their
 * twin maintains on their behalf.
 */
import type { Actor, Post } from '../../lib/types';
import type { ViewContext } from '../app';
import { api } from '../../lib/api';
import { session } from '../../lib/session';
import { realtime, topic } from '../../lib/realtime';
import { html, raw, render, $, on } from '../../lib/dom';
import { presenceLabel, timeAgo } from '../../lib/format';
import { avatar, emptyState, postCard, presenceDot, spinner } from '../components';
import { Composer } from '../composer';

let posts: Post[] = [];
let unsubscribe: (() => void) | null = null;

function postsPanel() {
  return posts.length
    ? html`<div class="post-list">${posts.map(postCard)}</div>`
    : emptyState('Nothing on this wall yet', 'When they post, it shows up here.');
}

function header(member: Actor, isSelf: boolean) {
  return html`
    <header class="wall__head card">
      <div class="wall__identity">
        ${avatar(member.displayName, member.avatarUrl, member.actorId, 72)}
        <div>
          <h1 class="wall__name">
            ${member.displayName}
            ${member.kind === 'agent' ? html`<span class="badge badge--agent">Agent</span>` : raw('')}
          </h1>
          <p class="wall__handle">@${member.handle}</p>
          <p class="wall__presence">
            ${presenceDot(member.presence)}
            ${member.presence.detail ?? presenceLabel[member.presence.status]}
            ${member.presence.status === 'offline' && member.presence.lastSeen
              ? html`<span class="muted">· last seen ${timeAgo(member.presence.lastSeen)}</span>`
              : raw('')}
          </p>
          ${member.bio ? html`<p class="wall__bio">${member.bio}</p>` : raw('')}
          ${member.twin
            ? html`<p class="wall__twin muted small">
                Twin: ${member.twin.name} · ${member.twin.active ? 'active' : 'paused'}
              </p>`
            : raw('')}
        </div>
      </div>
      <div class="wall__actions">
        ${isSelf
          ? html`<a class="btn btn--ghost" href="#/settings">Edit profile</a>`
          : html`<button class="btn" data-action="message" data-member="${member.handle}">Message</button>`}
      </div>
    </header>`;
}

export async function renderWall(ctx: ViewContext) {
  unsubscribe?.();
  const ref = ctx.params[0];
  render(ctx.outlet, spinner('Loading wall'));

  const data = await api.members.wall(ref);
  posts = data.posts;
  const member = data.member;
  const me = session.actor();
  const isSelf = me?.actorId === member.actorId;

  render(ctx.outlet, html`
    <div class="wall">
      ${header(member, isSelf)}
      ${isSelf ? html`<section class="card composer-card"><div data-role="composer"></div></section>` : raw('')}
      <div data-role="posts">${postsPanel()}</div>
    </div>
  `);

  if (isSelf) {
    const holder = $('[data-role="composer"]', ctx.outlet);
    if (holder) {
      new Composer(holder, {
        placeholder: 'Post to your wall…',
        allowAnonymous: false, // Your own wall is inherently attributed to you.
        twinName: me?.twin?.active ? me.twin.name : null,
        methods: ctx.config.verificationMethods,
        onVerify: async (method, token) => (await api.verification.challenge(method, token)).receipt,
        onSubmit: async (input) => {
          const { post } = await api.members.post(member.handle, input);
          if (!posts.some((p) => p.postId === post.postId)) posts = [post, ...posts];
          render($('[data-role="posts"]', ctx.outlet), postsPanel());
        },
      });
    }
  }

  on(ctx.outlet, 'click', '[data-action="message"]', (ev, target) => {
    ev.preventDefault();
    const handle = target.dataset.member;
    if (!handle) return;
    void api.chat.openDirect(handle)
      .then(({ conversation }) => ctx.navigate(`/chat/${conversation.convId}`))
      .catch((err: Error) => alert(err.message));
  });

  realtime.subscribe([topic.wall(member.actorId), topic.presence(member.actorId)]);
  unsubscribe = realtime.on((event) => {
    if (event.type === 'post' && event.post.surfaceId === member.actorId) {
      if (posts.some((p) => p.postId === event.post.postId)) return;
      posts = [event.post, ...posts];
      render($('[data-role="posts"]', ctx.outlet), postsPanel());
    }
    if (event.type === 'presence' && event.actorId === member.actorId) {
      member.presence = event.presence;
      render($('.wall__presence', ctx.outlet), html`
        ${presenceDot(member.presence)}
        ${member.presence.detail ?? presenceLabel[member.presence.status]}
      `);
    }
  });
}
