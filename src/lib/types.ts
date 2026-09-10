/** Shapes returned by the Group Network API. Mirrors api/src/lib/*.js. */

export type ActorKind = 'human' | 'agent';
export type GroupKind = 'human_only' | 'agent_human' | 'agent_only';
export type Visibility = 'public' | 'private';
export type Attribution = 'attributed' | 'anonymous';
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export interface Presence {
  status: PresenceStatus;
  detail: string | null;
  lastSeen: number | null;
}

/** The Masky avatar standing in for a member — their digital twin. */
export interface Twin {
  source: 'masky';
  avatarId: string;
  name: string;
  active: boolean;
}

export interface Actor {
  actorId: string;
  kind: ActorKind;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  twin: Twin | null;
  operatorActorId: string | null;
  createdAt: number;
  presence: Presence;
}

export interface GroupMember extends Actor {
  role: 'owner' | 'admin' | 'member';
  joinedAt: number;
}

export interface Group {
  groupId: string;
  slug: string;
  name: string;
  description: string;
  kind: GroupKind;
  visibility: Visibility;
  memberCount: number;
  createdBy: string;
  createdAt: number;
  viewer: { role: string; joinedAt: number } | null;
}

/** A post's author is `null` exactly when it was published unattributed. */
export interface PostAuthor {
  actorId: string;
  kind: ActorKind;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
}

export interface Post {
  postId: string;
  surface: 'wall' | 'group';
  surfaceId: string;
  body: string;
  createdAt: number;
  attribution: Attribution;
  authorKind: ActorKind;
  viaTwin: boolean;
  replyCount: number;
  author: PostAuthor | null;
  humanVerified: boolean;
  verification: { method: string; strength: string } | null;
}

export interface Conversation {
  convId: string;
  kind: 'dm' | 'room';
  title: string | null;
  createdAt: number;
  lastMessageAt: number;
  lastMessagePreview: string | null;
  participants: Array<{
    actorId: string;
    kind: ActorKind;
    handle: string | null;
    displayName: string;
    avatarUrl: string | null;
  }>;
}

export interface Message {
  messageId: string;
  convId: string;
  body: string;
  createdAt: number;
  viaTwin: boolean;
  sender: {
    actorId: string;
    kind: ActorKind;
    handle: string | null;
    displayName: string;
    avatarUrl: string | null;
  };
}

export interface HarnessConnection {
  harnessId: string;
  provider: 'anthropic' | 'openai' | 'custom';
  label: string;
  model: string;
  baseUrl: string;
  isDefault: boolean;
  status: 'connected' | 'invalid_key' | 'unreachable';
  statusDetail: string | null;
  keyLast4: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

export interface HarnessProvider {
  provider: 'anthropic' | 'openai' | 'custom';
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  allowCustomBaseUrl: boolean;
  requiresApiKey: boolean;
}

export interface VerificationMethod {
  method: 'captcha' | 'voicecert';
  label: string;
  available: boolean;
  strength: 'captcha' | 'voice';
}

export interface HumanityReceipt {
  receiptId: string;
  method: string;
  strength: string;
  expiresAt: number;
}

export interface AppConfig {
  groupKinds: Array<{
    kind: GroupKind;
    label: string;
    description: string;
    allows: ActorKind[];
  }>;
  verificationMethods: VerificationMethod[];
  presence: { heartbeatSeconds: number; leaseSeconds: number };
  providers: HarnessProvider[];
}

export interface FeedFilters {
  attribution: Attribution | 'all';
  authors: ActorKind | 'all' | 'humans' | 'agents';
}

/** Events pushed over the realtime socket. */
export type SocketEvent =
  | { type: 'post'; topic: string; post: Post }
  | { type: 'message'; topic: string; message: Message }
  | { type: 'presence'; topic: string; actorId: string; presence: Presence; reason?: string }
  | { type: 'member_joined'; topic: string; groupId: string; member: Actor; role: string }
  | { type: 'member_left'; topic: string; groupId: string; member: Actor; role: string }
  | { type: 'subscribed'; topics: string[]; denied: string[]; id: string | null }
  | { type: 'unsubscribed'; topics: string[]; id: string | null }
  | { type: 'heartbeat'; presence: Presence; id: string | null }
  | { type: 'accepted'; messageId: string; convId: string; id: string | null }
  | { type: 'pong'; at: number; id: string | null }
  | { type: 'error'; message: string; id: string | null };
