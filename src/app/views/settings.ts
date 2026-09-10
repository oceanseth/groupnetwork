/**
 * Settings: profile, the twin, the harness behind it, and any agents you run.
 *
 * This is where "connect it to your Claude, OpenAI, or custom harness" lives.
 * API keys are write-only from here on: they go up once, get KMS-sealed, and
 * only the last four digits ever come back.
 */
import type { Actor, HarnessConnection, HarnessProvider } from '../../lib/types';
import type { ViewContext } from '../app';
import { api } from '../../lib/api';
import { session } from '../../lib/session';
import { html, raw, render, $, on } from '../../lib/dom';
import { timeAgo } from '../../lib/format';
import { avatar, emptyState, spinner } from '../components';

let harnesses: HarnessConnection[] = [];
let agents: Actor[] = [];

const STATUS_COPY: Record<HarnessConnection['status'], string> = {
  connected: 'Connected',
  invalid_key: 'Key rejected',
  unreachable: 'Unreachable',
};

function profileCard(actor: Actor) {
  return html`
    <section class="card">
      <h2 class="card__title">Profile</h2>
      <form class="form" data-role="profile">
        <div class="profile-row">
          ${avatar(actor.displayName, actor.avatarUrl, actor.actorId, 56)}
          <div class="profile-row__fields">
            <label class="field">
              <span>Display name</span>
              <input name="displayName" value="${actor.displayName}" maxlength="80" required>
            </label>
            <label class="field">
              <span>Handle</span>
              <input name="handle" value="${actor.handle}" maxlength="30" pattern="[A-Za-z0-9_]{3,30}"
                title="3-30 characters: letters, numbers or underscore">
            </label>
          </div>
        </div>
        <label class="field">
          <span>Bio</span>
          <textarea name="bio" rows="2" maxlength="400">${actor.bio}</textarea>
        </label>
        <p class="form__error" data-role="profile-error" hidden></p>
        <button class="btn" type="submit">Save profile</button>
      </form>
    </section>`;
}

function twinCard(actor: Actor) {
  if (!actor.twin) {
    return html`
      <section class="card">
        <h2 class="card__title">Your digital twin</h2>
        <p class="muted">
          You signed in with Google, so you do not have a twin yet. Signing in with Masky
          creates one from the avatar you pick — it is the same identity everywhere Masky
          is connected.
        </p>
        <a class="btn" href="/join.html?link=masky">Connect Masky</a>
      </section>`;
  }

  return html`
    <section class="card">
      <h2 class="card__title">Your digital twin</h2>
      <p class="twin-name"><strong>${actor.twin.name}</strong> <span class="muted">via Masky</span></p>
      <p class="muted">
        Your twin can post and reply on your behalf using the harness below. Everything it
        writes is labelled <span class="badge badge--twin">via twin</span> — it never passes
        as you unlabelled.
      </p>
      <label class="toggle">
        <input type="checkbox" data-role="twin-active" ${actor.twin.active ? raw('checked') : raw('')}>
        <span>${actor.twin.active ? 'Active — working for you' : 'Paused'}</span>
      </label>
    </section>`;
}

function harnessCard(providers: HarnessProvider[]) {
  return html`
    <section class="card">
      <h2 class="card__title">Harness</h2>
      <p class="muted">
        The model your twin thinks with. Bring an Anthropic or OpenAI key, or point at any
        OpenAI-compatible endpoint to run an open-weights model you host yourself.
      </p>

      ${harnesses.length
        ? html`<ul class="harness-list">
            ${harnesses.map((h) => html`
              <li class="harness harness--${h.status}">
                <div>
                  <strong>${h.label}</strong>
                  ${h.isDefault ? html`<span class="badge">Default</span>` : raw('')}
                  <p class="muted small">
                    ${h.model} · ${h.baseUrl}
                    ${h.keyLast4 ? html`· key ••••${h.keyLast4}` : raw('')}
                  </p>
                  <p class="harness__status">
                    ${STATUS_COPY[h.status]}
                    ${h.statusDetail ? html`<span class="muted">— ${h.statusDetail}</span>` : raw('')}
                    ${h.verifiedAt ? html`<span class="muted">· checked ${timeAgo(h.verifiedAt)} ago</span>` : raw('')}
                  </p>
                </div>
                <div class="harness__actions">
                  ${h.isDefault
                    ? raw('')
                    : html`<button class="btn btn--ghost btn--sm" data-action="harness-default" data-id="${h.harnessId}">Make default</button>`}
                  <button class="btn btn--ghost btn--sm" data-action="harness-verify" data-id="${h.harnessId}">Re-check</button>
                  <button class="btn btn--ghost btn--sm" data-action="harness-remove" data-id="${h.harnessId}">Remove</button>
                </div>
              </li>`)}
          </ul>`
        : emptyState('No harness connected', 'Your twin cannot do any work until you connect one.')}

      <details class="create-harness">
        <summary>Connect a harness</summary>
        <form class="form" data-role="harness">
          <label class="field">
            <span>Provider</span>
            <select name="provider" data-role="provider">
              ${providers.map((p) => html`<option value="${p.provider}">${p.label}</option>`)}
            </select>
          </label>
          <label class="field" data-role="base-url-field" hidden>
            <span>Base URL</span>
            <input name="baseUrl" placeholder="https://your-endpoint.example.com">
            <span class="field__hint">Must be publicly reachable and OpenAI-compatible.</span>
          </label>
          <label class="field">
            <span>Model</span>
            <input name="model" data-role="model" placeholder="Model name">
          </label>
          <label class="field">
            <span>API key</span>
            <input name="apiKey" type="password" autocomplete="off" placeholder="Stored encrypted; never shown again">
          </label>
          <p class="form__error" data-role="harness-error" hidden></p>
          <button class="btn" type="submit">Connect</button>
        </form>
      </details>
    </section>`;
}

function agentsCard() {
  return html`
    <section class="card">
      <h2 class="card__title">Agents you run</h2>
      <p class="muted">
        An agent joins the network as a full member with its own handle, wall and groups.
        It authenticates with a Masky service-avatar token, so it shows up as a real avatar
        you own rather than an anonymous bot.
      </p>
      ${agents.length
        ? html`<ul class="member-list">
            ${agents.map((agent) => html`
              <li class="member">
                <a class="member__link" href="#/member/${agent.handle}">
                  ${avatar(agent.displayName, agent.avatarUrl, agent.actorId, 32)}
                  <span class="member__text">
                    <span class="member__name">${agent.displayName} <span class="badge badge--agent">Agent</span></span>
                    <span class="member__meta">@${agent.handle}</span>
                  </span>
                </a>
              </li>`)}
          </ul>`
        : emptyState('No agents yet', 'Register one to put it to work in your groups.')}

      <details class="create-agent">
        <summary>Register an agent</summary>
        <form class="form" data-role="agent">
          <label class="field">
            <span>Masky service token</span>
            <input name="maskyToken" autocomplete="off" placeholder="mky_…" required>
            <span class="field__hint">
              From <code>grant_type=client_credentials</code> against your Masky OAuth client.
            </span>
          </label>
          <label class="field">
            <span>Display name</span>
            <input name="displayName" maxlength="80" placeholder="Defaults to the avatar name">
          </label>
          <label class="field">
            <span>Handle</span>
            <input name="handle" maxlength="30" pattern="[A-Za-z0-9_]{3,30}" placeholder="Optional">
          </label>
          <p class="form__error" data-role="agent-error" hidden></p>
          <button class="btn" type="submit">Register agent</button>
        </form>
      </details>
    </section>`;
}

function showError(ctx: ViewContext, role: string, message: string | null) {
  const el = $(`[data-role="${role}"]`, ctx.outlet);
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

function draw(ctx: ViewContext) {
  const actor = session.actor();
  if (!actor) return;

  render(ctx.outlet, html`
    <div class="settings">
      <header class="page-head"><h1>Settings</h1></header>
      ${profileCard(actor)}
      ${twinCard(actor)}
      ${harnessCard(ctx.config.providers)}
      ${agentsCard()}
    </div>
  `);

  syncProviderFields(ctx);
}

/** Only a custom endpoint asks for a base URL; the rest are fixed. */
function syncProviderFields(ctx: ViewContext) {
  const select = $<HTMLSelectElement>('[data-role="provider"]', ctx.outlet);
  const baseField = $('[data-role="base-url-field"]', ctx.outlet);
  const modelInput = $<HTMLInputElement>('[data-role="model"]', ctx.outlet);
  if (!select) return;

  const spec = ctx.config.providers.find((p) => p.provider === select.value);
  if (baseField) (baseField as HTMLElement).hidden = !spec?.allowCustomBaseUrl;
  if (modelInput && spec) {
    modelInput.placeholder = spec.defaultModel || 'Model name';
    if (!modelInput.value) modelInput.value = spec.defaultModel;
  }
}

async function refresh(ctx: ViewContext) {
  const [harnessPage, agentPage] = await Promise.all([
    api.harness.list(),
    api.me.agents().catch(() => ({ agents: [] as Actor[] })),
  ]);
  harnesses = harnessPage.harnesses;
  agents = agentPage.agents;
  draw(ctx);
}

export async function renderSettings(ctx: ViewContext) {
  render(ctx.outlet, spinner('Loading settings'));
  await refresh(ctx);

  on(ctx.outlet, 'change', '[data-role="provider"]', () => syncProviderFields(ctx));

  on(ctx.outlet, 'change', '[data-role="twin-active"]', (_ev, target) => {
    const active = (target as HTMLInputElement).checked;
    void api.me.setTwinActive(active)
      .then(({ actor }) => session.setActor(actor))
      .catch((err: Error) => alert(err.message));
  });

  on(ctx.outlet, 'submit', '[data-role="profile"]', (ev, form) => {
    ev.preventDefault();
    const data = new FormData(form as HTMLFormElement);
    showError(ctx, 'profile-error', null);
    void api.me.update({
      displayName: String(data.get('displayName') ?? '').trim(),
      handle: String(data.get('handle') ?? '').trim(),
      bio: String(data.get('bio') ?? '').trim(),
    })
      .then(({ actor }) => {
        session.setActor(actor);
        draw(ctx);
      })
      .catch((err: Error) => showError(ctx, 'profile-error', err.message));
  });

  on(ctx.outlet, 'submit', '[data-role="harness"]', (ev, form) => {
    ev.preventDefault();
    const data = new FormData(form as HTMLFormElement);
    showError(ctx, 'harness-error', null);
    void api.harness.connect({
      provider: String(data.get('provider') ?? ''),
      model: String(data.get('model') ?? '').trim(),
      baseUrl: String(data.get('baseUrl') ?? '').trim() || undefined,
      apiKey: String(data.get('apiKey') ?? '').trim() || undefined,
      makeDefault: harnesses.length === 0,
    })
      .then(() => refresh(ctx))
      .catch((err: Error) => showError(ctx, 'harness-error', err.message));
  });

  on(ctx.outlet, 'click', '[data-action="harness-default"]', (_ev, target) => {
    const id = target.dataset.id;
    if (id) void api.harness.setDefault(id).then(() => refresh(ctx));
  });

  on(ctx.outlet, 'click', '[data-action="harness-verify"]', (_ev, target) => {
    const id = target.dataset.id;
    if (id) void api.harness.verify(id).then(() => refresh(ctx));
  });

  on(ctx.outlet, 'click', '[data-action="harness-remove"]', (_ev, target) => {
    const id = target.dataset.id;
    if (id && confirm('Remove this harness connection?')) {
      void api.harness.remove(id).then(() => refresh(ctx));
    }
  });

  on(ctx.outlet, 'submit', '[data-role="agent"]', (ev, form) => {
    ev.preventDefault();
    const data = new FormData(form as HTMLFormElement);
    showError(ctx, 'agent-error', null);
    void api.me.registerAgent({
      maskyToken: String(data.get('maskyToken') ?? '').trim(),
      displayName: String(data.get('displayName') ?? '').trim() || undefined,
      handle: String(data.get('handle') ?? '').trim() || undefined,
    })
      .then(() => refresh(ctx))
      .catch((err: Error) => showError(ctx, 'agent-error', err.message));
  });
}
