# Shared Knowledge Graph — Design Specification

## Lodestar

> A tool for collaborative sensemaking where multiple users incrementally search, collect, and spatially organize information into a persistent, hierarchical structure.

The key verbs are **search → collect → organize**, performed collaboratively over time.

The tool implements a two-layer model based on Pirolli & Card's sensemaking loop:

- **Personal workspace** (left panel): ephemeral foraging via LLM chat with threaded exploration. See `personal-workspace-improvements.md` for full spec.
- **Shared graph** (center panel): persistent, collaboratively curated knowledge structure. This document specifies its design.

Harvest bridges the two layers. Knowledge flows personal → shared via deliberate harvest actions, and shared → personal via double-click exploration (F7 in the personal workspace spec).

---

## Running Example: 19th-Century Philosophers

All design decisions are grounded in a concrete scenario: a student cohort mapping out 19th-century philosophy. This domain works because:

- The topic space is large enough to require structure
- Natural clusters exist (German Idealism, Utilitarianism, Existentialism, Pragmatism) but students will discover and organize them differently
- No single canonical taxonomy — multiple valid organizations
- Rich in relationships (influence, opposition, lineage)

---

## Auto-Connections on Harvest

A concept harvested with no connections is an orphan — it carries no structural information. The system proposes connections automatically at harvest time.

**Mechanism:**

1. User triggers harvest (from inline concept, text selection, or chip)
2. The harvest inline form appears (F6 in the personal workspace spec) for title/description editing
3. On confirmation, the client sends the concept to the server
4. An **asynchronous Haiku call** fires: given the new concept and the list of existing node titles in the current cluster/level, propose 2–3 connections with relationship labels
5. While the call is in flight, the node appears in the graph immediately (no blocking) with a subtle loading indicator
6. When the LLM responds (~1–2s), the proposed edges animate in. Each edge appears with a brief "accept/dismiss" affordance (small ✓/✗ on the edge label, visible for ~5s, then auto-accepted)
7. Users can always remove or edit edges later via right-click

**Edge cases:**

- If the graph has 0–1 existing nodes, skip the connection call
- If the LLM proposes a connection to a node inside a different cluster, create a cross-cluster edge (stored in data model, visible when viewing the parent level)
- If the Haiku call fails or times out (>3s), add the node without connections; the user can connect manually

---

## Edge Directionality

Edges use **mixed directionality**: the LLM decides per edge whether it is directed or symmetric.

- "Influenced" is directed: Hegel → influenced → Marx
- "Were contemporaries" is symmetric: Nietzsche ↔ were contemporaries ↔ Engels
- "Opposed" is symmetric: Marx ↔ opposed ↔ Stirner

**Data model:** Each edge has a `directed: boolean` field.

- `directed: true` → renders with an arrowhead from source to target
- `directed: false` → renders with no arrowheads (or small dots on both ends)

**User override:** Right-click an edge → "Flip direction" (for directed edges) or "Toggle directed/symmetric." This keeps the default experience simple — no user decisions about direction during creation — while allowing corrections.

The LLM determines directionality as part of the same call that labels the relationship (both during manual connection and auto-connection on harvest).

---

## Concept Title Display

Concept titles extracted by the LLM can be verbose (e.g., "The Categorical Imperative in Kantian Ethics"). Long titles break the graph layout — nodes become too wide and edges overlap.

**Strategy:**

1. **Extraction prompt** asks the LLM for concise titles (2–4 words preferred)
2. **Server-side truncation**: if a title exceeds 40 characters, a Haiku call shortens it to a concise label while preserving meaning. The original long title is stored as `fullTitle` for tooltips and detail views.
3. **Client-side rendering**: node labels line-break at word boundaries. Maximum two lines; text beyond that is truncated with ellipsis. Full title appears on hover.

---

## Provenance Tracking

Every concept in the shared graph carries provenance metadata:

| Field | Description |
|---|---|
| `harvestedBy` | Username of the contributor |
| `harvestedFrom` | ID of the LLM response it was extracted from |
| `harvestedAt` | Timestamp |
| `editedBy` | Array of usernames who have modified the concept |
| `sourceQuery` | The user query that generated the originating LLM response |

This metadata is displayed in a small footer on the concept detail view (right-click → "Details") and used for activity logging and replay.

### External Citations (Data Model Only)

The concept schema includes a `sources: []` array for future use. Each entry:

```json
{
  "title": "string",
  "url": "string (optional)",
  "authors": "string (optional)",
  "year": "number (optional)"
}
```

The LLM prompting to populate this field is deferred. The schema is included now so that the database does not need migration later.

---

## Personal Workspace: Ephemeral by Design

The personal workspace (left panel) is a scratchpad, not a persistent store. Design principles:

- **Session-scoped**: threads are not persisted across sessions
- **Clearable**: a "Clear workspace" button wipes all threads (already implemented)
- **New query = new thread**: each root-level query starts a fresh threaded conversation
- **Old threads remain visible** during the session (scrollable) but carry no long-term commitment
- **Harvest to persist**: if something is valuable, harvest it to the shared graph. That is the persistence mechanism.

The personal workspace threading model is specified in `personal-workspace-improvements.md` (features F4, F7, F8).

---

## Scope Boundaries

| Feature | Status | Rationale |
|---|---|---|
| Auto-connections on harvest | **In scope** | Concepts must be connected to carry structural information |
| Mixed edge directionality | **In scope** | LLM-determined, user-overridable |
| Concept title truncation | **In scope** | Prevents layout breakage from verbose titles |
| Provenance tracking (who, when, from what) | **In scope** | Essential for collaboration awareness |
| External citations schema | **In scope** | Future-proof the data model |
| Hierarchical clusters with substrate navigation | **Deferred** | Core structural mechanism, implement after Monday class |
| Breadcrumb navigation bar | **Deferred** | Required for hierarchy, implement with clusters |
| External citations via LLM prompting | **Deferred** | Requires prompt engineering and verification |
| Concept thumbnails | **Deferred** | Low priority, cosmetic |
| Ghost nodes for cross-cluster edges | **Deferred** | Revisit if disorientation is observed in testing |
| Communication channel (chat, comments) | **Out of scope** | Competes with structured organization as communication medium |
| Freeform manual concept creation | **Out of scope** | Use cluster labels and rename instead |
| Personal workspace persistence across sessions | **Out of scope** | Ephemeral by design; harvest to persist |

---

## Implementation Order (Pre-Monday)

Features to implement before the Monday class session. Personal workspace improvements are developed in parallel (see `personal-workspace-improvements.md`).

1. **Edge directionality** — add `directed: boolean` to edge schema, update rendering (arrowheads vs. symmetric), update LLM relationship labeling prompt to also determine directionality
2. **Auto-connections on harvest** — Haiku call on harvest, async edge proposals, accept/dismiss UI
3. **Concept title truncation** — extraction prompt tuning, Haiku shortening for long titles, two-line node labels with ellipsis
4. **Provenance metadata** — extend harvest flow to record source info, detail view
5. **Citations schema** — database migration, empty UI placeholder

## Implementation Order (Post-Monday)

1. **Cluster data model** — add `parentClusterId` to nodes, cluster table in database, nesting depth tracking
2. **Breadcrumb navigation bar** — UI component, wired to current navigation depth
3. **Cluster navigation** — double-click to enter, breadcrumb to exit, per-level force layout
4. **Cluster creation** — multi-select → group, drag-to-add, LLM-suggested labels
5. **Concept thumbnails** — optional `thumbnailUrl` field, Wikipedia API fetch for entities with pages

---

## Deferred Design: Hierarchical Clusters

### Motivation

A flat graph becomes unreadable beyond ~30 nodes. Students need to group related concepts and work at multiple levels of abstraction. Clusters are the primary structural mechanism.

### Interaction Model: Substrate Navigation

Entering a cluster replaces the current view with the cluster's internal layout. This follows a file-system / Prezi-style navigation metaphor.

**Behavior:**

1. Clusters appear as labeled container nodes in the graph (larger than concept nodes, distinct visual treatment)
2. Double-click a cluster → navigate into it, showing its internal nodes and edges
3. A **breadcrumb bar** at the top of the graph panel shows the navigation path: `Root > German Idealism > Hegel's Influences`
4. Clicking any breadcrumb segment navigates back to that level
5. Each level has its own independent force layout (node positions are preserved per level)

**Creating clusters:**

- Select multiple nodes → right-click → "Group into cluster"
- Name the cluster (LLM suggests a label based on the grouped concepts)
- Drag a node onto a cluster to add it
- Right-click a node inside a cluster → "Move to parent" to remove it

**Cross-cluster relationships:**

Entering a cluster hides the global context. We accept this trade-off in exchange for simplicity and visual clarity. Breadcrumbs provide orientation. Cross-cluster edges are preserved in the data model but not visualized when navigated into a cluster. If disorientation proves to be a problem in user testing, we can revisit (e.g., ghost nodes at the periphery representing external connections).

---

## Open Questions

1. **Maximum nesting depth** — should clusters nest arbitrarily, or cap at 2–3 levels? Arbitrary nesting is more general but risks disorientation. Recommendation: cap at 3 levels for the prototype, evaluate in user studies.
2. **Cluster layout persistence** — when a user arranges nodes inside a cluster, is that layout shared (all users see the same arrangement) or personal? Shared is simpler and supports collaborative spatial organization. Recommend shared.
3. **Empty clusters as scaffolding** — should users be able to create named empty clusters as organizational anchors before populating them? This is the minimal version of "manual concept creation" that avoids a full freeform editor. Recommend yes.