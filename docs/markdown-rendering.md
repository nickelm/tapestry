# Markdown Rendering & Harvest Description Generation

Two independent fixes for the personal workspace panel.

---

## M1: Markdown Rendering in LLM Responses

### Problem

LLM responses contain markdown (headers, bold, italic, lists, code blocks, inline code) but are rendered as plain text via `escapeHtml()`. Technical responses are particularly unreadable.

### Solution

Use `marked.js` to render LLM response text as HTML before inserting into the DOM.

**Rendering pipeline (order matters):**
```
Raw LLM response (markdown string)
  → marked.parse() → HTML
  → Sanitize (disable raw HTML in marked config)
  → Inline concept highlighting (F2: walk rendered HTML text nodes, wrap matches in spans)
  → Insert into DOM
```

**Critical constraint:** F2's concept title matching must operate on the *rendered* HTML's text nodes, not the raw markdown. If concept matching runs before markdown rendering, injected `<span>` tags will break markdown syntax. Walk the DOM text nodes after rendering to find and wrap concept matches.

**marked.js configuration:**
- `sanitize: true` or use `marked.use({ renderer })` to strip dangerous tags
- `gfm: true` (GitHub-flavored markdown: tables, strikethrough, task lists)
- `breaks: true` (treat single newlines as `<br>`, matches how chat responses read)

**Serving the library:**
- Load via CDN in `index.html`: `<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>`
- Or: `npm install marked`, copy `node_modules/marked/marked.min.js` to `public/js/`, and add a `<script>` tag

**CSS additions for `style.css`:**
Scope all markdown styles under `.chat-msg.assistant` to avoid leaking into other UI elements.

```css
.chat-msg.assistant h1,
.chat-msg.assistant h2,
.chat-msg.assistant h3 { /* scale down — these appear inside a 360px panel */ }
.chat-msg.assistant code { /* inline code: background, border-radius, monospace */ }
.chat-msg.assistant pre { /* code blocks: background, padding, overflow-x scroll */ }
.chat-msg.assistant ul, 
.chat-msg.assistant ol { /* left padding, standard list styling */ }
.chat-msg.assistant blockquote { /* left border, muted color */ }
.chat-msg.assistant table { /* border-collapse, subtle borders */ }
```

Keep heading sizes modest — the panel is 360px wide, so `h1` inside a response should be ~16px, not the page-level 24px+.

### Claude Code Prompt

> Read `docs/markdown-and-harvest-desc.md`, section M1. Add markdown rendering to LLM responses in the personal workspace. Add `marked.js` (via CDN or npm). In `appendChatResponse()` in `app.js`, render the response text through `marked.parse()` before applying inline concept highlighting from F2. Configure marked with `gfm: true`, `breaks: true`, and HTML sanitization. The F2 concept title matching must walk the rendered HTML's text nodes to find and wrap matches — do not match against raw markdown. Add scoped CSS for markdown elements (code, pre, blockquote, lists, tables, headings) under `.chat-msg.assistant` in `style.css`. Keep heading sizes small (max 16px for h1) since the panel is 360px wide.

---

## M2: Auto-Generate Description for Text-Selection Harvests

### Problem

When a user selects arbitrary text (F5) and harvests it, the title is pre-filled from the selected text but the description field is empty. The user must write one manually or skip it, resulting in low-quality concept nodes in the shared graph.

### Solution

When the harvest inline form (F6) opens from a text selection, auto-generate a one-sentence description via a Haiku call.

**Behavior:**
1. User selects text → clicks Harvest → inline form opens
2. Title field: pre-filled with selected text (truncated to 60 chars)
3. Description field: shows a subtle loading indicator ("Generating...")
4. Fire a Haiku call to generate a description:
   ```
   Given the following excerpt from a discussion about {breadcrumb_path}:
   "{selected_text}"
   
   Write a one-sentence description of the concept "{title}" suitable for
   a knowledge graph node.
   ```
5. When the description arrives, populate the field (user can still edit)
6. If the call fails or times out (>3s), leave the field empty with placeholder "Add a description..."
7. The user can submit the form at any time — they don't have to wait for the description

**Implementation:**
- Reuse the same endpoint as F9b (`POST /api/rooms/:id/describe-concept`) if it exists, or add it now
- The form's "Add to Graph" button is enabled immediately (description is optional), so there's no blocking wait
- If the user starts typing in the description field before the Haiku response arrives, cancel the auto-fill (don't overwrite manual input)

**Also applies to:** Harvesting inline concepts that used lazy-loaded descriptions (F9b). If the user never hovered (so no cached description), trigger the same Haiku call when the harvest form opens.
