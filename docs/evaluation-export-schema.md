# Evaluation Export — Data Dictionary

Schema reference for the ZIP file produced by `GET /api/rooms/:id/export/all`.

**Filename convention:** `room-{sanitized-name}-export.zip`

---

## ZIP Contents

| File | Format | Description |
|---|---|---|
| `posttest.csv` | CSV | Post-test survey responses (Likert + open-ended) |
| `diary.csv` | CSV | Experience-sampling (ESM) check-ins during the session |
| `interactions.csv` | CSV | Timestamped log of every user action |
| `feedback.csv` | CSV | Freeform feedback submitted via the in-app button |
| `graph.json` | JSON | Final shared knowledge graph (nodes, edges, contributors, upvotes) |
| `activity.json` | JSON | Human-readable activity feed entries |
| `metadata.json` | JSON | Room configuration, user list, evaluation toggle history |

---

## posttest.csv

One row per user. Columns `a1`–`c4` are 7-point Likert scores (1 = Strongly disagree, 7 = Strongly agree). Columns `d1`–`d3` are free-text responses.

### Columns

| Column | Type | Description |
|---|---|---|
| `id` | INT | Auto-increment primary key |
| `roomId` | TEXT | Room identifier |
| `userId` | TEXT | Session UUID |
| `displayName` | TEXT | User's chosen display name |
| `a1` | INT (1–7) | Section A, item 1 |
| `a2` | INT (1–7) | Section A, item 2 |
| `a3` | INT (1–7) | Section A, item 3 |
| `b1` | INT (1–7) | Section B, item 1 |
| `b2` | INT (1–7) | Section B, item 2 |
| `b3` | INT (1–7) | Section B, item 3 |
| `c1` | INT (1–7) | Section C, item 1 |
| `c2` | INT (1–7) | Section C, item 2 |
| `c3` | INT (1–7) | Section C, item 3 |
| `c4` | INT (1–7) | Section C, item 4 |
| `d1` | TEXT | Section D, item 1 |
| `d2` | TEXT | Section D, item 2 |
| `d3` | TEXT | Section D, item 3 |
| `completedAt` | DATETIME | ISO 8601 timestamp |
| `dismissed` | BOOL (0/1) | 1 if the user clicked "Skip" without answering |

### Item Codebook

**Section A — Learning & Exploration** (7-point Likert)

| Code | Item Text | Construct |
|---|---|---|
| a1 | "Chatting with the LLM helped me understand the topic." | Perceived learning |
| a2 | "I explored concepts in depth using follow-up prompts." | Exploration depth |
| a3 | "The concepts extracted by the LLM were relevant and useful." | LLM quality |

**Section B — Collaboration** (7-point Likert)

| Code | Item Text | Construct |
|---|---|---|
| b1 | "I was aware of what others were contributing to the graph." | Collaboration awareness |
| b2 | "The shared graph helped me see connections I wouldn't have found alone." | Emergent structure |
| b3 | "The group produced a better result than I could have alone." | Collaboration benefit |

**Section C — Usability** (7-point Likert)

| Code | Item Text | Construct |
|---|---|---|
| c1 | "The tool was easy to learn." | Learnability |
| c2 | "The distinction between personal workspace and shared graph was clear." | Two-layer mental model |
| c3 | "I understood how to harvest concepts to the shared graph." | Harvest affordance |
| c4 | "The graph layout made it easy to see the structure of the topic." | Spatial readability |

**Section D — Open-Ended**

| Code | Prompt |
|---|---|
| d1 | "Most useful feature?" |
| d2 | "Most confusing or frustrating aspect?" |
| d3 | "One thing you'd change?" |

---

## diary.csv

One row per ESM prompt (up to 3 per user per session). Likert items use a 5-point scale (1 = Strongly disagree, 5 = Strongly agree).

### Columns

| Column | Type | Description |
|---|---|---|
| `id` | INT | Auto-increment primary key |
| `roomId` | TEXT | Room identifier |
| `userId` | TEXT | Session UUID |
| `displayName` | TEXT | User's chosen display name |
| `entryNumber` | INT | 1, 2, or 3 — which check-in this was |
| `engagement` | INT (1–5) | "I feel engaged with the task right now." |
| `awareness` | INT (1–5) | "I have a clear picture of what the group has built." |
| `relevance` | INT (1–5) | "The concepts I'm finding feel relevant." |
| `activity` | TEXT | Self-reported current activity (see values below) |
| `triggeredAt` | DATETIME | When the popup appeared |
| `completedAt` | DATETIME | When the user submitted (null if not submitted) |
| `status` | TEXT | Outcome of the prompt (see values below) |

### Activity Values

| Value | Meaning |
|---|---|
| `Chatting with the LLM` | User is in the personal workspace sending messages |
| `Reading the graph` | User is examining the shared knowledge graph |
| `Organizing the graph` | User is connecting, merging, or rearranging nodes |
| `Reading others' contributions` | User is reviewing nodes added by teammates |
| `Thinking` | User is reflecting, not actively interacting |
| `Other` | None of the above |

### Status Values

| Value | Meaning |
|---|---|
| `completed` | User submitted the check-in |
| `timeout` | Auto-dismissed after 45 seconds with no response |
| `dismissed` | User clicked the dismiss button |
| `suppressed` | Popup was suppressed (e.g., feedback modal was open) |

---

## interactions.csv

One row per logged event. The `payload` column contains a JSON object whose keys depend on `eventType`.

### Columns

| Column | Type | Description |
|---|---|---|
| `id` | INT | Auto-increment primary key |
| `roomId` | TEXT | Room identifier |
| `userId` | TEXT | Session UUID |
| `displayName` | TEXT | User's chosen display name |
| `eventType` | TEXT | Event identifier (see table below) |
| `payload` | JSON | Event-specific data (serialised as a JSON string in the CSV) |
| `timestamp` | DATETIME | ISO 8601 timestamp |

### Event Types & Payload Fields

| eventType | Key Payload Fields |
|---|---|
| `chat:send` | `messageText`, `parentId`, `threadDepth` |
| `chat:response` | `responseId`, `conceptCount`, `conceptTitles[]` |
| `concept:hover` | `conceptTitle`, `durationMs` |
| `concept:explore` | `conceptTitle`, `breadcrumbPath` |
| `concept:harvest` | `conceptTitle`, `edited` (bool) |
| `concept:harvest_cancel` | `conceptTitle` |
| `graph:connect` | `sourceNodeId`, `targetNodeId`, `label` |
| `graph:merge` | `nodeIds[]`, `resultTitle` |
| `graph:expand` | `nodeId` |
| `graph:delete` | `nodeId` |
| `graph:upvote` | `nodeId` |
| `text:select_explore` | `selectedText` (truncated to 200 chars) |
| `text:select_harvest` | `selectedText` (truncated to 200 chars) |
| `graph:node_doubleclick` | `nodeId`, `nodeTitle` |
| `panel:toggle` | `panelState` |
| `session:join` | `roomId`, `displayName` |
| `session:leave` | `roomId`, `duration` |
| `posttest:submit` | _(empty)_ |
| `posttest:dismiss` | _(empty)_ |
| `eval:toggle` | `enabled` (bool) |
| `esm:submitted` | _(varies)_ |
| `esm:dismissed` | _(varies)_ |
| `esm:timeout` | _(varies)_ |
| `esm:suppressed_feedback_open` | _(varies)_ |
| `feedback:submit` | _(varies)_ |

---

## feedback.csv

One row per feedback submission.

### Columns

| Column | Type | Description |
|---|---|---|
| `id` | INT | Auto-increment primary key |
| `roomId` | TEXT | Room identifier |
| `userId` | TEXT | Session UUID |
| `displayName` | TEXT | User's chosen display name |
| `category` | TEXT | One of: `Bug`, `Suggestion`, `Confusion`, `General comment` |
| `text` | TEXT | User's free-text feedback |
| `contextJson` | JSON | Auto-captured context at submission time (see below) |
| `timestamp` | DATETIME | ISO 8601 timestamp |

### contextJson Fields

| Field | Type | Description |
|---|---|---|
| `nodeCount` | INT | Number of nodes in the shared graph at the time |
| `threadDepth` | INT | Current exploration depth in the personal workspace |
| `lastEventType` | TEXT | Most recent interaction log event type |
| `panelState` | TEXT | Which panels were open |

---

## graph.json

Final snapshot of the shared knowledge graph. Top-level keys:

```json
{
  "nodes": [...],
  "edges": [...],
  "contributors": [...],
  "upvotes": [...]
}
```

### nodes[]

| Field | Type | Description |
|---|---|---|
| `id` | TEXT | UUID |
| `room_id` | TEXT | Room identifier |
| `title` | TEXT | Concept title |
| `description` | TEXT | Concept description |
| `x` | REAL | X position on canvas |
| `y` | REAL | Y position on canvas |
| `pinned` | INT (0/1) | Whether the node has been pinned by dragging |
| `upvotes` | INT | Upvote count |
| `created_at` | DATETIME | ISO 8601 timestamp |
| `created_by` | TEXT | userId of the user who harvested the concept |
| `merged_count` | INT | Number of nodes merged into this one |

### edges[]

| Field | Type | Description |
|---|---|---|
| `id` | TEXT | UUID |
| `room_id` | TEXT | Room identifier |
| `source_id` | TEXT | Source node ID |
| `target_id` | TEXT | Target node ID |
| `label` | TEXT | Relationship label (LLM-generated or user-provided) |
| `directed` | INT (0/1) | 1 = directed arrow, 0 = symmetric/undirected |
| `created_at` | DATETIME | ISO 8601 timestamp |
| `created_by` | TEXT | userId of the user who created the connection |

### contributors[]

| Field | Type | Description |
|---|---|---|
| `node_id` | TEXT | Node UUID |
| `user_id` | TEXT | Session UUID of contributor |
| `contributed_at` | DATETIME | ISO 8601 timestamp |

### upvotes[]

| Field | Type | Description |
|---|---|---|
| `node_id` | TEXT | Node UUID |
| `user_id` | TEXT | Session UUID of voter |

---

## activity.json

Array of human-readable activity feed entries (displayed in the app's activity sidebar).

### Fields per entry

| Field | Type | Description |
|---|---|---|
| `id` | INT | Auto-increment primary key |
| `room_id` | TEXT | Room identifier |
| `user_id` | TEXT | Session UUID (null for system events) |
| `user_name` | TEXT | Display name |
| `action` | TEXT | Action verb (e.g., `added`, `connected`, `merged`, `expanded`, `deleted`) |
| `target_type` | TEXT | Entity type (e.g., `node`, `edge`) |
| `target_id` | TEXT | ID of the affected entity |
| `details` | TEXT | Human-readable description |
| `created_at` | DATETIME | ISO 8601 timestamp |

---

## metadata.json

Room-level metadata and configuration.

```json
{
  "roomId": "abc-123",
  "roomName": "Graphologue — Jiang et al. 2024",
  "state": "closed",
  "createdAt": "2026-02-20T09:00:00.000Z",
  "durationMinutes": 12,
  "users": [
    { "sessionId": "uuid-1", "displayName": "Alice" },
    { "sessionId": "uuid-2", "displayName": "Bob" }
  ],
  "evalModeToggles": [
    { "timestamp": "2026-02-20T09:01:00.000Z", "enabled": true },
    { "timestamp": "2026-02-20T09:13:00.000Z", "enabled": false }
  ],
  "exportedAt": "2026-02-20T09:15:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `roomId` | TEXT | Room identifier |
| `roomName` | TEXT | Room display name |
| `state` | TEXT | Room lifecycle state at export time (`normal`, `in-progress`, `posttest`, `closed`) |
| `createdAt` | DATETIME | When the room was created |
| `durationMinutes` | INT or null | Configured session duration (null if not set) |
| `users[]` | Array | All users who joined the room |
| `users[].sessionId` | TEXT | Session UUID |
| `users[].displayName` | TEXT | Display name |
| `evalModeToggles[]` | Array | History of evaluation mode on/off toggles |
| `evalModeToggles[].timestamp` | DATETIME | When the toggle occurred |
| `evalModeToggles[].enabled` | BOOL | true = turned on, false = turned off |
| `exportedAt` | DATETIME | When the export was generated |
