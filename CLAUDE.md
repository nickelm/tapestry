# Tapestry

Collaborative knowledge curation through interactive concept graphs. Built for classroom use in HCAI courses at Aarhus University.

## Project Overview

Students join a shared room, chat with an LLM to explore a topic, extract concepts from responses ("harvest"), and publish them to a shared knowledge graph. The group curates the graph together in real time through operations like connect, expand, merge, prune, and upvote.

### Design Rationale

- **Two-layer model:** Personal chat (foraging) → shared graph (synthesis). Based on Pirolli & Card's sensemaking loop.
- **Harvest as deliberate act:** Students don't dump everything; they curate what they contribute.
- **LLM is ever-present:** Concept extraction, relationship labeling, expansion, elaboration, merge summarization — all handled by background LLM calls.
- **Inspired by:** Graphologue (Jiang et al., CHI 2024) for concept extraction from LLM responses; SOCoM (unpublished student project) for collaborative spatial organization.

## Architecture

```
tapestry/
├── server/
│   ├── index.js        # Express + Socket.IO server, REST API, all socket event handlers
│   ├── database.js     # SQLite via sql.js, async init, query helpers
│   └── llm.js          # Anthropic Claude API wrapper for all LLM tasks
├── public/
│   ├── index.html      # Single-page app: login screen + main app
│   ├── css/style.css   # All styles, Graphologue-inspired clean academic aesthetic
│   └── js/
│       ├── graph.js    # TapestryGraph class: D3 force-directed layout, rendering, interactions
│       └── app.js      # Main app logic: Socket.IO events, chat, context menu, modals
├── package.json
└── README.md
```

### Key Technical Decisions

- **sql.js** (not better-sqlite3): Pure JS SQLite, no native compilation needed. Persists to `tapestry.db` every 30s.
- **D3 force simulation** with collision avoidance for graph layout. Nodes can be pinned by dragging.
- **Rectilinear edges:** Orthogonal routing (horizontal-then-vertical or vertical-then-horizontal) with labeled relationship text.
- **Socket.IO rooms** for multi-team support. Each room is isolated.
- **Claude Sonnet** for chat responses + concept extraction. **Claude Haiku** for background tasks (relationship labeling, expansion, elaboration, merge suggestions, similarity detection).

### LLM Integration Points

| Task | Model | Trigger |
|------|-------|---------|
| Chat + concept extraction | Sonnet | User sends message |
| Relationship labeling | Haiku | User connects two nodes |
| Concept expansion | Haiku | User right-clicks → Expand |
| Elaboration | Haiku | User right-clicks → Elaborate |
| Merge summarization | Haiku | User merges two nodes |
| Similarity detection | Haiku | User harvests a concept |

## REST API

- `GET /api/rooms` — list rooms
- `POST /api/rooms` — create room `{name}`
- `GET /api/rooms/:id/state` — full room state (nodes, edges, contributors, activity)
- `POST /api/rooms/:id/seed` — preseed concepts `{concepts: [{title, description}]}`

## Development

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
node server/index.js          # or: node --watch server/index.js
```

## Planned Improvements

- Undo/redo for graph operations
- PDF upload for seeding (extract initial concepts from a paper)
- Local LLM support via Ollama (llama3.1-8b)
- Bookmark/pin important concepts
- Split operation (decompose broad concepts)
- Dynamic user count updates
- Instructor/admin view
- Export graph as image or JSON
- Replay mode (animate graph construction from activity log)

## Research Context

This tool is a research prototype exploring collaborative knowledge curation with LLMs. The classroom deployment serves as both a teaching tool and an evaluation opportunity. Key research questions:

1. How do students collectively structure knowledge differently than individually?
2. Does the harvest-then-curate model improve engagement with LLM-generated content?
3. What patterns emerge in collaborative graph construction (e.g., hub concepts, clustering)?

Related work: Graphologue (Jiang et al. 2024), collaborative search (Morris 2013), co-located visual analytics (Isenberg et al. 2012), concept mapping (Novak & Cañas 2008).
