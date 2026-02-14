# Personal Workspace Panel — Improvement Spec

## Current State

The left panel is labeled **"Chat"** with a header `<h2>Chat</h2>`. It contains a standard LLM chat interface with concept chips appended after each assistant response. Each chip has a `+` harvest button. The panel is 360px wide, collapsible via a toggle button.

The current design treats the panel as a plain chat window with concept extraction bolted on at the end of each response. The concepts sit in a flex-wrap row *below* the response text, separated from the prose they came from.

---

## Design Goals

1. **Rename**: "Chat" → **"Personal Workspace"**
2. **Inline concept highlighting** — concepts appear *within* the response text, not just appended below
3. **Tooltips with information scent** — hovering a concept shows a one-sentence description
4. **Expand/follow-up** — clicking a highlighted concept issues an automatic follow-up prompt to the LLM
5. **Text selection → manual harvest** — selecting arbitrary text surfaces an action to harvest it as a concept or issue a follow-up query
6. **Threaded exploration** — explore chains render as indented, collapsible threads (Reddit-style) with breadcrumb context
7. **Bidirectional loop** — double-click a shared graph node to bring it into the personal workspace for exploration
8. **Fluid, fast interaction** — minimize modal dialogs, favor inline and contextual interactions

---

## Feature Specifications

### F1: Rename Header

Change the chat header from `"Chat"` to `"Personal Workspace"`.

**Changes:**
- `index.html`: Update `<h2>Chat</h2>` → `<h2>Personal Workspace</h2>`
- `chat-input` placeholder: Change from `"Ask about concepts..."` to `"Explore a concept..."` (or similar — keep it action-oriented)

---

### F2: Inline Concept Highlighting

Currently, `appendChatResponse()` renders the response text as plain paragraphs, then appends concept chips in a separate `<div>` below. Instead, concepts should be highlighted *inline within the prose*.

**Behavior:**
- When the LLM returns a response with extracted concepts, each concept's title is matched against the response text
- Matching spans are wrapped in `<span class="concept-inline">` elements
- If a concept title appears multiple times, only highlight the *first* occurrence
- The appended chip row at the bottom is *removed* (replaced by inline highlighting)
- If a concept title does not appear verbatim in the text, fall back to appending it as a chip below (preserves current behavior as fallback)

**Visual treatment:**
- `concept-inline`: subtle background highlight (e.g., `background: #f0fdf4; border-bottom: 2px solid #86efac;`) — visible but not distracting
- On hover: slightly stronger background, cursor changes to pointer
- Harvested concepts: background shifts to muted gray (`#e2e8f0`), checkmark icon replaces the underline

**Data attributes on each span:**
- `data-concept-title`
- `data-concept-description`
- `data-concept-index`

---

### F3: Concept Tooltips (Information Scent)

Hovering over an inline concept shows a tooltip with the one-sentence description returned by the LLM.

**Behavior:**
- Tooltip appears after ~300ms hover delay (avoids flicker on casual mouse movement)
- Tooltip contains:
  - Concept title (bold)
  - One-sentence description
  - Two action buttons: **Harvest** (`+` icon) and **Explore** (`→` icon)
- Tooltip positioned above the concept span, centered, with a small arrow pointing down
- Tooltip dismisses on mouse leave (with ~100ms grace period for moving into the tooltip itself)

**Implementation approach:**
- Single shared tooltip DOM element, repositioned on hover (not one per concept — too many DOM nodes)
- CSS class `.concept-tooltip` with absolute positioning, `z-index: 100`

**Tooltip HTML structure:**
```
┌──────────────────────────────┐
│ **Concept Title**            │
│ One-sentence description     │
│                              │
│  [+ Harvest]    [→ Explore]  │
└──────────────────────────────┘
```

---

### F4: Explore (Auto Follow-Up Prompt)

Clicking the **Explore** button (or clicking directly on an inline concept) issues an automatic follow-up query to the LLM.

**Behavior:**
1. User clicks an inline concept or the "Explore" button in the tooltip
2. A follow-up prompt is automatically composed and sent:
   - Template: `"Tell me more about {concept_title}. {concept_description}"`
   - The prompt appears in the chat as a user message (so the student sees what was asked)
3. The LLM responds as normal, with its own extracted concepts
4. The explored concept gets a visual indicator (e.g., a small `↳` icon or indented thread marker) showing it was expanded from a previous response

**Visual treatment:**
- The auto-generated user message has a subtle visual distinction from manually typed messages (e.g., a small `→` icon prefix, or slightly lighter background) to signal it was system-composed
- Consider showing a brief "thread" connector line between the original concept and the follow-up, but only if this can be done without cluttering the chat

**Optional enhancement (defer if complex):**
- Before sending, briefly flash the prompt in the input area for ~500ms so the user can see what's about to be sent, then auto-send. This gives a sense of agency. If the user clicks the input area during the flash, cancel auto-send and let them edit.

---

### F5: Text Selection Actions

When the user selects arbitrary text in an LLM response, a floating action bar appears near the selection.

**Behavior:**
1. User selects text within a `.chat-msg.assistant` element
2. A small floating toolbar appears above/below the selection:
   - **Harvest as concept** — opens a minimal inline form: title (pre-filled with selected text, truncated to ~60 chars), one-sentence description (empty, user fills or skips). On confirm, publishes to shared graph.
   - **Explore** — uses the selected text as the basis for a follow-up prompt: `"Tell me more about: {selected_text}"`
3. Toolbar disappears when selection is cleared

**Implementation:**
- Listen for `mouseup` events on `.chat-messages`
- Check `window.getSelection()` — if non-empty and within an assistant message, show toolbar
- Toolbar is a single shared DOM element (like the tooltip), repositioned per selection
- Use `getRangeAt(0).getBoundingClientRect()` for positioning

**Floating toolbar structure:**
```
┌─────────────────────────────┐
│  [+ Harvest]    [→ Explore] │
└─────────────────────────────┘
```

**Edge cases:**
- If the selection spans multiple paragraphs, still allow both actions
- If selection is very long (>200 chars), truncate the title in the harvest form but keep full text as description
- Dismiss toolbar on scroll or click outside

---

### F6: Harvest Inline Form

When harvesting (from tooltip, text selection, or the existing chip fallback), use a lightweight inline form instead of immediately publishing.

**Behavior:**
1. Harvest action triggers a small inline card that expands in-place (below the concept or near the selection):
   ```
   ┌────────────────────────────────┐
   │ Title: [editable, pre-filled]  │
   │ Desc:  [editable, pre-filled]  │
   │                                │
   │  [Cancel]  [Add to Graph →]    │
   └────────────────────────────────┘
   ```
2. Title and description are pre-filled from the concept data (or selected text)
3. User can edit before publishing
4. "Add to Graph" publishes to the shared graph (existing `publishConcept` logic)
5. On publish, the inline concept highlight transitions to "harvested" state (gray background, checkmark)

**Rationale:** The current one-click harvest is fast but gives no chance to refine. The inline form adds ~2 seconds but produces better concept quality. Keep it minimal — two fields, two buttons, no modal.

---

### F7: Double-Click Shared Graph Node → Personal Workspace

Double-clicking a node in the shared knowledge graph opens a new exploration thread in the personal workspace.

**Behavior:**
1. User double-clicks a node on the shared graph canvas
2. If the personal workspace panel is collapsed, it auto-expands
3. A new **exploration section** appears at the bottom of the personal workspace, visually separated from prior threads
4. The section header shows the node's title (with a small graph icon as provenance indicator)
5. An automatic explore prompt is sent using the node's title and description
6. The LLM response appears within this new section, with its own inline concept highlights

This completes the bidirectional loop: harvest moves knowledge *personal → shared*; double-click moves knowledge *shared → personal*.

---

### F8: Threaded Conversation with Collapsible Sections

The personal workspace renders as a **tree of exploration threads** rather than a flat chat log. Each explore action (F4, F5, or F7) creates an indented child thread under the response it originated from.

**Structure:**
```
[▾] User prompt: "What are transformer architectures?"        ← root
    LLM response with inline concepts...
    │
    ├── [▾] → Explore: "Self-Attention"                       ← depth 1
    │       Context: LLMs → Transformer Architecture → Self-Attention
    │       LLM response with inline concepts...
    │       │
    │       └── [▸] → Explore: "Multi-Head Attention"         ← depth 2 (collapsed)
    │
    └── [▾] → Explore: "Positional Encoding"                  ← depth 1
            LLM response with inline concepts...

[▾] User prompt: "How does BERT differ from GPT?"             ← new root
    LLM response...
```

**Visual rules:**
- Each section is collapsible via a `▾`/`▸` toggle on its header
- Collapsed sections show only the concept title (one line)
- Indentation: ~16px per level, **capped at 3 visual levels** (deeper nesting still exists logically but renders at max indent)
- Section headers for auto-explored concepts show a `→` prefix and slightly lighter background to distinguish from manual prompts
- A subtle vertical line connects parent to children (like Reddit/HN threading)

**Breadcrumb context for LLM prompts:**
- Each explore action builds a breadcrumb path from the root to the current concept
- The path is included in the prompt: `"Context path: LLMs → Transformer Architecture → Self-Attention\nTell me more about: Self-Attention"`
- This disambiguates concepts without sending full parent response text

**Data model addition:**
- Each chat message/section needs a `parentId` field (null for root-level prompts)
- Each section stores its `breadcrumb` array of ancestor concept titles
- Rendering walks the tree depth-first

---

## Interaction Flow Summary

```
LLM Response with inline highlighted concepts
  │
  ├── Hover concept → Tooltip (title + description + Harvest/Explore)
  │     ├── Click "Harvest" → Inline harvest form → Publish to graph
  │     └── Click "Explore" → Indented child thread with breadcrumb context
  │
  ├── Click concept directly → Explore (same as above)
  │
  └── Select arbitrary text → Floating toolbar
        ├── "Harvest" → Inline harvest form → Publish to graph
        └── "Explore" → Follow-up prompt using selected text

Shared Graph (center panel)
  │
  └── Double-click node → New root-level exploration section in personal workspace
```

---

## Implementation Order

Recommended sequence for Claude Code:

1. **F1: Rename header** — trivial, do first
2. **F8: Threaded data model** — add `parentId` and `breadcrumb` fields to message model; restructure `appendChatResponse()` to render as tree. **Do this before F2** since inline highlighting renders within tree nodes.
3. **F2: Inline concept highlighting** — modify response rendering within tree nodes
4. **F3: Tooltips** — depends on F2's data attributes
5. **F6: Harvest inline form** — refactors existing harvest flow, needed by F4 and F5
6. **F4: Explore/follow-up** — depends on F2, F3, and F8 (creates child thread nodes)
7. **F5: Text selection actions** — independent, can be done in parallel with F3-F4
8. **F7: Double-click graph node** — depends on F8 (creates root-level thread); wire up after threading works

---

## CSS Classes to Add

| Class | Purpose |
|---|---|
| `.concept-inline` | Inline highlighted concept in response text |
| `.concept-inline:hover` | Hover state |
| `.concept-inline.harvested` | Already harvested state |
| `.concept-inline.explored` | Already expanded via follow-up |
| `.concept-tooltip` | Floating tooltip element |
| `.selection-toolbar` | Floating toolbar for text selection |
| `.harvest-inline-form` | Inline harvest form |
| `.auto-prompt` | Visual modifier for auto-generated user messages |
| `.thread-section` | A single thread node (contains prompt + response) |
| `.thread-section.depth-1` | First indent level |
| `.thread-section.depth-2` | Second indent level |
| `.thread-section.depth-3` | Third (max visual) indent level |
| `.thread-collapse-toggle` | The `▾`/`▸` button |
| `.thread-section.collapsed` | Collapsed state (shows title only) |
| `.thread-connector` | Vertical line connecting parent to children |
| `.thread-header` | Section header with concept title + provenance |
| `.thread-header.from-graph` | Provenance indicator for graph-originated threads |

---

## Deferred TODOs

- **Keyboard shortcuts** — `Enter` on focused concept → Explore; shortcut for harvest. Add after core features stabilize.
- **Dark mode** — CSS custom properties already in place (`var(--bg)`, etc.), so this is mostly a second theme definition. Low effort but low priority.
- **User list panel** — Clicking the "N users" indicator in the room bar opens a collapsible panel listing connected users (name + color dot). Useful for awareness in 30-person sessions.

---

## Open Questions

1. **Collapse-all / expand-all** — Should there be a button in the workspace header to collapse all threads to titles? This would give a quick outline view of all explorations. Potentially useful but possibly premature.
2. **Thread depth limit** — Cap at 3 visual levels is proposed. Should we also cap *logical* depth (e.g., max 5 levels)? Or let students go as deep as they want?
3. **Breadcrumb display** — Should the breadcrumb path be visible in the thread header (e.g., a subtle `LLMs → Transformers → Self-Attention` trail), or only used internally for the LLM prompt?