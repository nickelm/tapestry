# Graph Readability & Layout Improvements — Implementation Spec

Target: Thursday classroom deployment (3 days).

## Context

First classroom study (22–24 students) produced a graph with 80+ concepts. The force-directed layout resulted in a dense, unreadable core with orphan nodes scattered far from center. Primary problem is node density, not edge density. This spec addresses readability through three independent features: interactive highlighting, a search field, and an improved layout algorithm.

All changes are in `public/js/graph.js` (TapestryGraph class), `public/js/app.js`, and `public/css/style.css`. No database schema changes. No server changes except for one LLM prompt modification (F13).

---

## F11: Node & Edge Highlighting with Dimming

### Problem

In a dense graph, hovering a node or edge gives no visual context. Users cannot see a node's local neighborhood without mentally tracing edges through overlapping labels.

### Behavior

**Node hover:**
1. User hovers over a node
2. The hovered node and all nodes directly connected to it (1-hop neighbors) remain at full opacity
3. All edges connecting the hovered node to its neighbors remain at full opacity, with labels visible
4. All other nodes dim to 15% opacity
5. All other edges dim to 8% opacity
6. On mouse leave, full opacity restores (with a fast 150ms transition so it doesn't feel laggy)

**Edge hover:**
1. User hovers over an edge (the line or its label)
2. The hovered edge moves to the top of the SVG z-order (re-append the edge group element so it renders last)
3. The edge and its label render at full opacity with a subtle highlight (e.g., edge stroke becomes `#2563eb`, label background becomes `#dbeafe`)
4. The two nodes connected by this edge remain at full opacity
5. All other nodes and edges dim (same opacity values as node hover)
6. **The z-order change is permanent** — the last-hovered edge stays on top until another edge is hovered. This lets users "rifle through" overlapping edges by hovering each in sequence.

**Edge label readability improvement:**
- Edge labels currently render inline on the path. In the dimmed state, ensure non-highlighted edge labels are hidden entirely (not just dimmed), to reduce visual noise.
- Highlighted edge labels get a white background rectangle (pill shape) behind the text for contrast.

### Implementation Notes

- Use CSS classes `.dimmed` on nodes and edges, applied/removed via D3 selections
- The dimming should be applied to the SVG group elements (`<g>` for each node, `<g>` for each edge)
- Use `pointer-events: none` on dimmed elements to prevent hover conflicts in the dense core
- For z-reorder on edge hover: `this.parentNode.appendChild(this)` or equivalent D3 `.raise()` call
- Transition: `opacity 150ms ease-out`

### CSS Classes

| Class | Target | Effect |
|---|---|---|
| `.dimmed` | Node `<g>` and edge `<g>` | `opacity: 0.15` for nodes, `opacity: 0.08` for edges |
| `.edge-highlighted` | Edge `<g>` | Stroke color `#2563eb`, label background `#dbeafe` |
| `.edge-label-bg` | `<rect>` behind edge label text | White fill, rounded corners, only visible on highlighted edges |

---

## F12: Interactive Search Field

### Problem

With 80+ nodes, finding a specific concept requires visual scanning of the entire canvas. Students need to locate concepts by name.

### Behavior

1. A search input field sits in the **graph panel toolbar** (top of the center panel, above the graph canvas). Compact: ~200px wide, with a magnifying glass icon and a clear button.
2. As the user types, matching is performed **live** against all node titles (case-insensitive substring match).
3. **Matching nodes** remain at full opacity. **Non-matching nodes** dim (same `.dimmed` treatment as F11).
4. **Edges between two matching nodes** remain visible. All other edges dim.
5. If only one node matches, the graph **pans and zooms** to center that node with comfortable padding.
6. If 2–5 nodes match, the graph pans/zooms to fit all of them in view.
7. If >5 nodes match, dim non-matches but don't auto-pan (too disorienting).
8. When the search field is cleared (or emptied), all dimming removes and the view stays where it is.
9. **Keyboard shortcut**: `Ctrl+F` or `Cmd+F` focuses the search field. `Escape` clears and unfocuses it.

### Interaction with F11

- Search dimming and hover dimming can coexist: if search is active and the user hovers a node, the hover highlight applies within the search-filtered set. That is, non-matching nodes stay dimmed regardless of hover, but matching nodes respond to hover normally.
- If search is active, hovering a matching node dims other matching nodes (not already dimmed by search) to show local neighborhood within the search results.

### Implementation Notes

- Add search input to `index.html` in the graph panel header area
- The search state is **personal** (not shared via socket)
- Filter logic runs on every `input` event, debounced to 50ms
- Pan/zoom uses D3's zoom transform: `svg.transition().duration(300).call(zoom.transform, newTransform)`
- Store the pre-search zoom transform so the user can return to it (optional, nice-to-have)

### HTML Addition

```html
<div class="graph-search-container">
  <span class="graph-search-icon">🔍</span>
  <input type="text" class="graph-search-input" placeholder="Search concepts..." />
  <button class="graph-search-clear" title="Clear search">✕</button>
</div>
```

### CSS Classes

| Class | Purpose |
|---|---|
| `.graph-search-container` | Flex row container in toolbar, subtle border, rounded |
| `.graph-search-input` | Text input, no border, clean styling |
| `.graph-search-clear` | Small clear button, hidden when input is empty |
| `.graph-search-active` | Applied to graph container when search has text, prevents other dimming conflicts |

---

## F13: Improved Similarity Detection on Harvest

### Problem

The current similarity detection prompt treats "related" as "same." An F-18 is flagged as a duplicate of an F-16. Students see false merge suggestions for concepts that are distinct but thematically related.

### Solution

Modify the similarity detection Haiku call in `llm.js` to distinguish three relationship types.

**Updated prompt structure:**

```
You are comparing a new concept against existing concepts in a shared knowledge graph.

New concept: "{title}" — {description}

Existing concepts:
{list of existing node titles}

Classify relationships between the new concept and existing concepts into exactly three categories:

1. DUPLICATES: Existing concepts that are the same thing as the new concept, just worded differently. These should be merged.
2. RELATED: Existing concepts that are distinct but closely related (same category, similar role, sibling concepts). These are NOT duplicates.
3. BROADER: Existing concepts that are a parent category or generalization of the new concept.

Return JSON:
{
  "duplicates": [{"title": "...", "reason": "..."}],
  "related": [{"title": "...", "relationship": "..."}],
  "broader": [{"title": "...", "relationship": "..."}]
}

Be conservative with duplicates. Two things of the same type (e.g., two different aircraft, two different philosophers) are RELATED, not duplicates. Only flag true duplicates where the concepts refer to the same entity or idea.
```

**Client-side behavior changes:**

- **Duplicates**: show merge suggestion UI as currently implemented (but now it should trigger less often and more accurately)
- **Related**: no automatic action. Store the relationship data for potential use by auto-connection on harvest (see `shared-graph-design.md`). Optionally show a subtle indicator: "3 related concepts in graph" in the harvest confirmation, non-blocking.
- **Broader**: suggest as a parent connection. If the user confirms harvest, propose a directed edge from the new concept to the broader concept (e.g., "F-18 → is a → 4th generation fighter").

**Fallback:** If the LLM returns empty arrays for all three categories, proceed with harvest normally (no suggestions).

### Server Changes

- Modify the similarity detection function in `llm.js` (update prompt and response parsing)
- Update the socket event handler that processes similarity results to emit the new three-category structure
- Client-side handler in `app.js` needs to parse the new format

---

## F14: ForceAtlas2-Style Layout

### Problem

D3's default force layout uses charge repulsion (Barnes-Hut n-body, proportional to 1/d²) and spring-like link forces. This produces uniform node distribution that obscures community structure. Orphan or weakly-connected nodes fly to the canvas periphery with nothing pulling them back.

### Solution

Replace the default D3 force parameters with a ForceAtlas2-inspired configuration. ForceAtlas2 (Jacomy et al., 2014) is the standard layout in Gephi and is designed for exactly this use case: medium-scale graphs (50–500 nodes) where revealing community structure matters.

We do **not** need to implement the full ForceAtlas2 algorithm. Instead, we tune D3's existing force simulation to approximate its key behaviors:

### Key Changes to Force Simulation

**1. Gravity force (prevents orphan drift)**

Add a custom force that pulls all nodes toward the canvas center with strength proportional to their distance from center. This replaces D3's `forceCenter` (which only shifts the center of mass, not individual nodes).

```javascript
// Custom gravity force
function forceGravity(center, strength) {
  let nodes;
  function force(alpha) {
    for (const node of nodes) {
      const dx = center.x - node.x;
      const dy = center.y - node.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        const k = strength * alpha * dist * 0.01;
        node.vx += dx / dist * k;
        node.vy += dy / dist * k;
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}
```

Strength scales with distance — nodes far from center feel a stronger pull. This keeps orphans in the visual field without distorting the dense core. Suggested initial strength: `0.5`. Tune by testing.

**2. LinLog-style attraction (tighter clusters)**

D3's default link force uses a spring model. LinLog uses logarithmic attraction: `F_attract = log(1 + d)` where `d` is the distance between linked nodes. This produces tighter clusters with more whitespace between them.

Approximate this by using D3's link force with higher strength and shorter distance:

```javascript
simulation.force("link", d3.forceLink(edges)
  .id(d => d.id)
  .distance(60)       // shorter than current default (probably 100-200)
  .strength(1.5)      // stronger pull between connected nodes
  .iterations(2)      // more iterations per tick for stability
);
```

The exact values need testing against the real data. The principle: connected nodes should cluster tightly, and the whitespace between clusters should be large enough to see group boundaries.

**3. Overlap prevention**

Add D3's `forceCollide` with a radius slightly larger than the node visual radius:

```javascript
simulation.force("collide", d3.forceCollide()
  .radius(d => getNodeRadius(d) + 8)  // 8px padding
  .strength(0.7)
  .iterations(2)
);
```

This prevents nodes from overlapping in the dense core, which is a major readability issue in the screenshot.

**4. Reduced charge repulsion**

Lower the charge force magnitude. ForceAtlas2's repulsion is weaker than D3's default, relying instead on collision prevention for spacing:

```javascript
simulation.force("charge", d3.forceManyBody()
  .strength(-150)        // weaker than D3 default of -30 (note: more negative = stronger)
  .distanceMax(300)      // limit repulsion range so distant nodes don't repel
);
```

Wait — D3's default `forceManyBody` strength is -30 per node. If the current value is much stronger (e.g., -300), that's what's launching orphans into space. Check the current value in `graph.js` and reduce it. The `distanceMax` cap is critical: it means nodes beyond 300px don't repel each other at all, which prevents the long-range scattering.

**5. Bounding box constraint**

Add a force (or a post-tick position clamp) that keeps all nodes within a reasonable rectangle:

```javascript
// In the tick handler, after position updates:
const padding = 50;
const bounds = { 
  x: -width * 1.5, 
  y: -height * 1.5, 
  w: width * 3, 
  h: height * 3 
};
for (const node of nodes) {
  node.x = Math.max(bounds.x + padding, Math.min(bounds.x + bounds.w - padding, node.x));
  node.y = Math.max(bounds.y + padding, Math.min(bounds.y + bounds.h - padding, node.y));
}
```

This is a hard clamp — nodes cannot leave the bounding box. Set the box to ~3x the viewport so there's room to spread but not infinitely.

### Implementation Approach

1. Read the current force simulation setup in `graph.js`
2. Replace/modify the force configuration with the parameters above
3. Add the custom gravity force function
4. Add forceCollide
5. Tune `distanceMax` on charge force
6. Add bounding box clamp in the tick handler
7. **Test with realistic data**: either replay the data from today's study (if logged) or seed a room with 80+ concepts and edges

### Important: Preserve Pinning

The current system allows users to pin nodes by dragging. Pinned nodes have `fx`/`fy` set. The new forces must not override pinned positions. D3 handles this natively — pinned nodes are fixed during simulation — but verify that the bounding box clamp doesn't interfere with `fx`/`fy`.

### Layout Parameters (Personal, Not Shared)

These values should be configurable for testing but do not need UI controls for Thursday. Hard-code reasonable defaults. If time permits, add a small "Layout settings" panel accessible from the graph toolbar (gear icon) with sliders for:

- Gravity strength
- Cluster tightness (link distance)
- Repulsion strength

This is a nice-to-have, not required for Thursday.

---

## Implementation Order for Claude Code

These features are independent and can be implemented in any order. Recommended sequence:

1. **F14: ForceAtlas2-style layout** — do first because it changes the simulation setup, and all other features need to work with the new layout. Requires reading and modifying the force simulation in `graph.js`.
2. **F11: Highlighting with dimming** — modifies the node/edge rendering and hover handlers in `graph.js`.
3. **F12: Search field** — adds HTML, CSS, and JS. Depends on the dimming mechanism from F11 (reuses `.dimmed` class).
4. **F13: Improved similarity detection** — modifies `llm.js` prompt and `app.js` socket handlers. Independent of the graph rendering changes.

---

## Claude Code Prompts

### Prompt for F14:

> Read `docs/graph-readability-improvements.md`, section F14. Modify the force simulation setup in `public/js/graph.js` to improve layout for dense graphs (80+ nodes). Make these changes: (1) Add a custom gravity force that pulls nodes toward canvas center with strength proportional to distance — see the `forceGravity` function in the spec. (2) Increase link force strength and decrease link distance to produce tighter clusters. (3) Add `forceCollide` with radius = node visual radius + 8px padding. (4) Reduce `forceManyBody` strength and add `distanceMax(300)` to prevent long-range repulsion from scattering orphan nodes. (5) Add a bounding box position clamp in the tick handler to keep all nodes within 3x the viewport dimensions. Preserve existing node pinning behavior (fx/fy). Test that the simulation stabilizes and that pinned nodes are not affected by the bounding box clamp.

### Prompt for F11:

> Read `docs/graph-readability-improvements.md`, section F11. Add hover-based highlighting to the graph in `public/js/graph.js`. On node hover: keep the hovered node and its 1-hop neighbors at full opacity, dim all other nodes to 15% opacity and all other edges to 8% opacity. On edge hover: bring the edge to top z-order using D3's `.raise()`, highlight it with blue stroke (#2563eb), keep its two endpoint nodes at full opacity, dim everything else. Make the edge z-reorder permanent (last-hovered stays on top). Add white background rectangles behind edge labels for highlighted edges. On mouse leave (from both node and edge), restore full opacity with a 150ms CSS transition. Add `.dimmed` and `.edge-highlighted` CSS classes to `style.css`. Use `pointer-events: none` on dimmed elements to prevent hover interference in dense areas.

### Prompt for F12:

> Read `docs/graph-readability-improvements.md`, section F12. Add a search field to the graph panel. In `index.html`, add a search input in the graph panel header with a magnifying glass icon and clear button. In `app.js` or `graph.js`, on every input event (debounced 50ms), perform case-insensitive substring matching against all node titles. Dim non-matching nodes and edges using the `.dimmed` class from F11. If exactly one node matches, pan and zoom the graph to center it. If 2–5 match, zoom to fit them all. If >5 match, dim non-matches but don't pan. Clear button removes all search dimming. Add `Ctrl+F`/`Cmd+F` keyboard shortcut to focus the search field, `Escape` to clear and unfocus. Search state is purely client-side, not shared via socket. Add `.graph-search-container`, `.graph-search-input`, `.graph-search-clear` CSS classes.

### Prompt for F13:

> Read `docs/graph-readability-improvements.md`, section F13. Modify the similarity detection prompt in `server/llm.js` to distinguish three relationship types: duplicates (same concept, different wording — merge candidates), related (distinct but thematically close — NOT duplicates), and broader (parent category). Update the prompt to explicitly instruct the LLM to be conservative with duplicates: two things of the same type are related, not duplicates. Update the response parsing to expect the new JSON format `{duplicates: [...], related: [...], broader: [...]}`. In the socket event handler in `server/index.js` and client handler in `public/js/app.js`, update the similarity result processing: show merge UI only for duplicates, show a non-blocking "N related concepts" indicator for related, and propose a directed parent edge for broader concepts. If all arrays are empty, proceed with harvest normally.

---

## Verification Checklist

After implementation, verify:

- [ ] Orphan nodes (0-1 edges) stay within the visible canvas area
- [ ] Dense clusters are tighter than before, with visible whitespace between groups  
- [ ] Hovering a node dims non-neighbors; hovering an edge brings it to top z-order
- [ ] Edge z-reorder persists after mouse leave
- [ ] Search field filters nodes live; single match triggers pan-zoom
- [ ] Ctrl+F focuses search; Escape clears
- [ ] Similarity detection does not flag F-16 and F-18 (or similar distinct-but-related pairs) as duplicates
- [ ] Pinned nodes are unaffected by gravity force and bounding box clamp
- [ ] All features work with 80+ nodes (test with seeded data)