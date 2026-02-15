# Data Collection & Evaluation — Deployment Spec

Spec for classroom deployment. Covers: authentication, room management, interaction logging, experience sampling, freeform feedback, post-test survey, and data export.

---

## Session Format

Each evaluation session is **10–15 minutes** focused on a single topic or research paper. The instructor runs multiple sessions in sequence, one room per topic. Example schedule:

- Room 1: "Graphologue (Jiang et al. 2024)" — 12 minutes
- Room 2: "Collaborative Sensemaking (Morris 2013)" — 12 minutes
- Room 3: open exploration — 10 minutes

Users join a room, explore via LLM chat, harvest and curate the shared graph, then the instructor triggers the post-test and moves everyone to the next room.

---

## A0: Authentication

### Users

No login required. Users enter a display name on the room join screen (existing behavior). The server assigns a session ID (UUID) on first connection, stored in a cookie. The `userId` in all log entries is this session UUID; `displayName` is stored alongside for readability.

### Admin (Instructor)

Lightweight URL-secret approach. No OAuth, no packages.

1. Set `ADMIN_SECRET` as an environment variable on the server (e.g., `ADMIN_SECRET=mySecret123`)
2. The instructor opens the app with `?admin=mySecret123` in the URL
3. Client sends the secret to `GET /api/auth/admin?secret=mySecret123`
4. Server validates against the `ADMIN_SECRET` env var
5. On match, server sets an `admin=true` session cookie (HTTP-only, same-site)
6. Client calls `history.replaceState(null, '', '/')` to strip the secret from the URL bar — the URL is now clean and safe to show on a projector
7. All subsequent requests include the session cookie; server checks it for admin endpoints
8. Admin status persists for the browser session (until cookies are cleared or the session expires)

Admin privileges: create/delete rooms, toggle evaluation mode, trigger post-test, export data, see the instructor control strip. The admin status is exposed to the client via `GET /api/auth/status` → `{role: 'admin'}` or `{role: 'user'}`.

### Implementation Notes

- Use `express-session` for session management (install if not already present)
- No passport, no OAuth packages needed
- The `requireAdmin` middleware checks `req.session.admin === true`

---

## A1: Room Management

### Admin-Only Room Creation

Only admin users can create rooms. The "Create Room" button is visible only for `role: 'admin'`. Regular users see the room list and can join existing rooms.

### Room Setup

When creating a room, the admin provides:
- **Room name** (e.g., "Graphologue — Jiang et al. 2024")
- **Seed concepts** (optional, using existing `POST /api/rooms/:id/seed` endpoint)
- **Session duration** (optional, in minutes)

### Session Timer

If a duration is set, a countdown timer appears in the room header bar, visible to all users. The timer is informational — it does not auto-close the room. When the timer reaches zero, it flashes briefly and displays "Time's up" but the session continues until the admin explicitly advances the room state.

The admin can start, pause, and reset the timer from the control strip.

### Room Lifecycle

Each room has a state: `waiting → active → posttest → closed`

| Transition | Trigger | Effect |
|---|---|---|
| `waiting → active` | Admin clicks "Start Session" | Timer starts (if set), ESM scheduling begins (if eval mode on) |
| `active → posttest` | Admin clicks "Trigger Post-Test" | Post-test modal pushed to all clients |
| `posttest → closed` | Admin clicks "Close Room" | Room locked, no further joins, export available |

### Auto-Disperse (Deferred — Data Model Only)

For future use with large cohorts. Add a `templateId` (nullable) field to the rooms table. Rooms sharing a `templateId` are copies of the same topic with independent graphs. No UI for this yet.

---

## E1: Interaction Logging

Every meaningful user action is logged for analysis.

### Table

```sql
interaction_log(
  id INTEGER PRIMARY KEY,
  roomId TEXT,
  userId TEXT,         -- session UUID
  displayName TEXT,
  eventType TEXT,
  payload JSON,
  timestamp DATETIME
)
```

### Events

| Event | Key Payload Fields |
|---|---|
| `chat:send` | messageText, parentId, threadDepth |
| `chat:response` | responseId, conceptCount, conceptTitles[] |
| `concept:hover` | conceptTitle, durationMs |
| `concept:explore` | conceptTitle, breadcrumbPath |
| `concept:harvest` | conceptTitle, edited (bool) |
| `concept:harvest_cancel` | conceptTitle |
| `graph:connect` | sourceNodeId, targetNodeId, label |
| `graph:merge` | nodeIds[], resultTitle |
| `graph:expand` | nodeId |
| `graph:delete` | nodeId |
| `graph:upvote` | nodeId |
| `text:select_explore` | selectedText (truncated 200 chars) |
| `text:select_harvest` | selectedText (truncated 200 chars) |
| `graph:node_doubleclick` | nodeId, nodeTitle |
| `panel:toggle` | panelState |
| `session:join` | roomId, displayName |
| `session:leave` | roomId, duration |

Payload is a JSON blob — flexible schema, no per-event columns needed.

---

## E2: Experience Sampling (ESM)

Brief in-situ prompts during the session to capture engagement, collaboration awareness, and perceived LLM quality in the moment.

### Timing

When evaluation mode is enabled (admin toggle):

- First popup: **3 minutes** after the user joins
- Subsequent popups: **3 minutes** after previous popup completion/dismissal
- **Maximum 3 entries** per session per user
- Suppression: if the user has the chat input focused with >0 characters, delay 20 seconds then show regardless

### Non-Interference with Feedback

- If the freeform feedback modal (E3) is open, suppress the ESM popup entirely for that interval. Log `esm:suppressed_feedback_open`. Do not queue.
- If an ESM popup is showing and the user clicks the feedback button, dismiss the ESM popup (log `esm:dismissed_for_feedback`) and show the feedback form.

### Instrument (4 items, ~10 seconds)

| # | Item | Response | Construct |
|---|---|---|---|
| 1 | "I feel engaged with the task right now." | 5-point Likert (Strongly disagree → Strongly agree) | Engagement |
| 2 | "I have a clear picture of what the group has built." | 5-point Likert | Collaboration awareness |
| 3 | "The concepts I'm finding feel relevant." | 5-point Likert | LLM content quality |
| 4 | "What are you doing right now?" | Single-select: Chatting with the LLM / Reading the graph / Organizing the graph / Reading others' contributions / Thinking / Other | Activity state |

### UI

Small modal, 340px wide. Light semi-transparent overlay (graph visible behind). Header: "Quick check-in (1 of 3)". Auto-dismiss after 45 seconds (logged as `esm:timeout`). Small "×" button to dismiss without submitting (logged as `esm:dismissed`).

### Storage

```sql
diary_entries(
  id INTEGER PRIMARY KEY,
  roomId TEXT,
  userId TEXT,
  displayName TEXT,
  entryNumber INT,
  engagement INT,
  awareness INT,
  relevance INT,
  activity TEXT,
  triggeredAt DATETIME,
  completedAt DATETIME,
  status TEXT   -- completed | timeout | dismissed | suppressed
)
```

---

## E3: Freeform Feedback

Always visible, independent of evaluation mode. Users can report bugs, ideas, or confusion at any time.

### UI

Floating button in the lower-right corner. Icon: speech bubble. Label: "Feedback".

```
┌────────────────────────────────────┐
│  Feedback                     [×]  │
│                                    │
│  Category:                         │
│  ( ) Bug / something broken        │
│  ( ) Suggestion / feature idea     │
│  ( ) Confusion / unclear how to... │
│  ( ) General comment               │
│                                    │
│  What happened?                    │
│  ┌──────────────────────────────┐  │
│  │ [multi-line text, 4 rows]    │  │
│  └──────────────────────────────┘  │
│                                    │
│            [Submit Feedback]       │
│                                    │
└────────────────────────────────────┘
```

On submit, show brief "Thanks!" confirmation, then dismiss.

### Auto-Captured Context

Attached automatically on submit (not visible to the user):

| Field | Source |
|---|---|
| `userId`, `displayName` | Session |
| `roomId` | Current room |
| `timestamp` | Client-side |
| `nodeCount` | Current shared graph size |
| `threadDepth` | Current exploration depth in personal workspace |
| `lastEventType` | Most recent interaction log entry |
| `panelState` | Which panels are open |

### Storage

```sql
feedback(
  id INTEGER PRIMARY KEY,
  roomId TEXT,
  userId TEXT,
  displayName TEXT,
  category TEXT,
  text TEXT,
  contextJson JSON,
  timestamp DATETIME
)
```

---

## E4: Post-Test Survey

### Trigger

Admin clicks "Trigger Post-Test" in the control strip. All connected clients receive a **blocking modal**. Room transitions to `posttest` state.

### Instrument (10 Likert + 3 open-ended, target < 2 minutes)

**Section A: Learning & Exploration (7-point Likert, Strongly disagree → Strongly agree)**

| # | Item | Construct |
|---|---|---|
| A1 | "Chatting with the LLM helped me understand the topic." | Perceived learning |
| A2 | "I explored concepts in depth using follow-up prompts." | Exploration depth |
| A3 | "The concepts extracted by the LLM were relevant and useful." | LLM quality |

**Section B: Collaboration (7-point Likert)**

| # | Item | Construct |
|---|---|---|
| B1 | "I was aware of what others were contributing to the graph." | Collaboration awareness |
| B2 | "The shared graph helped me see connections I wouldn't have found alone." | Emergent structure |
| B3 | "The group produced a better result than I could have alone." | Collaboration benefit |

**Section C: Usability (7-point Likert)**

| # | Item | Construct |
|---|---|---|
| C1 | "The tool was easy to learn." | Learnability |
| C2 | "The distinction between personal workspace and shared graph was clear." | Two-layer mental model |
| C3 | "I understood how to harvest concepts to the shared graph." | Harvest affordance |
| C4 | "The graph layout made it easy to see the structure of the topic." | Spatial readability |

**Section D: Open-Ended**

| # | Item |
|---|---|
| D1 | "Most useful feature?" (free text, 1–2 sentences) |
| D2 | "Most confusing or frustrating aspect?" (free text, 1–2 sentences) |
| D3 | "One thing you'd change?" (free text, 1–2 sentences) |

### UI

Full-screen modal with light background. Single scrollable form. Likert items rendered as clickable button rows (not dropdowns). "Submit" at the bottom. Small "Skip" link at top-right. Skipping is logged.

### Storage

```sql
posttest(
  id INTEGER PRIMARY KEY,
  roomId TEXT,
  userId TEXT,
  displayName TEXT,
  a1 INT, a2 INT, a3 INT,
  b1 INT, b2 INT, b3 INT,
  c1 INT, c2 INT, c3 INT, c4 INT,
  d1 TEXT, d2 TEXT, d3 TEXT,
  completedAt DATETIME,
  dismissed BOOL
)
```

---

## E5: Data Export

Admin-only. Available when a room is in `closed` state (or anytime via the API).

### Bundled Export

`GET /api/rooms/:id/export/all` → ZIP file containing:

| File | Contents |
|---|---|
| `interactions.csv` | Full interaction log |
| `diary.csv` | All ESM entries including timeouts and suppressions |
| `feedback.csv` | All freeform feedback with context metadata |
| `posttest.csv` | All post-test responses |
| `graph.json` | Final graph state (nodes, edges, provenance) |
| `activity.json` | Existing activity log |
| `metadata.json` | Room name, creation time, user list, session duration, evaluation mode timestamps |

### Per-Table Export

`GET /api/rooms/:id/export/{interactions,diary,feedback,posttest}`

---

## E6: Instructor Control Strip

Visible only for `role: 'admin'` users. Rendered as a thin bar at the top of the screen.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 🎓 Admin  │  Room: [state]  │  ⏱ 12:00  │  ESM: [ON/OFF]  │  [Post-Test]  │  [Export]  │  👤 24  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

| Control | Action |
|---|---|
| Room state | Current lifecycle state. Click to advance to next state. |
| Timer | Countdown display. Click to start/pause. Long-press or right-click to reset. |
| ESM toggle | Enable/disable experience sampling for this room |
| Post-Test | Push post-test survey to all connected clients |
| Export | Download ZIP bundle for this room |
| User count | Live count of connected users |

---

## Implementation Order

Recommended sequence, each step as a separate Claude Code task:

### Step 1: Interaction Logging (E1)

> Read `docs/data-collection-spec.md`, section E1. Create an `interaction_log` table in `database.js` (columns: id, roomId, userId, displayName, eventType, payload JSON, timestamp). Add a helper function `logInteraction(roomId, userId, displayName, eventType, payload)`. In `index.js`, call `logInteraction` from existing socket event handlers: chat messages, concept harvest, graph operations (connect, merge, expand, delete, upvote), and panel toggle. Add `session:join` and `session:leave` events. Add export endpoint `GET /api/rooms/:id/export/interactions` returning JSON.

### Step 2: Freeform Feedback (E3)

> Read `docs/data-collection-spec.md`, section E3. Add a `feedback` table in `database.js` (columns: id, roomId, userId, displayName, category, text, contextJson, timestamp). In `index.html`, add a floating feedback button (lower-right corner, speech bubble icon, label "Feedback"). Clicking opens a modal with: radio buttons for category (Bug, Suggestion, Confusion, General comment), a multi-line textarea, and a Submit button. On submit, emit a `feedback:submit` socket event with the form data plus auto-captured context (nodeCount from the graph, current thread depth, last interaction event type, panel state). Server stores in the `feedback` table. Show brief "Thanks!" confirmation then dismiss. Add `GET /api/rooms/:id/export/feedback` endpoint. Add CSS for `.feedback-button` (fixed position, bottom-right, z-index above graph) and `.feedback-modal`.

### Step 3: Admin Auth & Control Strip (A0, A1, E6)

> Read `docs/data-collection-spec.md`, sections A0, A1, and E6. Install `express-session`. Add admin auth via URL secret: `GET /api/auth/admin?secret=X` validates against `ADMIN_SECRET` env var and sets `req.session.admin = true`. Add `GET /api/auth/status` returning `{role: 'admin'|'user'}`. On the client, on page load check for `?admin=` URL param, call the auth endpoint, then strip the param with `history.replaceState`. Add `requireAdmin` middleware for protected routes. Restrict `POST /api/rooms` and export endpoints to admin only. Add room lifecycle fields to the rooms table: `state` (waiting/active/posttest/closed) and `durationMinutes` (nullable). Add endpoints: `POST /api/rooms/:id/state` to advance lifecycle, `POST /api/rooms/:id/eval-mode` to toggle ESM. In `index.html`, add the instructor control strip (thin bar at top, visible only for admin): room state display with advance button, countdown timer (start/pause/reset), ESM toggle, Post-Test trigger button, Export button, live user count. The timer is client-side countdown from `durationMinutes`, purely informational. Wire the Post-Test button to emit a `posttest:trigger` socket event to all clients in the room. Show "Create Room" button only for admin users.

### Step 4: Experience Sampling (E2)

> Read `docs/data-collection-spec.md`, section E2. Add a `diary_entries` table in `database.js` (columns: id, roomId, userId, displayName, entryNumber, engagement, awareness, relevance, activity, triggeredAt, completedAt, status). In `app.js`, add ESM timer logic: when the client receives a socket event indicating eval mode is on, start a timer for the first popup at 3 minutes. After each popup completion or dismissal, schedule the next at 3 minutes. Max 3 per session. Suppression rules: if chat input is focused with text, delay 20 seconds; if the feedback modal is open, suppress entirely and log `esm:suppressed_feedback_open`; if ESM is showing and feedback button is clicked, dismiss ESM and log `esm:dismissed_for_feedback`. The popup is a small modal (340px wide, light overlay) with: header "Quick check-in (N of 3)", three 5-point Likert rows (engaged, clear picture, relevant concepts), one single-select row (activity state with 6 options), and a Submit button. Auto-dismiss after 45 seconds (log timeout). Store via `diary:submit` socket event. Add `GET /api/rooms/:id/export/diary` endpoint.

### Step 5: Post-Test Survey (E4)

> Read `docs/data-collection-spec.md`, section E4. Add a `posttest` table in `database.js` (columns: id, roomId, userId, displayName, a1-a3, b1-b3, c1-c4 as INT, d1-d3 as TEXT, completedAt, dismissed). Listen for the `posttest:trigger` socket event on the client. When received, show a full-screen blocking modal with: Section A (3 items, 7-point Likert button rows), Section B (3 items), Section C (4 items), Section D (3 free-text inputs). Each Likert row is a horizontal row of 7 clickable buttons labeled 1–7 with "Strongly disagree" and "Strongly agree" at the ends. Submit button at bottom, small "Skip" link at top-right. On submit, emit `posttest:submit`. On skip, emit `posttest:dismiss`. Server stores in the `posttest` table. Add `GET /api/rooms/:id/export/posttest` endpoint.

### Step 6: Bundled Export (E5)

> Read `docs/data-collection-spec.md`, section E5. Install `archiver` (or use `jszip`). Add `GET /api/rooms/:id/export/all` endpoint (admin-only). It generates a ZIP containing: interactions.csv, diary.csv, feedback.csv, posttest.csv (each from their respective tables, converted to CSV), graph.json (current room graph state), activity.json (existing activity log), and metadata.json (room name, state, creation time, duration, user list with session IDs and display names, evaluation mode toggle timestamps). Wire the Export button in the instructor control strip to trigger a download from this endpoint.

---

## Analysis Framework

| Analysis | Data Sources | Question |
|---|---|---|
| Sensemaking phase allocation | Interaction log event types | How do users divide time between foraging and synthesis? |
| Harvest selectivity | Concepts extracted vs. concepts harvested | Does the deliberate harvest model prevent content dumping? |
| Graph construction sequence | Timestamped graph operations | Do hub concepts emerge early? Do clusters form organically? |
| Collaboration equity | Per-user operation counts | Is contribution distributed or dominated by a few? |
| ESM × behavior | Diary ratings vs. interaction density in preceding window | Does self-reported engagement predict observable behavior? |
| Thread depth × learning | Max thread depth vs. post-test A1 | Does deeper exploration correlate with perceived learning? |
| Scaling effects | Cross-room comparison (future) | At what group size does graph quality degrade? |