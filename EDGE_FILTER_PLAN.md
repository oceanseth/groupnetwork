# Plan: Post Once, Deliver Everywhere — the Edge Filter

Status: **draft for discussion** · Author: Claude-Fable (with Seth) · Created: 2026-11-02

The one-line version of the vision, in Seth's words: Group Network becomes an
**edge-optimized algorithmic filter on reality** — users get the version of content
specifically tailored to their understanding of it. Seth stops posting to
Facebook/Instagram/X directly; he posts *here*, and agents deliver custom versions of the
content to all those surfaces — plus a version people can read directly on their own
Group Network node when their own agent evaluates it as highly relevant.

This file turns that into phases that build on what the repo already has. For the current
system, read [README](README.md) and [ARCHITECTURE](ARCHITECTURE.md); nothing below
invents a new member type — everything is actors, groups, posts, and twins.

---

## The two halves

The vision is really two products that share one primitive, the **canonical post**:

1. **Outbound syndication (push).** One canonical post fans out to external surfaces
   (FB/IG/X/YouTube/...) as *derivations* — per-surface rewrites produced by agents and
   approved by the author. Group Network is the source of truth; the platforms become
   distribution endpoints.

2. **Inbound relevance (pull / the edge filter).** Every member's twin evaluates each
   canonical post *for that member* — scoring relevance and, when it clears the bar,
   rendering the member's own tailored version (their reading level, language, context,
   interests). The feed stops being one algorithm for everyone; it's your agent, working
   for you, at the edge.

Half 2 is the moat. Half 1 is the wedge that makes posting here rational today.

## Why the existing architecture already wants this

- **Posts are already actor-agnostic rows** (`WALL#<actor>` / `GROUP#<id>`); a canonical
  post is just a post with derivations hanging off it.
- **Twins already exist and bring their own brain** (`TWIN` / `HARNESS#<id>` rows,
  `api/src/lib/harness.js`). The edge filter is a new *job* for the twin, not a new system.
- **Agents are first-class actors with an accountable operator** — a syndication worker is
  just an `agent` actor that a human registered, same as everything else.
- **Everything a twin writes is labelled `via twin`** — the same honesty rule extends to
  derivations: a tailored version is always labelled as a derivation of the canonical, one
  tap from the original.

## Data model sketch (keys.js style)

| Entity | pk | sk | notes |
|---|---|---|---|
| Canonical post | `WALL#<actor>` / `GROUP#<id>` | `POST#<invTs>#<id>` | unchanged; add `canonical: true` |
| Derivation | `POST#<id>` | `DERIV#<surface>#<variant>` | body, status (`draft/approved/posted/failed`), external URL + id once posted, producing agent, approver |
| Relevance verdict | `POST#<id>` | `REL#<actorId>` | score 0–1, reasons, model/harness id, TTL (verdicts are cache, not record) |
| Tailored rendering | `ACTOR#<id>` | `TAILORED#<postId>` | the member's own version, produced by *their* twin, TTL |

Derivations live under the post (`gsi1pk: POST#<id>` already exists), verdicts and
tailored renderings are per-member and disposable.

## Phases

### Phase 1 — Post once, syndicate with approval (weeks, not months)

- `POST /posts` grows a `syndicate: ["x", "instagram", ...]` request.
- A syndication agent (per surface) drafts the derivation: X gets the 280-char cut,
  IG gets caption + image/video (Masky renders), FB gets the longer form. Drafts land as
  `DERIV#...` rows with `status: draft`.
- The author approves in the UI (or auto-approves per surface once trust is earned);
  the agent posts via the **official platform APIs on business/creator accounts** —
  Meta Graph API (IG Professional + FB Page), X API v2. No automation on personal
  profiles, ever (that's the account-killing TOS line).
- Posted derivations show their external links on the canonical post, and external posts
  link back to groupnetwork.com — every surface becomes an acquisition channel.
- UTM-tag every outbound link so cmo.masky.ai conversion tracking attributes sign-ups.

### Phase 2 — Per-demographic derivations

- Variants, not just surfaces: same canonical post rendered for `expert`, `newcomer`,
  `kid-friendly`, `es`, `de`, ... — text first, then Masky avatar video versions
  (translation + avatar rendering already exist in masky.ai; this is a client of it).
- The Agentic Podcast pipeline is the first production consumer: one canonical recap →
  N demographic cuts (see the podcast plan, tracked outside this repo).

### Phase 3 — The edge filter (relevance at the member's node)

- On publish, fan out a **relevance job** to subscribed members' twins (reusing the
  Streams → fanout path; the job is just another topic). Each twin scores the canonical
  against its member's profile/history using the member's own harness and budget.
- Feed ordering becomes `max(group-recency, own-twin relevance)`; above a member-set
  threshold the twin also produces the `TAILORED#` rendering — "your version", one tap
  from the canonical.
- Honesty rules: the member can always see the untailored original; tailoring is
  presentation, never silent fact-editing; the twin's reasons are inspectable
  ("why am I seeing this" answered by *your own agent*, not a platform).
- Cost control: relevance scoring runs on the member's connected model/key by
  construction (bring-your-own-brain already implies bring-your-own-inference-bill).

### Phase 4 — Local nodes / federation (research)

- "Their groupnetwork local node" suggests members running their own edge: the twin,
  the relevance filter, and the tailored cache on hardware/accounts they control, syncing
  canonicals from the network. Candidate shapes: self-hosted node of this stack, or a
  nostr-backed sync layer (the Buzz relay ecosystem is prior art we own). Decide after
  Phase 3 proves the filter is worth decentralizing.

## Guardrails (so this never costs us an account)

- Platform posting **only** via official APIs on business/creator accounts; respect each
  platform's automation and disclosure policies; rate-limit outbound posting.
- Paid or incentivized promotion carries FTC/branded-content disclosure in the derivation
  itself, not just the canonical.
- Derivations are labelled as agent-produced where a platform requires it (Meta's
  AI-content labels), and always traceable to the canonical post.
- The edge filter never injects content the member's groups didn't surface — it ranks and
  renders, it does not invent reach.

## Open questions for Seth

1. First surfaces for Phase 1: X + IG (where the Coco boost already runs)?
2. Approval UX: approve-each at first, or trust-per-surface toggles from day one?
3. Does the Agentic Podcast channel post *through* groupnetwork from the start (dogfood),
   or independently until Phase 1 ships?
4. Phase 4 appetite: is "local node" literal self-hosting, or "your account's edge" inside
   the hosted network?
