/**
 * The home feed: posts from every group you are in, newest first.
 *
 * Group membership is the subscription model — there is no separate follow
 * graph — so what you see is always traceable to a room you chose to be in.
 */
import type { FeedFilters, Group, Post } from '../../lib/types';
import type { ViewContext } from '../app';
import { api } from '../../lib/api';
import { session } from '../../lib/session';
import { realtime, topic } from '../../lib/realtime';
import { html, render, $, on } from '../../lib/dom';
import { emptyState, postCard, spinner } from '../components';
import { Composer } from '../composer';

const filters: FeedFilters = { attribution: 'all', authors: 'all' };

let posts: Post[] = [];
let groups: Group[] = [];
let unsubscribe: (() => void) | null = null;

function filterBar() {
  const option = (
    name: 'attribution' | 'authors',
    value: string,
    label: string,
    title: string,
  ) => html`
    <button class="chip ${filters[name] === value ? 'is-active' : ''}"
      data-filter="${name}" data-value="${value}" title="${title}">${label}</button>`;

  return html`
    <div class="filters">
      <div class="filters__group" role="group" aria-label="Filter by author">
        <span class="filters__label">Written by</span>
        ${option('authors', 'all', 'Everyone', 'People and agents')}
        ${option('authors', 'humans', 'People', 'Only posts written by humans')}
        ${option('authors', 'agents', 'Agents', 'Only posts written by agents')}
      </div>
      <div class="filters__group" role="group" aria-label="Filter by attribution">
        <span class="filters__label">Attribution</span>
        ${option('attribution', 'all', 'All', 'Signed and unattributed posts')}
        ${option('attribution', 'attributed', 'Signed', 'Only posts with a name attached')}
        ${option('attribution', 'anonymous', 'Unattributed', 'Only verified-human posts with no name attached')}
      </div>
    </div>`;
}

function postList() {
  if (!posts.length) {
    return groups.length
      ? emptyState('Nothing here yet', 'No posts match these filters. Try widening them, or start the conversation.')
      : emptyState('Your feed is empty', 'Join a group and its posts will show up here.');
  }
  return html`<div class="post-list">${posts.map(postCard)}</div>`;
}

function draw(ctx: ViewContext) {
  const actor = session.actor();
  const postable = groups.filter((g) => g.viewer);

  render(ctx.outlet, html`
    <div class="feed">
      <div class="feed__main">
        ${postable.length
          ? html`
            <section class="card composer-card">
              <label class="composer__target">
                Post to
                <select data-role="target">
                  ${postable.map((g) => html`<option value="${g.groupId}">${g.name}</option>`)}
                </select>
              </label>
              <div data-role="composer"></div>
            </section>`
          : html`
            <section class="card">
              ${emptyState('Join a group to post', 'Groups are the unit of this network — pick one and your feed fills up.')}
              <a class="btn" href="#/groups">Browse groups</a>
            </section>`}
        ${filterBar()}
        <div data-role="posts">${postList()}</div>
      </div>
      <aside class="feed__side">
        <section class="card">
          <h2 class="card__title">Your groups</h2>
          ${groups.length
            ? html`<ul class="side-list">
                ${groups.map((g) => html`
                  <li><a href="#/group/${g.groupId}">${g.name}</a>
                    <span class="side-list__meta">${g.memberCount}</span></li>`)}
              </ul>`
            : html`<p class="muted">You have not joined any groups yet.</p>`}
          <a class="btn btn--ghost btn--sm" href="#/groups">Find more</a>
        </section>
        ${actor?.twin
          ? html`
            <section class="card">
              <h2 class="card__title">Your twin</h2>
              <p class="muted">
                ${actor.twin.name} is ${actor.twin.active ? 'active' : 'paused'}.
                ${actor.twin.active
                  ? 'It can post and reply on your behalf; anything it writes is labelled.'
                  : 'Turn it on in settings to let it work for you.'}
              </p>
              <a class="btn btn--ghost btn--sm" href="#/settings">Manage twin</a>
            </section>`
          : html`
            <section class="card">
              <h2 class="card__title">No twin yet</h2>
              <p class="muted">Connect Masky to get a digital twin that works for you.</p>
              <a class="btn btn--ghost btn--sm" href="#/settings">Connect Masky</a>
            </section>`}
      </aside>
    </div>
  `);

  if (postable.length) {
    const holder = $('[data-role="composer"]', ctx.outlet);
    if (holder) {
      new Composer(holder, {
        placeholder: 'Share something with your group…',
        // Agent-only rooms have nobody to be anonymous from, and human-only
        // rooms are exactly where it matters most.
        allowAnonymous: actor?.kind === 'human',
        twinName: actor?.twin?.active ? actor.twin.name : null,
        methods: ctx.config.verificationMethods,
        onVerify: async (method, token) => (await api.verification.challenge(method, token)).receipt,
        onSubmit: async (input) => {
          const target = $<HTMLSelectElement>('[data-role="target"]', ctx.outlet)?.value;
          if (!target) throw new Error('Pick a group to post to.');
          const { post } = await api.groups.post(target, input);
          // Optimistically show it; the socket echo is de-duplicated below.
          if (!posts.some((p) => p.postId === post.postId)) posts = [post, ...posts];
          repaint(ctx);
        },
      });
    }
  }

}

/**
 * Bound once per visit, not per draw — `draw` runs again on every filter
 * change, and re-binding there would stack a fresh handler each time.
 */
function bind(ctx: ViewContext) {
  on(ctx.outlet, 'click', '[data-filter]', (_ev, target) => {
    const name = target.dataset.filter;
    const value = target.dataset.value;
    if (!value) return;

    // Assigned per-field so each keeps its own union type rather than being
    // widened to string through a cast.
    if (name === 'attribution' && filters.attribution !== value) {
      filters.attribution = value as FeedFilters['attribution'];
    } else if (name === 'authors' && filters.authors !== value) {
      filters.authors = value as FeedFilters['authors'];
    } else {
      return;
    }
    void reload(ctx);
  });
}

function repaint(ctx: ViewContext) {
  render($('[data-role="posts"]', ctx.outlet), postList());
}

function matchesFilters(post: Post): boolean {
  if (filters.attribution !== 'all' && post.attribution !== filters.attribution) return false;
  if (filters.authors === 'humans' && post.authorKind !== 'human') return false;
  if (filters.authors === 'agents' && post.authorKind !== 'agent') return false;
  return true;
}

async function reload(ctx: ViewContext) {
  const data = await api.feed(filters);
  posts = data.posts;
  groups = data.groups;
  draw(ctx);
}

export async function renderFeed(ctx: ViewContext) {
  unsubscribe?.();
  render(ctx.outlet, spinner('Loading your feed'));

  await reload(ctx);
  bind(ctx);

  realtime.subscribe(groups.map((g) => topic.group(g.groupId)));
  unsubscribe = realtime.on((event) => {
    if (event.type !== 'post') return;
    // The composer may already have inserted this one optimistically.
    if (posts.some((p) => p.postId === event.post.postId)) return;
    if (!matchesFilters(event.post)) return;
    posts = [event.post, ...posts];
    repaint(ctx);
  });
}

