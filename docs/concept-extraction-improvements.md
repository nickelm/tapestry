# Concept Extraction & Graph Awareness — Improvement Spec

Addendum to `docs/personal-workspace-improvements.md`.

---

## F9: Improved Concept Extraction

### Problem

The current extraction prompt returns too few concepts (typically 3-5). It captures the primary topic but misses secondary concepts — things *mentioned* in the response that are worth exploring. Example: in a response about "Attention Is All You Need," the model returns "self-attention" and "transformer" but not "BERT," "sequence-to-sequence," or "Vaswani et al."

### Solution: Two-Tier Extraction

Modify the LLM extraction prompt in `llm.js` to:

1. **Request more concepts** — ask for 8-12 per response
2. **Distinguish primary vs. secondary concepts:**
   - Primary: what the response is *about* (the main topic and its components)
   - Secondary: things *referenced* that could be explored independently
3. **Return titles only** — no descriptions in the initial extraction

**Updated prompt structure (for the concept extraction portion):**
```
Extract 8-12 concepts from your response. Include:
- Primary concepts: the main topics and components you explained
- Secondary concepts: related ideas, people, papers, or techniques mentioned but not fully explained

Return as a JSON array of objects: [{"title": "...", "type": "primary"}, ...]
Do NOT include descriptions — titles only.
```

**Visual distinction:**
- Primary concepts: green highlight (current `.concept-inline` style)
- Secondary concepts: slightly lighter green or dotted underline — visible but lower visual weight

### F9b: On-Demand Descriptions (Lazy Loading)

Currently, concept descriptions are generated alongside the chat response. Instead, fetch them lazily on first hover.

**Behavior:**
1. Initial response includes concept titles only (no descriptions)
2. When user hovers over a concept (triggering the F3 tooltip), check if description is cached
3. If not cached: show tooltip with title + a subtle loading indicator, fire a Haiku call:
   ```
   Given the context of a discussion about {breadcrumb_path}, provide a one-sentence
   description of the concept "{concept_title}".
   ```
4. Cache the description client-side (on the span's data attribute) so subsequent hovers are instant
5. If the Haiku call fails or times out (>2s), show "No description available"

**Cost impact:** Reduces per-response token usage significantly. Only concepts the student actually explores incur description cost. In practice, students hover on maybe 20-30% of concepts.

**Alternative (simpler, slightly more expensive):** Keep descriptions in the initial extraction but accept the token cost. This avoids the loading state UX. Choose based on how aggressively you want to control API costs.

---

## F10: Shared Graph Awareness (Concept Coloring)

### Problem

Students harvest concepts that already exist in the shared graph, creating duplicates. The current interface gives no visual signal that a concept is already present.

### Solution

When rendering inline concepts, check each title against the shared graph and color-code accordingly.

**Three states for inline concepts:**

| State | Background | Border | Tooltip behavior |
|---|---|---|---|
| **New** (not in graph) | `#f0fdf4` (light green) | `2px solid #86efac` | Shows Harvest + Explore buttons |
| **Exists in graph** | `#eff6ff` (light blue) | `2px solid #93c5fd` | Shows "In shared graph" + Explore button. Harvest button replaced with "View in graph" (pans/highlights the existing node) |
| **Harvested** (just published) | `#e2e8f0` (gray) | none | Shows checkmark, no actions |

**Implementation:**
1. Client maintains a `Set` of shared graph node titles, updated on every `node:added`, `node:removed`, `node:merged` socket event
2. When `appendChatResponse()` renders inline concepts, check each title against this set (case-insensitive exact match)
3. Apply `.concept-inline.in-graph` class for existing concepts
4. Tooltip for in-graph concepts shows the existing node's description (fetched from local graph state) and a "View in graph" button that pans the graph view to that node and briefly highlights it

**"View in graph" behavior:**
1. Click "View in graph" in tooltip
2. Graph pans/zooms to center the matching node
3. Node gets a brief highlight pulse animation (0.5s border glow, then fade)
4. If workspace panel is obscuring the graph, no auto-collapse — let the student manage their layout

**Fuzzy matching (defer):** Initially use exact case-insensitive title match. A later enhancement could use Levenshtein distance or embedding similarity to catch near-matches (e.g., "Self-Attention" vs. "Self-Attention Mechanism"). Flag this as a TODO.

---

## CSS Classes to Add

| Class | Purpose |
|---|---|
| `.concept-inline.secondary` | Lower visual weight for secondary concepts |
| `.concept-inline.in-graph` | Blue highlight for concepts already in shared graph |
| `.concept-inline .loading-dot` | Subtle loading indicator in tooltip during description fetch |
| `.node-highlight-pulse` | Brief glow animation on graph node when "View in graph" is clicked |

---

## Implementation Order

These features are independent of F1-F8 except for F10 depending on F2 (inline highlighting).

1. **F9: Extraction prompt tuning** — modify `llm.js` prompt only, no frontend changes
2. **F9b: Lazy descriptions** — modify tooltip (F3) to handle missing descriptions, add Haiku call
3. **F10: Shared graph awareness** — add title index, modify `appendChatResponse()`, add CSS states

---

## Claude Code Prompts

### Prompt for F9:

> Read `docs/concept-extraction-improvements.md`, section F9. Modify the concept extraction prompt in `llm.js` to request 8-12 concepts per response, classified as "primary" or "secondary". Return titles only, no descriptions. Update the JSON parsing in the chat response handler to accept the new format. In `app.js`, pass the `type` field through to `appendChatResponse()` so inline highlights can distinguish primary from secondary concepts. Add `.concept-inline.secondary` CSS with a lighter visual treatment (dotted underline instead of solid, slightly more transparent background).

### Prompt for F9b:

> Read `docs/concept-extraction-improvements.md`, section F9b. Modify the F3 tooltip behavior so that when a concept has no cached description, hovering triggers a Haiku API call to fetch a one-sentence description. Add a new socket event or REST endpoint `POST /api/rooms/:id/describe-concept` that accepts `{title, breadcrumb}` and returns `{description}` via a Haiku call. In the tooltip, show a subtle loading state while waiting, then cache the result on the span's `data-concept-description` attribute. Timeout after 2 seconds with fallback text.

### Prompt for F10:

> Read `docs/concept-extraction-improvements.md`, section F10. In `app.js`, maintain a `Set` of shared graph node titles (lowercase), updated on `node:added`, `node:removed`, and `node:merged` socket events. When rendering inline concepts in `appendChatResponse()`, check each title against this set. Apply `.concept-inline.in-graph` class (blue highlight) for matches. Modify the tooltip for in-graph concepts: show the existing node's description, replace Harvest with "View in graph" button. The View button should call a method on the TapestryGraph class that pans to and briefly highlights the matching node. Add `.node-highlight-pulse` CSS animation. Add all new CSS classes to `style.css`.