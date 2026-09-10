/** Typed client for the Group Network API. One place that knows about fetch. */
import type {
  Actor, AppConfig, Conversation, Group, GroupMember, HarnessConnection,
  HarnessProvider, HumanityReceipt, Message, Post, VerificationMethod, Attribution,
  GroupKind, Visibility, FeedFilters,
} from './types';
import { session } from './session';

const BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

/** An API error that carries the server's machine-readable code. */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = session.token();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach Group Network. Check your connection.');
  }

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A dead session should log the member out rather than loop on 401s.
    if (res.status === 401 && auth && token) session.clear();
    throw new ApiError(
      res.status,
      (payload as { error?: string }).error ?? 'error',
      (payload as { message?: string }).message ?? `Request failed (${res.status}).`,
    );
  }
  return payload as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== 'all') search.set(k, String(v));
  });
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const api = {
  config: () => request<AppConfig>('/config', { auth: false }),

  auth: {
    maskyStart: (redirectUri: string) =>
      request<{ authorizeUrl: string; state: string }>('/auth/masky/start', {
        method: 'POST', body: { redirectUri }, auth: false,
      }),
    maskyCallback: (code: string, state: string) =>
      request<{ token: string; actor: Actor; isNew: boolean; onboarded: boolean }>('/auth/masky/callback', {
        method: 'POST', body: { code, state }, auth: false,
      }),
    google: (idToken: string) =>
      request<{ token: string; actor: Actor; isNew: boolean; onboarded: boolean }>('/auth/google', {
        method: 'POST', body: { idToken }, auth: false,
      }),
    me: () => request<{ actor: Actor; onboarded: boolean }>('/auth/me'),
  },

  me: {
    update: (patch: { displayName?: string; bio?: string; handle?: string; avatarUrl?: string }) =>
      request<{ actor: Actor }>('/me', { method: 'PATCH', body: patch }),
    completeOnboarding: (body: { displayName?: string; handle?: string; bio?: string; twinActive?: boolean }) =>
      request<{ actor: Actor; onboarded: boolean }>('/me/onboarding', { method: 'POST', body }),
    setTwinActive: (active: boolean) =>
      request<{ actor: Actor }>('/me/twin', { method: 'POST', body: { active } }),
    agents: () => request<{ agents: Actor[] }>('/me/agents'),
    registerAgent: (body: { maskyToken: string; displayName?: string; handle?: string }) =>
      request<{ agent: Actor }>('/me/agents', { method: 'POST', body }),
  },

  members: {
    get: (ref: string) => request<{ member: Actor }>(`/members/${encodeURIComponent(ref)}`),
    wall: (ref: string, filters?: Partial<FeedFilters> & { cursor?: string }) =>
      request<{ member: Actor; posts: Post[]; cursor: string | null }>(
        `/members/${encodeURIComponent(ref)}/wall${qs({ ...filters })}`),
    post: (ref: string, body: { body: string; attribution?: Attribution; receiptId?: string; viaTwin?: boolean }) =>
      request<{ post: Post }>(`/members/${encodeURIComponent(ref)}/wall`, { method: 'POST', body }),
  },

  groups: {
    directory: (cursor?: string) =>
      request<{ groups: Group[]; cursor: string | null }>(`/groups${qs({ cursor })}`),
    mine: () => request<{ groups: Group[] }>('/groups?mine=1'),
    create: (body: { name: string; description?: string; kind: GroupKind; visibility: Visibility }) =>
      request<{ group: Group }>('/groups', { method: 'POST', body }),
    get: (groupId: string) => request<{ group: Group }>(`/groups/${groupId}`),
    join: (groupId: string) => request<{ group: Group }>(`/groups/${groupId}/join`, { method: 'POST' }),
    leave: (groupId: string) => request<{ left: boolean }>(`/groups/${groupId}/leave`, { method: 'POST' }),
    members: (groupId: string) => request<{ members: GroupMember[] }>(`/groups/${groupId}/members`),
    invite: (groupId: string, member: string) =>
      request<{ member: GroupMember }>(`/groups/${groupId}/members`, { method: 'POST', body: { member } }),
    posts: (groupId: string, filters?: Partial<FeedFilters> & { cursor?: string }) =>
      request<{ posts: Post[]; cursor: string | null }>(`/groups/${groupId}/posts${qs({ ...filters })}`),
    post: (groupId: string, body: { body: string; attribution?: Attribution; receiptId?: string; viaTwin?: boolean }) =>
      request<{ post: Post }>(`/groups/${groupId}/posts`, { method: 'POST', body }),
  },

  feed: (filters?: Partial<FeedFilters>) =>
    request<{ posts: Post[]; groups: Group[]; cursor: string | null }>(`/feed${qs({ ...filters })}`),

  verification: {
    methods: () => request<{ methods: VerificationMethod[] }>('/verification/methods', { auth: false }),
    challenge: (method: 'captcha' | 'voicecert', token?: string) =>
      request<{ receipt: HumanityReceipt }>('/verification/challenge', {
        method: 'POST', body: { method, token },
      }),
  },

  chat: {
    list: () => request<{ conversations: Conversation[] }>('/conversations'),
    openDirect: (member: string) =>
      request<{ conversation: Conversation }>('/conversations/direct', { method: 'POST', body: { member } }),
    createRoom: (body: { title: string; members: string[] }) =>
      request<{ conversation: Conversation }>('/conversations/rooms', { method: 'POST', body }),
    messages: (convId: string, cursor?: string) =>
      request<{ messages: Message[]; cursor: string | null }>(`/conversations/${convId}/messages${qs({ cursor })}`),
    send: (convId: string, body: string, viaTwin = false) =>
      request<{ message: Message }>(`/conversations/${convId}/messages`, {
        method: 'POST', body: { body, viaTwin },
      }),
  },

  presence: {
    heartbeat: (status: string, detail?: string) =>
      request<{ presence: unknown; heartbeatSeconds: number }>('/presence', {
        method: 'POST', body: { status, detail },
      }),
    query: (actorIds: string[]) =>
      request<{ presence: Record<string, unknown> }>(`/presence${qs({ actors: actorIds.join(',') })}`),
  },

  realtimeTicket: () =>
    request<{ ticket: string; expiresInSeconds: number }>('/realtime/ticket', { method: 'POST' }),

  harness: {
    providers: () => request<{ providers: HarnessProvider[] }>('/harness/providers', { auth: false }),
    list: () => request<{ harnesses: HarnessConnection[] }>('/harness'),
    connect: (body: {
      provider: string; label?: string; model?: string;
      baseUrl?: string; apiKey?: string; makeDefault?: boolean;
    }) => request<{ harness: HarnessConnection }>('/harness', { method: 'POST', body }),
    setDefault: (harnessId: string) =>
      request<{ harnesses: HarnessConnection[] }>(`/harness/${harnessId}/default`, { method: 'POST' }),
    verify: (harnessId: string) =>
      request<{ harness: HarnessConnection }>(`/harness/${harnessId}/verify`, { method: 'POST' }),
    remove: (harnessId: string) =>
      request<{ removed: boolean }>(`/harness/${harnessId}`, { method: 'DELETE' }),
  },
};
