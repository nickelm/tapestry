# PDF Seeding & Paper-on-Canvas — Implementation Spec

Replaces earlier draft specs. Single consolidated document.

---

## Overview

An instructor uploads a research paper (PDF or pasted text) when creating a room. The system extracts concepts and relationships from the paper, seeds them into the shared graph, and renders the paper itself as a zoomable thumbnail on the graph canvas. Students see the paper as a central reference object with seed concepts arranged around it.

---

## Design Decisions

1. **Instructor-only action.** PDF attachment happens at room creation (or room edit). Students cannot upload papers.
2. **Paper is a fixed canvas object.** It renders at the origin of the zoomable graph space, pinned in place. It zooms and pans with the canvas like any other element. The instructor can reposition it; students cannot.
3. **Page navigation is local.** Each student flips pages independently. No socket events for page changes.
4. **Seed concepts radiate outward.** Extracted concepts are initially positioned in a ring around the paper, not scattered randomly by the force layout.
5. **No edges to the paper node.** Radial positioning communicates provenance spatially. Drawing 30+ edges to a central point recreates the hairball problem.
6. **Edges terminate at the paper boundary.** The paper node has a collision radius matching its visual rectangle. Any edge routed toward or near the paper stops at the rectangle edge, not the center point.
7. **HTML overlay, not foreignObject.** Render the paper as an absolutely-positioned `<div>` with a `<canvas>` (pdf.js) inside, manually transformed to track SVG zoom/pan. More reliable across browsers than `<foreignObject>`.

---

## F15: PDF Attachment and Concept Extraction

### Room Creation Flow

The room creation form gains an optional paper attachment section:

```
┌─────────────────────────────────────────┐
│  Create Room                            │
│                                         │
│  Room Name: [________________________]  │
│                                         │
│  Attach Paper (optional)                │
│  [Choose PDF...] or paste text below    │
│  ┌───────────────────────────────────┐  │
│  │ Paste paper text here...          │  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ☑ Extract seed concepts automatically  │
│                                         │
│  [Cancel]              [Create Room →]  │
└─────────────────────────────────────────┘
```

- PDF upload and text paste are mutually exclusive inputs
- "Extract seed concepts" checkbox defaults to checked
- If checked, extraction runs after room creation with a progress indicator
- If unchecked, the paper is attached for reference but no concepts are seeded

**Also:** Remove the time limit field from room creation. That was a user study concern, not a core feature.

### Room Settings (Admin)

Admin can access room settings to attach a paper post-creation, or replace an existing one. Removing an attached paper does not remove seed concepts already in the graph.

### Text Extraction

Use **pdf-parse** (npm) server-side to extract text from uploaded PDFs. If the PDF is image-based (no extractable text), show an error suggesting the instructor paste text manually.

### Two-Pass LLM Extraction

**Pass 1 — Skeleton (Sonnet):**

```
You are extracting the conceptual structure from an academic paper.

Paper text:
{first 8000 tokens of paper text}

Extract the 8-15 most important concepts from this paper. For each concept:
- title: concise name (2-5 words)
- description: one sentence explaining this concept in the paper's context
- type: one of [Entity, Concept, Method, Artifact, Event, Property]

Also identify 5-10 key relationships between concepts:
- source: title of source concept
- target: title of target concept  
- label: relationship description (2-4 words)
- directed: true if directional, false if symmetric

Return JSON:
{
  "paperTitle": "...",
  "paperAuthors": "...",
  "concepts": [...],
  "relationships": [...]
}

Focus on this paper's contributions, methods, and findings — not generic 
background concepts.
```

**Pass 2 — Detail (Sonnet):**

```
You previously extracted these primary concepts from a paper:
{list of Pass 1 concept titles with descriptions}

Here is the full paper text:
{full paper text}

For each primary concept, extract 2-4 secondary concepts specifically 
discussed in connection with it — techniques, datasets, metrics, sub-components, 
or related work unique to this paper.

For each secondary concept:
- title: concise name (2-5 words)
- description: one sentence
- type: one of [Entity, Concept, Method, Artifact, Event, Property]
- parentConcept: which primary concept this relates to
- relationship: how it relates to the parent (2-4 word label)

Return JSON:
{
  "secondaryConcepts": [...]
}
```

### Seeding Logic

After extraction and instructor confirmation:

1. Create primary concept nodes, positioned on an inner ring (radius ~300px from canvas origin)
2. Create secondary concept nodes on an outer ring (radius ~500px), angularly near their parent
3. Create edges between primary concepts (from Pass 1 relationships)
4. Create edges from secondary to parent concepts (from Pass 2)
5. Mark all nodes and edges with `source: 'pdf-seed'` in provenance
6. Force simulation takes over and refines the layout from these initial positions

### Token Budget

~8000 tokens input + ~1000 output for Pass 1, ~10000 + ~2000 for Pass 2. Roughly $0.05–0.10 per paper with Sonnet. One-time cost per room.

---

## F16: Seed Preview and Editing

Before committing to the graph, the instructor sees extracted concepts in a review modal.

```
┌─────────────────────────────────────────────┐
│  Extracted from: "Attention Is All You Need"│
│  Vaswani et al., 2017                       │
│                                             │
│  Primary Concepts (12)                      │
│  ☑ ● Transformer Architecture               │
│  ☑ ● Self-Attention Mechanism                │
│  ☑ ● Multi-Head Attention                    │
│  ☐ ● Encoder-Decoder Structure   [removed]   │
│  ...                                        │
│                                             │
│  Secondary Concepts (28)                    │
│  ☑ ● Scaled Dot-Product → Self-Attention     │
│  ☑ ● Positional Encoding → Transformer       │
│  ...                                        │
│                                             │
│  Relationships (15)                         │
│  ☑ Multi-Head Attention → composes →         │
│    Self-Attention                            │
│  ...                                        │
│                                             │
│  [Cancel]              [Seed Graph →]       │
└─────────────────────────────────────────────┘
```

- Checkboxes to include/exclude concepts and relationships
- Concept titles editable inline (click to edit)
- Colored dots indicate concept type
- "Seed Graph" commits checked items via the existing seed mechanism

This is a review step. Quick scan, deselect obvious junk, confirm.

---

## F17: Paper Node on Canvas

### Rendering

The paper renders as an absolutely-positioned `<div>` overlay, transformed to track the SVG zoom/pan. It contains:

1. **Paper title** above the thumbnail
2. **Page thumbnail** via pdf.js rendering to a `<canvas>` element
3. **Page navigation** bar at the bottom: `◀  3 / 12  ▶`

Default size: ~280×360px (A4 proportions). At default zoom, headings and figure placements are visible. Zooming in 2–3x makes body text readable.

### Position and Physics

- Pinned at canvas origin (0, 0) by default
- Instructor (admin) can drag to reposition. Students cannot.
- The paper node registers as a collision body in the force simulation with a rectangular collision zone matching its visual bounds. Concept nodes are repelled from it.
- Edges routed near the paper terminate at its boundary. If full rectangular edge clipping is too complex, the collision force pushing nodes away is sufficient — edges will naturally not cross the paper if no nodes are behind it.

### Page Navigation

- `◀` / `▶` buttons change pages. Client-side only, no socket events.
- Pre-render current page ± 1 for instant navigation.
- Default: page 1 on room join.

### PDF Loading

1. On room join, if room has an attached paper, client fetches the PDF via `GET /api/rooms/:id/paper`
2. pdf.js loads the file client-side
3. Page 1 renders into the overlay canvas
4. Loading state: placeholder rectangle with spinner until first page renders

### Zoom/Pan Synchronization

The overlay `<div>` tracks the SVG zoom transform. On every zoom/pan event:

```javascript
// pseudocode
const transform = d3.zoomTransform(svgElement);
paperDiv.style.transform = 
  `translate(${transform.x + paperX * transform.k}px, 
             ${transform.y + paperY * transform.k}px) 
   scale(${transform.k})`;
paperDiv.style.transformOrigin = '0 0';
```

### Double-Click Behavior

Double-clicking the paper node opens the PDF in a new browser tab (native PDF viewer). Does NOT trigger the personal workspace exploration flow.

---

## Chat Context Integration

When a room has an attached paper, prepend to the chat system prompt:

```
This room is discussing the paper "{paperTitle}" by {paperAuthors}.
Key concepts from the paper: {comma-separated seed concept titles}.
```

Do NOT include full paper text in chat calls. The title + concept list (~200 tokens) is sufficient grounding.

---

## Server Changes

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/rooms` | Modified | Accept optional `paper` file in multipart form |
| `POST /api/rooms/:id/paper` | New | Attach/replace paper on existing room |
| `GET /api/rooms/:id/paper` | New | Serve the PDF file |
| `POST /api/rooms/:id/extract-concepts` | New | Trigger two-pass extraction, return results |

### File Storage

Store PDFs in `./uploads/papers/{roomId}.pdf`. One paper per room.

### Database Changes

Add to `rooms` table:
- `paper_title TEXT`
- `paper_authors TEXT`
- `paper_filename TEXT` (original filename)
- `has_paper INTEGER DEFAULT 0`

Remove `duration_minutes` or any time-limit field from rooms table and creation form if present.

### Dependencies

- `pdf-parse` — PDF text extraction (server)
- `multer` — multipart file upload handling (server)
- `pdf.js` — client-side PDF rendering (CDN, no npm install)

---

## Scope

| Feature | Status |
|---|---|
| PDF upload at room creation | **In scope** |
| Paste-based text input (fallback) | **In scope** |
| Two-pass concept extraction | **In scope** |
| Preview/edit before seeding | **In scope** |
| Paper thumbnail on canvas (pdf.js) | **In scope** |
| Local page navigation | **In scope** |
| Radial seed concept positioning | **In scope** |
| Chat context with paper title + concepts | **In scope** |
| Room settings paper management | **In scope** |
| Remove time limit from room creation | **In scope** |
| Embedded multi-page reader panel | **Deferred** |
| Multiple papers per room | **Deferred** |
| Citation extraction from paper | **Deferred** |
| Student-initiated upload | **Out of scope** |
| Scanned PDF / OCR support | **Out of scope** |

---

## Implementation Order

1. **Server: file upload + text extraction** — multer, pdf-parse, store PDF, extract text, database fields
2. **Server: extraction pipeline** — `extractConceptsFromPaper()` in llm.js, two-pass prompts, JSON parsing
3. **Client: room creation form** — add paper upload field, paste fallback, remove time limit field
4. **Client: preview modal** — show extracted concepts with checkboxes, confirm to seed
5. **Client: paper canvas node** — pdf.js rendering in overlay div, zoom/pan sync, page navigation
6. **Client: radial seed positioning** — initial ring layout around paper node
7. **Integration: chat context** — prepend paper info to system prompt

---

## Claude Code Prompts

### Prompt 1 (Server foundation):

> Read `docs/pdf-seeding-spec.md`. Install `pdf-parse` and `multer`. Add a `multer` upload middleware for single PDF files (field name `paper`, max 20MB, stored to `./uploads/papers/`). Modify `POST /api/rooms` to accept multipart form data: `name` (text field) and optional `paper` (file field). When a paper is uploaded, extract text via pdf-parse, store the file as `./uploads/papers/{roomId}.pdf`, and set `paper_title`, `paper_filename`, `has_paper=1` on the room record. Add columns `paper_title TEXT`, `paper_authors TEXT`, `paper_filename TEXT`, `has_paper INTEGER DEFAULT 0` to the rooms table. Add `GET /api/rooms/:id/paper` to serve the stored PDF with `Content-Type: application/pdf`. Add `POST /api/rooms/:id/paper` for attaching a paper to an existing room (same logic). Also remove any `duration_minutes` or time-limit field from the rooms table and room creation if present.

### Prompt 2 (Extraction pipeline):

> Read `docs/pdf-seeding-spec.md`, the Two-Pass LLM Extraction section. Add `extractConceptsFromPaper(text)` to `server/llm.js`. Pass 1 sends the first 8000 tokens to Sonnet, requesting 8-15 primary concepts with titles, descriptions, types, plus 5-10 relationships. Pass 2 sends the primary concept list plus full paper text, requesting 2-4 secondary concepts per primary. Combine results into `{paperTitle, paperAuthors, concepts: [{title, description, type, tier, parentConcept?}], relationships: [{source, target, label, directed}]}`. Handle JSON parse errors with one retry. Add endpoint `POST /api/rooms/:id/extract-concepts` that reads the stored paper text and runs this pipeline, returning the combined result.

### Prompt 3 (Room creation UI):

> Read `docs/pdf-seeding-spec.md`, Room Creation Flow section. Modify the room creation form in `index.html` and `app.js` to include an optional paper attachment section. Add a file input for PDF upload and a textarea for paste-based text input — make them mutually exclusive (selecting one clears/disables the other). Add a checkbox "Extract seed concepts automatically" (default checked). When the form submits, send as multipart form data if a PDF is attached, or include the pasted text in the JSON body. Remove any time limit / duration field from the form. After room creation, if extraction is checked, call `POST /api/rooms/:id/extract-concepts` and show a progress indicator.

### Prompt 4 (Preview modal):

> Read `docs/pdf-seeding-spec.md`, F16 section. After `extract-concepts` returns results, display a modal showing the extracted concepts and relationships. List primary concepts first (with colored type dots and checkboxes), then secondary concepts grouped under their parent primary concept. Show relationships as "source → label → target" with checkboxes. Concept titles should be editable inline (click to edit, Enter to confirm). A "Seed Graph" button collects all checked concepts and relationships, then calls `POST /api/rooms/:id/seed` with the concept list, followed by edge creation for each checked relationship. Style the modal cleanly — it's an admin tool, not student-facing.

### Prompt 5 (Paper canvas node):

> Read `docs/pdf-seeding-spec.md`, F17 section. When a room has `has_paper=1`, render the paper on the graph canvas. Use pdf.js (loaded from CDN: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js` and the corresponding worker). Create an absolutely-positioned `<div>` overlay containing a `<canvas>` element for pdf.js page rendering. Size: 280x360px at scale 1. Pin the paper at canvas origin (0,0). On every D3 zoom/pan event, update the div's CSS transform to match the SVG zoom transform so the paper tracks with the graph. Add page navigation: ◀/▶ buttons and a "page/total" indicator below the thumbnail. Page state is client-side only. Pre-render adjacent pages for smooth navigation. Double-click opens the PDF in a new tab. Add the paper node as a collision body in the force simulation with a rectangular radius matching its visual size, so concept nodes are repelled from it. Show a loading placeholder until the first page renders.

### Prompt 6 (Radial seed positioning):

> Read `docs/pdf-seeding-spec.md`, Seed Concept Positioning section. When seed concepts are created from paper extraction, position them in a radial layout around the paper node (canvas origin). Primary concepts go on an inner ring at radius ~300px, evenly spaced angularly. Secondary concepts go on an outer ring at radius ~500px, positioned near their parent primary concept's angle. Set these as initial `x`/`y` positions on the nodes before the force simulation runs. The force simulation will then refine positions while the paper node's collision force keeps a buffer zone clear.

---

## Open Questions

1. **Paper-to-concept edges** — the spec says no, relying on spatial proximity. If radial positioning doesn't communicate provenance clearly enough in practice, we can add faint dashed edges as a later enhancement.

2. **Zoom-to-read** — at what zoom level does body text become readable in the 280×360 thumbnail? Worth observing in the study. If students frequently zoom in, that signals demand for a dedicated reading panel.

3. **Collision with edge routing** — if the current edge routing doesn't support rectangular collision boundaries, the collision force alone (pushing nodes away from the paper) is an acceptable approximation.