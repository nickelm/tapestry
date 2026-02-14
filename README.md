# Tapestry

Collaborative knowledge curation through interactive concept graphs.

Students chat with an LLM, extract concepts, and harvest them into a shared knowledge graph that the group curates together in real time.

## Quick Start

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server/index.js
```

Open `http://localhost:3000` in your browser.

## Deployment (DigitalOcean)

1. Clone to your droplet
2. `npm install`
3. Set your API key: `export ANTHROPIC_API_KEY=sk-ant-...`
4. Run with pm2: `pm2 start server/index.js --name tapestry`
5. Set up nginx reverse proxy (optional, for domain + SSL)

### Nginx config example

```nginx
server {
    server_name tapestry.au-hcai.app;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then: `sudo certbot --nginx -d tapestry.au-hcai.app`

## Preseeding Concepts

Use the REST API to seed a room with initial concepts:

```bash
# Create a room
curl -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"name": "HCAI Lecture 3"}'

# Seed concepts (use the room ID from above)
curl -X POST http://localhost:3000/api/rooms/ROOM_ID/seed \
  -H "Content-Type: application/json" \
  -d '{
    "concepts": [
      {"title": "Usability", "description": "The ease with which users can accomplish tasks"},
      {"title": "Affordance", "description": "Properties that suggest how an object should be used"},
      {"title": "Mental Model", "description": "User's internal representation of how a system works"}
    ]
  }'
```

## Architecture

- **Server:** Node.js + Express + Socket.IO
- **Database:** SQLite via sql.js (persisted to disk every 30s)
- **Graph:** D3.js force-directed layout with rectilinear edges
- **LLM:** Anthropic Claude API (Sonnet for chat, Haiku for background tasks)

## Operations

| Operation | Description |
|-----------|-------------|
| **Harvest** | Extract a concept from an LLM response into the shared graph |
| **Expand** | Ask the LLM to generate related concepts as neighbors |
| **Elaborate** | Enrich a concept's description via the LLM |
| **Connect** | Link two concepts; LLM generates the relationship label |
| **Merge** | Combine two similar concepts into one |
| **Prune** | Remove a concept from the graph |
| **Upvote** | Signal that a concept is important |
