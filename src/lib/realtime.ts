/**
 * Realtime client.
 *
 * Connects with a single-use ticket (a browser cannot set headers on a
 * WebSocket handshake, and putting the session token in the query string would
 * write it into access logs). Re-subscribes to its topics on every reconnect,
 * so a dropped connection heals without the views knowing it happened.
 */
import type { SocketEvent } from './types';
import { api } from './api';

const WS_URL = import.meta.env.VITE_WS_URL ?? '';
const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

type Handler = (event: SocketEvent) => void;

class Realtime {
  private socket: WebSocket | null = null;
  private topics = new Set<string>();
  private handlers = new Set<Handler>();
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private closedByUs = false;
  private status: 'offline' | 'connecting' | 'online' = 'offline';

  /** True when realtime is configured at all; false in a bare local dev setup. */
  get enabled() {
    return Boolean(WS_URL);
  }

  get connectionStatus() {
    return this.status;
  }

  async connect() {
    if (!this.enabled || this.socket) return;
    this.closedByUs = false;
    this.status = 'connecting';

    let ticket: string;
    try {
      ticket = (await api.realtimeTicket()).ticket;
    } catch {
      // No ticket means no session, or the API is down. Back off and retry;
      // the app stays usable over plain HTTP in the meantime.
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.status = 'online';
      this.attempt = 0;
      if (this.topics.size) this.send({ action: 'subscribe', topics: [...this.topics] });
      this.startHeartbeat();
    });

    socket.addEventListener('message', (ev) => {
      let payload: SocketEvent;
      try {
        payload = JSON.parse(ev.data as string) as SocketEvent;
      } catch {
        return;
      }
      this.handlers.forEach((fn) => fn(payload));
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.status = 'offline';
      this.stopHeartbeat();
      if (!this.closedByUs) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
  }

  disconnect() {
    this.closedByUs = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.status = 'offline';
  }

  /** Topics are remembered so a reconnect restores them without caller help. */
  subscribe(topics: string[]) {
    const added = topics.filter((t) => !this.topics.has(t));
    topics.forEach((t) => this.topics.add(t));
    if (added.length) this.send({ action: 'subscribe', topics: added });
  }

  unsubscribe(topics: string[]) {
    topics.forEach((t) => this.topics.delete(t));
    this.send({ action: 'unsubscribe', topics });
  }

  /** Send a chat message over the socket, falling back to HTTP when offline. */
  async sendMessage(convId: string, body: string, viaTwin = false) {
    if (this.status === 'online' && this.send({ action: 'message', convId, body, viaTwin })) return;
    await api.chat.send(convId, body, viaTwin);
  }

  setStatus(status: 'online' | 'away' | 'busy', detail?: string) {
    this.send({ action: 'heartbeat', status, detail });
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      // Presence is a lease; missing heartbeats is what makes it lapse.
      this.send({ action: 'heartbeat', status: document.hidden ? 'away' : 'online' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUs) return;
    // Exponential backoff with jitter, so a brief outage does not turn into a
    // synchronised stampede when every client retries at once.
    const base = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

export const realtime = new Realtime();

/** Topic names, kept in step with api/src/lib/keys.js. */
export const topic = {
  group: (groupId: string) => `group:${groupId}`,
  wall: (actorId: string) => `wall:${actorId}`,
  conversation: (convId: string) => `conv:${convId}`,
  presence: (actorId: string) => `presence:${actorId}`,
};
