# Voronoi-Based Hierarchical Clustering — Design Specification

## Lodestar

> Automatic spatial clustering that turns a messy flat graph into a navigable hierarchy, without requiring students to manually organize anything.

The force-directed layout already encodes semantic proximity — connected nodes cluster spatially. This feature extracts that latent structure using Voronoi tessellation and hierarchical agglomerative clustering, then renders it as smooth blobs with LLM-generated labels. Students navigate the hierarchy by scrolling to change the dendrogram cut level, seeing the graph at whatever granularity suits their current task.

This replaces the deferred manual clustering system from `shared-graph-design.md`. Attribute-based layout is also superseded — spatial clustering from the force layout is the primary structural mechanism.

---

## Running Example

Continuing the 19th-century philosophers scenario: 80+ concepts have been harvested. The ForceAtlas2-style layout (F14) has pushed German Idealists together, Utilitarians together, Existentialists together. But the graph is still a hairball. This feature automatically identifies those spatial clusters, draws blobs around them, labels them ("German Idealism", "Utilitarianism", "Existentialism"), and lets students zoom the granularity — scroll down to split "German Idealism" into "Hegel's System" and "Schopenhauer's Pessimism", scroll up to merge "German Idealism" and "Existentialism" into "Continental Philosophy."

---

## Architectural Change: Server-Side Layout

### Problem

The Voronoi tessellation and cluster hierarchy must be shared across all clients so that cluster labels, blob boundaries, and aggregate edges are consistent. Currently, the force simulation runs independently on each client, producing different layouts for different users.

### Solution

Move the D3 force simulation to the server. The server becomes the authoritative source of node positions.

**Server responsibilities:**
- Run the D3 force simulation (pure math, no DOM — works in Node.js)
- Compute Voronoi tessellation from node positions
- Build the agglomerative clustering dendrogram
- Broadcast node positions and cluster hierarchy to all clients
- Accept pinning events (`fx`/`fy`) from clients and apply to simulation

**Client responsibilities:**
- Render nodes, edges, blobs from server-provided positions
- Handle local view state: zoom, pan, dendrogram cut level
- Send interaction events (drag/pin, harvest, connect) to server

**Position broadcast protocol:**
- On simulation tick (throttled to ~10 Hz during active simulation): emit `layout:update` with `{nodes: [{id, x, y}, ...], alpha}` to all clients in the room
- When simulation settles (alpha < 0.01): emit `layout:stable` with final positions + Voronoi + dendrogram data
- On node add/remove: restart simulation, broadcast updates until stable again

**Drag/pin interaction:**
- Client: on drag start, show optimistic local position update
- Client: emit `node:pin` with `{nodeId, x, y}` to server
- Server: set `fx`/`fy` on the node, simulation adjusts, broadcasts new positions
- Latency: expect 20–50ms on DigitalOcean; acceptable for drag operations
- If multiple users drag simultaneously, last-write-wins per node (each node has at most one dragger)

**Migration path:**
1. Add simulation runner to `server/index.js` (or a new `server/layout.js` module)
2. Strip simulation from `graph.js`, keep only rendering
3. Wire `layout:update` socket events to update node positions in the D3 rendering layer
4. Test with 2+ clients to verify consistency

---

## Voronoi Tessellation

### Computation

When the layout reaches stability (alpha < threshold), compute a Voronoi diagram using the node positions as sites.

**Library:** `d3-delaunay` (already a D3 dependency). Server-side:

```javascript
const {Delaunay} = require('d3-delaunay');
const delaunay = Delaunay.from(nodes, d => d.x, d => d.y);
const voronoi = delaunay.voronoi([xmin, ymin, xmax, ymax]);
```

The bounding box should match the layout bounding box (3× viewport from F14).

**Output:** For each node, the Voronoi cell vertices. These are used for:
1. Adjacency: two nodes are Voronoi-adjacent if their cells share an edge
2. Cell area: used as the merge criterion in clustering
3. (Not used for rendering — blobs replace raw Voronoi cells)

### Adjacency Graph

Build an adjacency graph from the Voronoi diagram: nodes `i` and `j` are adjacent if `voronoi.neighbors(i)` includes `j`. This adjacency is distinct from the concept graph's edges — it captures *spatial* proximity regardless of explicit connections.

---

## Hierarchical Agglomerative Clustering

### Algorithm

Standard bottom-up agglomerative clustering using Voronoi cell area as the merge criterion.

**Merge criterion:** At each step, find the pair of adjacent clusters whose merged Voronoi region has the smallest combined area. Merge them. Repeat until one cluster remains.

More precisely:
1. Initialize: each node is its own cluster
2. For each pair of adjacent clusters, compute the sum of Voronoi cell areas of all nodes in both clusters
3. Merge the pair with the smallest combined area
4. Update adjacency (merged cluster is adjacent to the union of neighbors of its constituents)
5. Record the merge in the dendrogram with the combined area as the merge distance
6. Repeat until one cluster remains

**Why area, not Euclidean distance:** In a dense region, many nodes are close together, so each has a small Voronoi cell. Clustering by combined area naturally identifies dense regions first. Peripheral nodes have large cells and merge later. This matches the Wordonoi behavior and is more robust than single-linkage on raw distance (which can chain through sparse regions).

**Computational cost:** O(n² log n) for n nodes. For n = 100, this is trivial (~ms). No optimization needed.

### Dendrogram Data Structure

```javascript
// Each internal node in the dendrogram
{
  id: "cluster_17",           // unique identifier
  children: ["cluster_12", "node_5"],  // two children (binary tree)
  mergeArea: 45000,           // combined Voronoi area at merge time
  nodeIds: ["n1", "n2", "n5", "n8"],  // all leaf node IDs in this cluster
  label: null,                // LLM-generated, filled lazily
  description: null           // LLM-generated, filled lazily
}
```

The dendrogram is a binary tree. Cutting it at a given area threshold produces a partition of all nodes into clusters.

### Dendrogram Cut

Given a threshold `t`, the cut produces clusters by walking the tree top-down: if an internal node's `mergeArea > t`, split it into its children; otherwise, keep it as a single cluster. Leaf nodes are always their own cluster (unless merged).

The threshold `t` maps to a continuous slider/scroll range. The range is `[minMergeArea, maxMergeArea]` from the dendrogram. Moving `t` from max to min progressively splits clusters.

---

## Cluster Rendering: Smooth Blobs

### Approach

For each cluster at the current cut level, render a smooth enclosing shape around its member nodes.

**Algorithm: Padded convex hull with cubic Bézier smoothing**

1. Compute the convex hull of the cluster's node positions
2. Push each hull vertex outward from the centroid by a padding radius (e.g., 40px)
3. Generate a closed cubic Bézier curve through the padded vertices using Catmull-Rom → Bézier conversion
4. Render as an SVG `<path>` with fill and stroke

For single-node clusters: render as a circle with radius = padding.
For two-node clusters: render as a stadium shape (rectangle with semicircle caps).

**Visual treatment:**

| Property | Value |
|---|---|
| Fill | Cluster color at 10% opacity |
| Stroke | Cluster color at 30% opacity, 1.5px |
| Stroke on hover | Cluster color at 60% opacity, 2px |
| Color palette | 8–12 distinct hues, assigned per top-level cluster and inherited by sub-clusters (lighter tints for deeper levels) |

**Z-order:** Blobs render behind all nodes and edges. Larger clusters (higher in dendrogram) render behind smaller ones.

### Concavity Concern

Convex hulls cannot represent C-shaped or L-shaped clusters. For the prototype, this is acceptable — ForceAtlas2 tends to produce roughly convex clusters. If concavity becomes a visible problem in testing, upgrade to alpha shapes (d3-delaunay can compute these).

---

## Cluster Labels

### Generation

When a cluster is first created (i.e., when a dendrogram cut first produces it), request a label from Haiku.

**Prompt:**
```
You are labeling a cluster of concepts in a collaborative knowledge graph.

Concepts in this cluster:
{list of concept titles}

{if parent cluster exists}
This cluster is a sub-group within "{parent_cluster_label}".
{/if}

Provide:
1. A concise label (2-4 words) that captures what these concepts have in common
2. A one-sentence description of the cluster's theme

Return JSON: {"label": "...", "description": "..."}
```

**Caching:** Cache labels by the sorted set of concept titles (joined, hashed). If the exact same set of concepts clusters together again (e.g., after a layout perturbation), reuse the cached label. If the set changes (node added/removed), invalidate and re-request.

**Hierarchy:** Sub-clusters include parent context in the prompt ("sub-group within X"), so labels become progressively more specific as you drill down. Example:
- Level 1: "19th-Century Philosophy"
- Level 2: "German Idealism" / "Utilitarianism" / "Existentialism"
- Level 3: "Hegelian Dialectics" / "Schopenhauer's Metaphysics"

### Rendering

- Label text centered on the cluster's centroid
- Font size scales with cluster area (larger clusters get larger text)
- When cluster is collapsed (not hovered): show label only, no individual nodes
- When cluster is hovered: label remains, individual nodes fade in, blob becomes semi-transparent
- Description appears in a tooltip on label hover

---

## Interaction Model

### Default State: Collapsed Clusters

At any dendrogram cut level, the graph shows:
- Blob shapes for each cluster, with labels
- Aggregate edges between clusters (see below)
- No individual concept nodes visible

This is the "zoomed out" view. It is clean and readable even with 80+ underlying concepts, because the display shows only 5–15 cluster blobs.

### Hover: Preview Cluster Contents

Hovering over a cluster blob:
1. Blob fill becomes more transparent (5% opacity)
2. Individual concept nodes within the cluster fade in (animated, 200ms)
3. Internal edges between those concepts become visible
4. Aggregate edges from this cluster to other clusters remain visible
5. Other clusters remain collapsed

This is a preview — the user can see what's inside without committing to an expansion. Moving the mouse away collapses the preview (200ms fade out).

### Click: Expand Cluster (Persistent)

Clicking a cluster blob expands it persistently:
1. Same visual treatment as hover, but it stays expanded
2. Full interaction with internal nodes: drag, right-click context menu, connect, etc.
3. Click the cluster background (outside any node) to collapse it back
4. Multiple clusters can be expanded simultaneously

### Scroll: Change Dendrogram Level

Mouse scroll (with `Alt` held, to avoid conflict with zoom) or a dedicated slider in the graph toolbar adjusts the dendrogram cut threshold globally.

**Scroll up (Alt+scroll up):** Increase threshold → fewer, larger clusters (merge)
**Scroll down (Alt+scroll down):** Decrease threshold → more, smaller clusters (split)

The transition is animated: blobs smoothly merge or split. When two clusters merge, their blobs morph into one (interpolate between the two shapes and the merged shape). When a cluster splits, the blob divides.

**Slider alternative:** A horizontal slider in the graph toolbar, labeled "Detail" with "Overview" on the left and "Detail" on the right. Dragging right increases granularity (more clusters). This provides a visible, discoverable control alongside the keyboard shortcut.

### Drag Node Out of Cluster

If a cluster is expanded (hovered or clicked), the user can drag a concept node out of its blob boundary. This should:
1. Remove the node from the current cluster
2. Recompute the dendrogram (or, simpler: the node becomes a singleton cluster)
3. The node remains at its new pinned position
4. On next layout stabilization, the Voronoi and dendrogram are recomputed from the new positions

This lets students correct clustering errors by physically moving concepts.

---

## Aggregate Cross-Cluster Edges

### Problem

When clusters are collapsed, individual edges between concepts in different clusters are invisible. The inter-cluster relationship information is lost.

### Solution

For each pair of clusters that have at least one edge between their member nodes, render a single aggregate edge.

**Visual properties:**
- Stroke width proportional to the number of constituent edges (e.g., `1 + log2(count)` px)
- Connects the centroids of the two cluster blobs
- Routed to avoid passing through other blobs where feasible (simple: use the shortest path that doesn't intersect other blob boundaries; fallback: straight line)

**Label:** Generated by Haiku, summarizing the constituent edge labels.

**Prompt:**
```
These edges connect concepts in cluster "{cluster_a_label}" to concepts in cluster "{cluster_b_label}":
{list of edge labels, e.g., "Hegel --influenced--> Marx", "Hegel --contemporary_of--> Schopenhauer"}

Summarize the relationship between these two clusters in 2-5 words.
Return JSON: {"label": "..."}
```

**Caching:** Cache by sorted pair of cluster IDs + sorted edge label set.

**On hover:** Expanding a cluster dissolves its aggregate edges into the constituent individual edges, anchored to specific nodes.

**Threshold:** If two clusters share only one edge, show it as a regular (non-aggregate) edge with its original label — no need for LLM summarization.

---

## Harvest into Collapsed Clusters

When a student harvests a concept and the graph is showing collapsed clusters:

1. The concept is added to the server's graph data
2. The server runs auto-connection (from shared-graph-design.md), placing the node near its connected neighbors
3. Layout simulation restarts; the new node settles into a spatial position
4. On stabilization, Voronoi and dendrogram are recomputed; the new node falls into a cluster
5. **Harvest feedback:** The receiving cluster blob briefly pulses (border glow, 0.5s) and shows a badge: "+1" in the contributor's assigned color, fading after 3 seconds
6. If the student hovers the cluster within ~5s, the newly added node is highlighted with a gold accent border among the revealed nodes, so the student can see where their contribution landed

**Rationale:** The core feedback problem ("I harvested something but I can't see where it went") is solved by the pulse + badge on the cluster blob. The gold highlight on hover is the detail-on-demand layer.

---

## Data Zoom (Deferred to Phase 2)

### Concept

Instead of a global dendrogram level, the cut threshold adapts to the viewport. Clusters in the center of the screen (where the user is focused) expand to show more detail; clusters at the periphery collapse. The total number of visible elements (nodes + cluster blobs) stays within a "visual concept budget."

### Why Defer

This is elegant but complex:
- Requires per-cluster cut threshold computation based on screen-space area
- Creates inconsistent granularity that may confuse collaborative awareness ("I see 5 clusters, you see 12")
- The budget allocation algorithm needs careful tuning

### Phase 2 Implementation Sketch

1. Compute the screen-space bounding box of each top-level cluster blob
2. Allocate a share of the total budget proportional to the screen area occupied by each cluster
3. For each cluster, determine the deepest dendrogram level that keeps its visible children within its allocated budget
4. Render each cluster at its allocated level
5. As the user pans/zooms, budgets shift, and cluster levels animate accordingly

---

## Recomputation Strategy

### When to Recompute

| Trigger | Recompute Voronoi | Recompute Dendrogram | Recompute Labels |
|---|---|---|---|
| Node added | On next stability | Yes | Affected clusters only |
| Node removed | On next stability | Yes | Affected clusters only |
| Node dragged (pinned) | On next stability | Yes | Only if cluster membership changes |
| Layout simulation settling | No (wait for stability) | No | No |
| Layout stable (alpha < 0.01) | Yes | Yes | Only new clusters |

### Stability Detection

The server monitors the simulation's alpha value. When alpha drops below 0.01 and stays there for 500ms, the layout is considered stable. At that point:
1. Compute Voronoi tessellation
2. Build agglomerative clustering dendrogram
3. Broadcast `clustering:update` event with the full dendrogram to all clients
4. Clients re-render blobs at their current cut level

During active simulation (alpha > 0.01), clients freeze the previous clustering and only update node positions. This prevents visual jitter in blob boundaries.

---

## Socket Events

### Server → Client

| Event | Payload | Trigger |
|---|---|---|
| `layout:update` | `{nodes: [{id, x, y}], alpha}` | Every ~100ms during simulation |
| `layout:stable` | `{nodes: [{id, x, y}]}` | Alpha < 0.01 for 500ms |
| `clustering:update` | `{dendrogram, voronoiCells}` | After layout:stable |
| `cluster:label` | `{clusterId, label, description}` | Haiku response for a cluster |
| `cluster:aggregateEdge` | `{clusterA, clusterB, label, count}` | Haiku response for aggregate edge |

### Client → Server

| Event | Payload | Trigger |
|---|---|---|
| `node:pin` | `{nodeId, x, y}` | User drags a node |
| `node:unpin` | `{nodeId}` | User double-clicks a pinned node |

Existing events (`node:add`, `node:remove`, `edge:add`, etc.) remain unchanged.

---

## Implementation Order

### Phase 1: Core (Target: Next Classroom Session)

1. **Server-side layout engine** — move D3 force simulation to server, broadcast positions, handle pinning
2. **Voronoi computation** — compute on layout stability, broadcast cell data
3. **Agglomerative clustering** — build dendrogram from Voronoi adjacency + area
4. **Blob rendering** — padded convex hull with Bézier smoothing on client
5. **Dendrogram slider/scroll** — global cut level control, blob merge/split animation
6. **Cluster labels** — Haiku calls, caching, rendering
7. **Hover preview / click expand** — show/hide internal nodes
8. **Aggregate edges** — compute, render, Haiku-label
9. **Harvest feedback** — pulse + badge on receiving cluster

### Phase 2: Refinement (Post-Classroom)

1. **Data zoom** — viewport-adaptive dendrogram level
2. **Blob morphing animation** — smooth transitions on cluster merge/split
3. **Drag-out-of-cluster** — manual cluster correction
4. **Concave blob shapes** — alpha shapes if convex hulls prove insufficient

---

## CSS Classes

| Class | Purpose |
|---|---|
| `.cluster-blob` | SVG path for cluster shape |
| `.cluster-blob:hover` | Increased stroke opacity on hover |
| `.cluster-blob.expanded` | Persistent expansion state |
| `.cluster-label` | Centered text label on cluster |
| `.cluster-label.large` | Larger font for top-level clusters |
| `.cluster-badge` | "+1" harvest notification badge |
| `.cluster-badge.fade-out` | 3s fade animation |
| `.cluster-node-highlight` | Gold accent on newly harvested node |
| `.aggregate-edge` | Inter-cluster edge with variable width |
| `.aggregate-edge-label` | Label for aggregate edges |
| `.dendrogram-slider` | Horizontal slider in graph toolbar |
| `.node.in-cluster-preview` | Node visible during cluster hover preview |

---

## Open Questions

1. **Alt+scroll vs. dedicated slider:** Alt+scroll is faster for power users but undiscoverable. The slider is visible but takes toolbar space. Implement both? Or just the slider for now?
2. **Cluster color assignment:** Should colors be stable across dendrogram levels (top-level cluster determines the hue family, sub-clusters use tints), or reassigned at each level? Stable colors provide continuity; reassignment optimizes distinguishability. Recommend stable.
3. **Minimum node count for Voronoi clustering:** The algorithm needs at least 3 nodes to produce meaningful Voronoi cells. For rooms with < 3 concepts, skip clustering entirely and show the flat graph. What about 3–5 nodes? Probably too few to cluster usefully. Suggest: enable clustering only when node count ≥ 8.
4. **Server CPU for large rooms:** The force simulation running server-side for multiple rooms simultaneously could become a bottleneck. Each room needs its own simulation. For 5–10 concurrent rooms with 80–100 nodes each, this should be fine on a DigitalOcean droplet. Monitor and optimize if needed.
5. **Cluster persistence vs. ephemeral:** Currently clusters are fully recomputed from layout positions. Should the server persist cluster assignments (so they survive server restarts)? Recommend: no — recompute on startup from persisted node positions. The clustering is derived data, not primary data.