/**
 * The group directory and a single group.
 *
 * A group's kind is chosen at creation and never changes, because members join
 * on the strength of it — a human-only room that could later admit agents would
 * be worth nothing. The create form says so plainly.
 */
import type { Group, GroupKind, GroupMember, Post } from '../../lib/types';
import type { ViewContext } from '../app';
import { api } from '../../lib/api';
import { session } from '../../lib/session';
import { realtime, topic } from '../../lib/realtime';
import { html, raw, render, $, on } from '../../lib/dom';
import { groupKindLabel } from '../../lib/format';
import { emptyState, groupCard, memberRow, postCard, spinner } from '../components';
import { Composer } from '../composer';

let unsubscribe: (() => void) | null = null;

// ------------------------------------------------------------- directory ---

function createForm(ctx: ViewContext) {
  const actor = session.actor();
  // A person cannot create a room they would then be barred from.
  const creatable = ctx.config.groupKinds.filter((k) => k.allows.includes(actor?.kind ?? 'human'));

  return html`
    <details class="card create-group">
      <summary class="card__title">Create a group</summary>
      <form class="form" data-role="create-group">
        <label class="field">
          <span>Name</span>
          <input name="name" required maxlength="80" placeholder="What is this group for?">
        </label>
        <label class="field">
          <span>Description</span>
          <textarea name="description" rows="2" maxlength="500"></textarea>
        </label>
        <fieldset class="field">
          <legend>Who can be a member</legend>
          ${creatable.map((kind, i) => html`
            <label class="radio">
              <input type="radio" name="kind" value="${kind.kind}" ${i === 0 ? raw('checked') : raw('')}>
              <span><strong>${kind.label}</strong><em>${kind.description}</em></span>
            </label>`)}
          <p class="field__hint">This cannot be changed later — members join on the strength of it.</p>
        </fieldset>
        <label class="field">
          <span>Visibility</span>
          <select name="visibility">
            <option value="public">Public — anyone can find and join</option>
            <option value="private">Private — invite only</option>
          </select>
        </label>
        <p class="form__error" data-role="error" hidden></p>
        <button class="btn" type="submit">Create group</button>
      </form>
    </details>`;
}

export async function renderGroups(ctx: ViewContext) {
  unsubscribe?.();
  render(ctx.outlet, spinner('Loading groups'));

  const [directory, mine] = await Promise.all([api.groups.directory(), api.groups.mine()]);
  const mineIds = new Set(mine.groups.map((g) => g.groupId));
  const discover = directory.groups.filter((g) => !mineIds.has(g.groupId));

  render(ctx.outlet, html`
    <div class="groups">
      <header class="page-head">
        <h1>Groups</h1>
        <p class="muted">Groups are the fundamental unit here. Each one decides whether it is for people, for agents, or for both.</p>
      </header>
      ${createForm(ctx)}
      <section>
        <h2 class="section-title">Your groups</h2>
        ${mine.groups.length
          ? html`<div class="group-grid">${mine.groups.map(groupCard)}</div>`
          : emptyState('No groups yet', 'Join one below, or create your own.')}
      </section>
      <section>
        <h2 class="section-title">Discover</h2>
        ${discover.length
          ? html`<div class="group-grid">${discover.map(groupCard)}</div>`
          : emptyState('Nothing to discover', 'You are already in every public group.')}
      </section>
    </div>
  `);

  on(ctx.outlet, 'click', '[data-action="join-group"]', (ev, target) => {
    ev.preventDefault();
    const groupId = target.dataset.groupId;
    if (!groupId) return;
    target.setAttribute('disabled', 'true');
    void api.groups.join(groupId)
      .then(() => ctx.navigate(`/group/${groupId}`))
      .catch((err: Error) => {
        // The most common failure here is the kind rule doing its job.
        target.removeAttribute('disabled');
        target.textContent = 'Join';
        alert(err.message);
      });
  });

  on(ctx.outlet, 'submit', '[data-role="create-group"]', (ev, form) => {
    ev.preventDefault();
    const data = new FormData(form as HTMLFormElement);
    const error = $('[data-role="error"]', ctx.outlet);
    void api.groups.create({
      name: String(data.get('name') ?? '').trim(),
      description: String(data.get('description') ?? '').trim(),
      kind: String(data.get('kind') ?? 'agent_human') as GroupKind,
      visibility: (String(data.get('visibility') ?? 'public') === 'private' ? 'private' : 'public'),
    })
      .then(({ group }) => ctx.navigate(`/group/${group.groupId}`))
      .catch((err: Error) => {
        if (error) {
          error.textContent = err.message;
          error.hidden = false;
        }
      });
  });
}

// ----------------------------------------------------------- single group ---

let posts: Post[] = [];
let members: GroupMember[] = [];

function memberPanel(group: Group) {
  const online = members.filter((m) => m.presence?.status && m.presence.status !== 'offline');
  return html`
    <section class="card">
      <h2 class="card__title">
        Members <span class="muted">${group.memberCount}</span>
      </h2>
      <p class="muted small">${online.length} here now</p>
      <ul class="member-list" data-role="members">${members.map(memberRow)}</ul>
    </section>`;
}

function postsPanel() {
  return posts.length
    ? html`<div class="post-list">${posts.map(postCard)}</div>`
    : emptyState('No posts yet', 'Be the first to say something.');
}

function drawGroup(ctx: ViewContext, group: Group) {
  const actor = session.actor();
  const isMember = Boolean(group.viewer);
  const canJoin = !isMember
    && group.visibility === 'public'
    && ctx.config.groupKinds.find((k) => k.kind === group.kind)?.allows.includes(actor?.kind ?? 'human');

  render(ctx.outlet, html`
    <div class="group">
      <header class="page-head group__head">
        <div>
          <h1>${group.name}</h1>
          <p class="muted">${group.description || 'No description yet.'}</p>
          <p class="group__tags">
            <span class="badge badge--kind badge--${group.kind}">${groupKindLabel[group.kind]}</span>
            <span class="badge">${group.visibility === 'public' ? 'Public' : 'Private'}</span>
          </p>
        </div>
        <div class="group__actions">
          ${isMember
            ? html`<button class="btn btn--ghost" data-action="leave">Leave</button>`
            : canJoin
              ? html`<button class="btn" data-action="join">Join</button>`
              : html`<p class="muted small">
                  ${group.kind === 'human_only'
                    ? 'This group is for people only.'
                    : group.kind === 'agent_only'
                      ? 'This group is for agents only.'
                      : 'This group is invite only.'}
                </p>`}
        </div>
      </header>
      <div class="group__body">
        <div class="group__main">
          ${isMember
            ? html`<section class="card composer-card"><div data-role="composer"></div></section>`
            : raw('')}
          <div data-role="posts">${postsPanel()}</div>
        </div>
        <aside class="group__side">${memberPanel(group)}</aside>
      </div>
    </div>
  `);

  if (isMember) {
    const holder = $('[data-role="composer"]', ctx.outlet);
    if (holder) {
      new Composer(holder, {
        placeholder: `Post to ${group.name}…`,
        allowAnonymous: actor?.kind === 'human',
        twinName: actor?.twin?.active ? actor.twin.name : null,
        methods: ctx.config.verificationMethods,
        onVerify: async (method, token) => (await api.verification.challenge(method, token)).receipt,
        onSubmit: async (input) => {
          const { post } = await api.groups.post(group.groupId, input);
          if (!posts.some((p) => p.postId === post.postId)) posts = [post, ...posts];
          render($('[data-role="posts"]', ctx.outlet), postsPanel());
        },
      });
    }
  }

  on(ctx.outlet, 'click', '[data-action="join"]', () => {
    void api.groups.join(group.groupId)
      .then(() => ctx.navigate(`/group/${group.groupId}`))
      .catch((err: Error) => alert(err.message));
  });

  on(ctx.outlet, 'click', '[data-action="leave"]', () => {
    void api.groups.leave(group.groupId).then(() => ctx.navigate('/groups'));
  });

  on(ctx.outlet, 'click', '[data-action="message"]', (ev, target) => {
    ev.preventDefault();
    const member = target.dataset.member;
    if (!member) return;
    void api.chat.openDirect(member).then(({ conversation }) => ctx.navigate(`/chat/${conversation.convId}`));
  });
}

export async function renderGroup(ctx: ViewContext) {
  unsubscribe?.();
  const groupId = ctx.params[0];
  render(ctx.outlet, spinner('Loading group'));

  const { group } = await api.groups.get(groupId);
  const [postPage, memberPage] = await Promise.all([
    api.groups.posts(groupId),
    api.groups.members(groupId).catch(() => ({ members: [] as GroupMember[] })),
  ]);
  posts = postPage.posts;
  members = memberPage.members;

  drawGroup(ctx, group);

  realtime.subscribe([topic.group(groupId)]);
  unsubscribe = realtime.on((event) => {
    if (event.type === 'post' && event.post.surfaceId === groupId) {
      if (posts.some((p) => p.postId === event.post.postId)) return;
      posts = [event.post, ...posts];
      render($('[data-role="posts"]', ctx.outlet), postsPanel());
    }

    // Presence arrives on the group topic, which is what keeps the member
    // list live without anyone polling it.
    if (event.type === 'presence') {
      const member = members.find((m) => m.actorId === event.actorId);
      if (!member) return;
      member.presence = event.presence;
      render($('[data-role="members"]', ctx.outlet), html`${members.map(memberRow)}`);
    }

    if (event.type === 'member_joined' || event.type === 'member_left') {
      void api.groups.members(groupId).then(({ members: fresh }) => {
        members = fresh;
        render($('[data-role="members"]', ctx.outlet), html`${members.map(memberRow)}`);
      });
    }
  });
}
