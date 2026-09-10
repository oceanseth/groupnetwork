/**
 * Messages.
 *
 * Sends go over the socket when it is up and fall back to HTTP when it is not;
 * either way the message everyone renders arrives from the same stream fan-out,
 * so there is no second code path that could drift.
 */
import type { Conversation, Message } from '../../lib/types';
import type { ViewContext } from '../app';
import { api } from '../../lib/api';
import { session } from '../../lib/session';
import { realtime, topic } from '../../lib/realtime';
import { html, raw, render, $, on, formatBody } from '../../lib/dom';
import { clockTime, timeAgo } from '../../lib/format';
import { avatar, emptyState, spinner } from '../components';

let conversations: Conversation[] = [];
let messages: Message[] = [];
let activeId: string | null = null;
let unsubscribe: (() => void) | null = null;

/** The other side of a DM; for a room, everyone but you. */
function counterparts(conv: Conversation) {
  const me = session.actor()?.actorId;
  return conv.participants.filter((p) => p.actorId !== me);
}

function conversationTitle(conv: Conversation) {
  if (conv.title) return conv.title;
  const others = counterparts(conv);
  if (!others.length) return 'Just you';
  return others.map((p) => p.displayName).join(', ');
}

function conversationList() {
  if (!conversations.length) {
    return emptyState('No conversations', 'Message someone from their profile or a group member list.');
  }
  return html`
    <ul class="conv-list">
      ${conversations.map((conv) => {
        const other = counterparts(conv)[0];
        return html`
          <li class="conv ${conv.convId === activeId ? 'is-active' : ''}">
            <a href="#/chat/${conv.convId}">
              ${avatar(conversationTitle(conv), other?.avatarUrl ?? null, other?.actorId ?? conv.convId, 36)}
              <span class="conv__text">
                <span class="conv__title">
                  ${conversationTitle(conv)}
                  ${other?.kind === 'agent' ? html`<span class="badge badge--agent">Agent</span>` : raw('')}
                </span>
                <span class="conv__preview">${conv.lastMessagePreview ?? 'No messages yet'}</span>
              </span>
              <span class="conv__time">${timeAgo(conv.lastMessageAt)}</span>
            </a>
          </li>`;
      })}
    </ul>`;
}

function messageList() {
  const me = session.actor()?.actorId;
  if (!messages.length) {
    return emptyState('No messages yet', 'Say hello.');
  }
  return html`
    <div class="messages">
      ${messages.map((msg) => html`
        <div class="msg ${msg.sender.actorId === me ? 'msg--mine' : ''}" data-message-id="${msg.messageId}">
          ${msg.sender.actorId === me
            ? raw('')
            : avatar(msg.sender.displayName, msg.sender.avatarUrl, msg.sender.actorId, 28)}
          <div class="msg__bubble">
            <div class="msg__meta">
              <span class="msg__sender">${msg.sender.displayName}</span>
              ${msg.sender.kind === 'agent' ? html`<span class="badge badge--agent">Agent</span>` : raw('')}
              ${msg.viaTwin ? html`<span class="badge badge--twin">via twin</span>` : raw('')}
              <time>${clockTime(msg.createdAt)}</time>
            </div>
            <div class="msg__body">${formatBody(msg.body)}</div>
          </div>
        </div>`)}
    </div>`;
}

function scrollToLatest(ctx: ViewContext) {
  const pane = $('[data-role="messages"]', ctx.outlet);
  if (pane) pane.scrollTop = pane.scrollHeight;
}

function draw(ctx: ViewContext) {
  const active = conversations.find((c) => c.convId === activeId) ?? null;

  render(ctx.outlet, html`
    <div class="chat">
      <aside class="chat__side card">
        <h2 class="card__title">Messages</h2>
        ${conversationList()}
      </aside>
      <section class="chat__main card">
        ${active
          ? html`
            <header class="chat__head">
              <h2>${conversationTitle(active)}</h2>
              <p class="muted small">
                ${active.participants.length} participant${active.participants.length === 1 ? '' : 's'}
                ${counterparts(active).some((p) => p.kind === 'agent') ? '· includes an agent' : ''}
              </p>
            </header>
            <div class="chat__scroll" data-role="messages">${messageList()}</div>
            <form class="chat__composer" data-role="send">
              <input name="body" autocomplete="off" placeholder="Write a message…" maxlength="4000" required>
              <button class="btn" type="submit">Send</button>
            </form>`
          : emptyState('Pick a conversation', 'Choose one on the left, or start a new one from a member’s profile.')}
      </section>
    </div>
  `);

  if (active) scrollToLatest(ctx);

  on(ctx.outlet, 'submit', '[data-role="send"]', (ev, form) => {
    ev.preventDefault();
    if (!activeId) return;
    const input = (form as HTMLFormElement).elements.namedItem('body') as HTMLInputElement | null;
    const body = input?.value.trim();
    if (!body) return;
    if (input) input.value = '';
    void realtime.sendMessage(activeId, body).catch((err: Error) => alert(err.message));
  });
}

export async function renderChat(ctx: ViewContext) {
  unsubscribe?.();
  render(ctx.outlet, spinner('Loading messages'));

  conversations = (await api.chat.list()).conversations;
  activeId = ctx.params[0] ?? conversations[0]?.convId ?? null;
  messages = activeId ? (await api.chat.messages(activeId)).messages : [];

  draw(ctx);

  if (activeId) realtime.subscribe([topic.conversation(activeId)]);

  unsubscribe = realtime.on((event) => {
    if (event.type !== 'message') return;
    const msg = event.message;

    if (msg.convId === activeId) {
      // The sender receives its own message through the fan-out too, so this
      // guard is what keeps a sent message from appearing twice.
      if (messages.some((m) => m.messageId === msg.messageId)) return;
      messages = [...messages, msg];
      render($('[data-role="messages"]', ctx.outlet), messageList());
      scrollToLatest(ctx);
    }

    // Keep the sidebar preview honest even for conversations not open.
    const conv = conversations.find((c) => c.convId === msg.convId);
    if (conv) {
      conv.lastMessageAt = msg.createdAt;
      conv.lastMessagePreview = msg.body.slice(0, 140);
      conversations = [...conversations].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      render($('.chat__side', ctx.outlet), html`<h2 class="card__title">Messages</h2>${conversationList()}`);
    }
  });
}
