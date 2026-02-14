// app.js — Main application logic

const socket = io();
let graph;
let currentUser = null;
let currentRoom = null;
let chatHistory = [];
let threadTree = [];
let threadMap = new Map();
let threadIdCounter = 0;
let activeThreadId = null;
let connectionSourceId = null;
let mergeSourceId = null;
let pendingHarvest = null;
let selectedRoomId = null;
let myUpvotes = new Set();
let graphTitleMap = new Map(); // lowercase title -> nodeId (F10: shared graph awareness)

// ========== THREAD MODEL ==========

function createThreadNode(prompt, parentId = null, origin = 'manual') {
  const parent = parentId ? threadMap.get(parentId) : null;
  const depth = parent ? parent.depth + 1 : 0;
  const breadcrumb = parent ? [...parent.breadcrumb] : [];

  const node = {
    id: `thread-${threadIdCounter++}`,
    parentId,
    depth,
    breadcrumb,
    prompt,
    response: null,
    concepts: null,
    children: [],
    collapsed: false,
    domElement: null,
    origin,
  };

  threadMap.set(node.id, node);

  if (parent) {
    parent.children.push(node);
  } else {
    threadTree.push(node);
  }

  return node;
}

// ========== LOGIN ==========

async function loadRooms() {
  const res = await fetch('/api/rooms');
  const rooms = await res.json();
  const list = document.getElementById('room-list');

  if (rooms.length === 0) {
    list.innerHTML = '<div style="font-size: 13px; color: var(--text-muted); padding: 8px;">No rooms yet. Create one below.</div>';
    return;
  }

  list.innerHTML = rooms.map(r =>
    `<div class="room-item" data-room-id="${r.id}">
      <span class="room-name">${r.name}</span>
      <span class="room-arrow">&rarr;</span>
    </div>`
  ).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => {
      list.querySelectorAll('.room-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      selectedRoomId = el.dataset.roomId;
      updateJoinButton();
    });
  });
}

function updateJoinButton() {
  const name = document.getElementById('login-name').value.trim();
  document.getElementById('join-btn').disabled = !(name && selectedRoomId);
}

document.getElementById('login-name').addEventListener('input', updateJoinButton);

document.getElementById('create-room-toggle').addEventListener('click', () => {
  const row = document.getElementById('create-room-row');
  row.classList.toggle('visible');
});

document.getElementById('create-room-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-room-name').value.trim();
  if (!name) return;

  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const room = await res.json();
  selectedRoomId = room.id;
  await loadRooms();

  // Auto-select the new room
  const items = document.querySelectorAll('.room-item');
  items.forEach(el => {
    if (el.dataset.roomId === room.id) {
      el.classList.add('selected');
    }
  });
  document.getElementById('create-room-row').classList.remove('visible');
  updateJoinButton();
});

document.getElementById('join-btn').addEventListener('click', () => {
  const userName = document.getElementById('login-name').value.trim();
  if (!userName || !selectedRoomId) return;
  socket.emit('join-room', { roomId: selectedRoomId, userName });
});

// ========== SOCKET: JOIN ==========

socket.on('joined', async ({ user, room }) => {
  currentUser = user;
  currentRoom = room;

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('room-label').textContent = room.name;

  // Init graph
  graph = new TapestryGraph('graph-area');
  graph.onNodeContext = showContextMenu;
  graph.onNodeClick = handleNodeClick;
  graph.onNodeDragEnd = (id, x, y, pinned) => {
    socket.emit('move-node', { nodeId: id, x, y, pinned });
  };
  graph.onNodeHover = (nodeId) => socket.emit('hover-node', { nodeId });
  graph.onNodeUnhover = () => socket.emit('unhover-node');
  graph.onNodeUpvote = (nodeId) => {
    if (myUpvotes.has(nodeId)) {
      myUpvotes.delete(nodeId);
    } else {
      myUpvotes.add(nodeId);
    }
    graph.render(false);
    socket.emit('upvote-node', { nodeId });
  };
  graph.onCanvasClick = () => { cancelConnectionMode(); cancelMergeMode(); };
  graph.onNodeDoubleClick = handleNodeDoubleClick;

  // Load existing state
  const res = await fetch(`/api/rooms/${selectedRoomId}/state`);
  const state = await res.json();

  // Track which nodes the current user has upvoted
  myUpvotes = new Set(
    (state.upvotes || []).filter(u => u.user_id === currentUser.id).map(u => u.node_id)
  );
  graph.userUpvotes = myUpvotes;
  graph.loadState(state);

  // Build shared graph title index (F10)
  graphTitleMap.clear();
  (state.nodes || []).forEach(n => graphTitleMap.set(n.title.toLowerCase(), n.id));

  // Populate activity log
  if (state.activity) {
    state.activity.reverse().forEach(addActivityItem);
  }

  updateUserCount(state.userCount || 1);
});

socket.on('error', ({ message }) => {
  console.error('Socket error:', message);
});

// ========== SOCKET: REAL-TIME EVENTS ==========

socket.on('node-added', (node) => {
  graph.addNode(node);
  graphTitleMap.set(node.title.toLowerCase(), node.id);
  refreshInGraphMarkers();
});

socket.on('node-removed', ({ id }) => {
  graph.removeNode(id);
  for (const [title, nid] of graphTitleMap) {
    if (nid === id) { graphTitleMap.delete(title); break; }
  }
  refreshInGraphMarkers();
});

socket.on('node-updated', (updates) => {
  const oldNode = graph.nodeMap.get(updates.id);
  if (oldNode && updates.title && updates.title !== oldNode.title) {
    graphTitleMap.delete(oldNode.title.toLowerCase());
    graphTitleMap.set(updates.title.toLowerCase(), updates.id);
  }
  graph.updateNode(updates.id, updates);
  if (updates.title) refreshInGraphMarkers();
});

socket.on('node-upvoted', ({ id, upvotes }) => {
  graph.updateNode(id, { upvotes });
});

socket.on('edge-added', (edge) => {
  graph.addEdge(edge);
});

socket.on('edge-removed', ({ id }) => {
  graph.removeEdge(id);
});

socket.on('node-moved', ({ id, x, y, pinned }) => {
  graph.moveNode(id, x, y, pinned);
});

socket.on('nodes-merged', ({ keepId, mergeId, title, description, contributors }) => {
  for (const [t, nid] of graphTitleMap) {
    if (nid === mergeId || nid === keepId) graphTitleMap.delete(t);
  }
  graph.mergeNodes(keepId, mergeId, { title, description, merged_count: (graph.nodeMap.get(keepId)?.merged_count || 0) + 1, contributors });
  graphTitleMap.set(title.toLowerCase(), keepId);
  refreshInGraphMarkers();
});

socket.on('user-joined', ({ user }) => {
  // Count is handled by 'user-count' event
});

socket.on('user-left', ({ userId }) => {
  graph.setUserHover(userId, null);
});

socket.on('user-count', ({ count }) => {
  updateUserCount(count);
});

socket.on('user-hover', ({ userId, userName, color, nodeId }) => {
  graph.setUserHover(userId, nodeId, { name: userName, color });
});

socket.on('user-unhover', ({ userId }) => {
  graph.setUserHover(userId, null);
});

socket.on('activity', (item) => {
  addActivityItem(item);
});

// ========== CHAT ==========

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatCancel = document.getElementById('chat-cancel');

chatCancel.addEventListener('click', () => {
  socket.emit('cancel-chat');
  cancelPendingChat();
});

function cancelPendingChat() {
  chatSend.disabled = false;
  chatCancel.style.display = 'none';

  if (activeThreadId) {
    const threadNode = threadMap.get(activeThreadId);
    if (threadNode && threadNode.domElement) {
      const typing = threadNode.domElement.querySelector('.typing-indicator-wrapper');
      if (typing) typing.remove();

      const body = threadNode.domElement.querySelector('.thread-body');
      const cancelledEl = document.createElement('div');
      cancelledEl.className = 'chat-msg assistant';
      cancelledEl.style.color = 'var(--text-muted)';
      cancelledEl.style.fontStyle = 'italic';
      cancelledEl.textContent = 'Query cancelled.';
      body.appendChild(cancelledEl);
    }
    activeThreadId = null;
  }

  // Remove the unanswered user message from chatHistory
  if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
    chatHistory.pop();
  }
}

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatSend.addEventListener('click', () => sendChat());

function sendChat(parentThreadId = null) {
  const text = chatInput.value.trim();
  if (!text) return;

  // Create thread node and render section
  const threadNode = createThreadNode(text, parentThreadId);
  renderThreadSection(threadNode);

  // Maintain flat chatHistory for server compatibility
  chatHistory.push({ role: 'user', content: text });

  chatInput.value = '';
  chatInput.style.height = '40px';
  chatSend.disabled = true;
  chatCancel.style.display = '';

  // Show typing indicator inside this thread section
  showTypingIndicator(threadNode);

  // Track which thread is awaiting a response
  activeThreadId = threadNode.id;

  socket.emit('chat', { messages: chatHistory });
}

function exploreConcept(conceptTitle, conceptDescription, sourceSpan) {
  // Find parent thread from DOM
  const threadSection = sourceSpan.closest('.thread-section');
  if (!threadSection) return;
  const parentThreadId = threadSection.dataset.threadId;
  const parentThread = threadMap.get(parentThreadId);
  if (!parentThread) return;

  // Build breadcrumb: parent's breadcrumb + this concept
  const newBreadcrumb = [...parentThread.breadcrumb, conceptTitle];
  const breadcrumbPath = newBreadcrumb.join(' \u2192 ');
  const prompt = `Context path: ${breadcrumbPath}\nTell me more about: ${conceptTitle}`;

  // Create child thread with origin 'explore'
  const threadNode = createThreadNode(prompt, parentThreadId, 'explore');
  threadNode.breadcrumb = newBreadcrumb;

  // Render thread section + typing indicator
  renderThreadSection(threadNode);
  showTypingIndicator(threadNode);

  // Mark source concept as explored
  sourceSpan.classList.add('explored');

  // Maintain flat chatHistory for server, set active thread, send
  chatHistory.push({ role: 'user', content: prompt });
  activeThreadId = threadNode.id;
  chatSend.disabled = true;
  chatCancel.style.display = '';
  socket.emit('chat', { messages: chatHistory });
}

socket.on('chat-response', ({ text, concepts }) => {
  chatSend.disabled = false;
  chatCancel.style.display = 'none';

  // Add to flat history
  chatHistory.push({ role: 'assistant', content: text });

  // Route response to the correct thread section
  if (activeThreadId) {
    const threadNode = threadMap.get(activeThreadId);
    if (threadNode) {
      fillThreadResponse(threadNode, text, concepts);
      activeThreadId = null;
      return;
    }
  }

  // Fallback: legacy flat rendering
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();
  appendChatResponse(text, concepts);
});

socket.on('chat-error', ({ message }) => {
  chatSend.disabled = false;
  chatCancel.style.display = 'none';

  if (activeThreadId) {
    const threadNode = threadMap.get(activeThreadId);
    if (threadNode) {
      const typing = threadNode.domElement.querySelector('.typing-indicator-wrapper');
      if (typing) typing.remove();

      const body = threadNode.domElement.querySelector('.thread-body');
      const errorEl = createChatMessageElement('assistant', 'Sorry, something went wrong. Please try again.');
      body.appendChild(errorEl);

      activeThreadId = null;
      return;
    }
  }

  // Fallback
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();
  appendChatMessage('assistant', 'Sorry, something went wrong. Please try again.');
});

function createChatMessageElement(role, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  return el;
}

function appendChatMessage(role, text) {
  const el = createChatMessageElement(role, text);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function createChatResponseElement(text, concepts) {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';

  // Ensure the user's query term is included as a concept if it appears in the response
  const allConcepts = concepts ? [...concepts] : [];
  const lastUserMsg = [...chatHistory].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    const query = lastUserMsg.content.trim();
    const alreadyCovered = allConcepts.some(c =>
      c.title.toLowerCase() === query.toLowerCase()
    );
    if (!alreadyCovered && query.length > 0 && text.toLowerCase().includes(query.toLowerCase())) {
      allConcepts.unshift({ title: query, type: 'primary' });
    }
  }

  // Convert text to paragraphs
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  let html = paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('');

  // Inline concept highlighting: match each concept title in the response text
  const unmatchedConcepts = [];
  if (allConcepts.length > 0) {
    allConcepts.forEach((concept, i) => {
      const escapedTitle = escapeHtml(concept.title);
      const regexSafeTitle = escapedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match concept title outside of HTML tags (case-insensitive, first occurrence only)
      const regex = new RegExp(`(?![^<]*>)(${regexSafeTitle})`, 'i');

      if (regex.test(html)) {
        const secondaryClass = concept.type === 'secondary' ? ' secondary' : '';
        const inGraphClass = graphTitleMap.has(concept.title.toLowerCase()) ? ' in-graph' : '';
        const graphNodeIdAttr = graphTitleMap.has(concept.title.toLowerCase())
          ? ` data-graph-node-id="${graphTitleMap.get(concept.title.toLowerCase())}"` : '';
        html = html.replace(regex,
          `<span class="concept-inline${secondaryClass}${inGraphClass}" data-concept-title="${escapeAttr(concept.title)}" data-concept-description="${escapeAttr(concept.description || '')}" data-concept-type="${concept.type || 'primary'}" data-concept-index="${i}"${graphNodeIdAttr}>$1</span>`
        );
      } else {
        unmatchedConcepts.push({ concept, index: i });
      }
    });

    // Fallback: append chips for concepts not found in text
    if (unmatchedConcepts.length > 0) {
      html += '<div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">';
      unmatchedConcepts.forEach(({ concept, index }) => {
        const secondaryClass = concept.type === 'secondary' ? ' secondary' : '';
        const chipInGraph = graphTitleMap.has(concept.title.toLowerCase());
        const chipInGraphClass = chipInGraph ? ' in-graph' : '';
        const chipGraphAttr = chipInGraph
          ? ` data-graph-node-id="${graphTitleMap.get(concept.title.toLowerCase())}"` : '';
        const chipBtnText = chipInGraph ? '\u25C9' : '+';
        html += `<span class="concept-chip${secondaryClass}${chipInGraphClass}" data-index="${index}" data-title="${escapeAttr(concept.title)}" data-description="${escapeAttr(concept.description || '')}" data-type="${concept.type || 'primary'}"${chipGraphAttr} title="${escapeHtml(concept.title)}">
          ${escapeHtml(concept.title)}
          <button class="harvest-btn" data-index="${index}">${chipBtnText}</button>
        </span>`;
      });
      html += '</div>';
    }
  }

  el.innerHTML = html;

  // Attach harvest handlers for fallback chip buttons
  el.querySelectorAll('.harvest-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = btn.closest('.concept-chip');

      // F10: in-graph chips navigate to the graph node instead of harvesting
      if (chip.classList.contains('in-graph') && chip.dataset.graphNodeId) {
        graph.focusNode(chip.dataset.graphNodeId);
        return;
      }

      const title = chip.dataset.title;
      const description = chip.dataset.description;

      if (chip.classList.contains('harvested')) return;

      chip.classList.add('harvested');
      btn.textContent = '\u2713';

      socket.emit('harvest', { title, description });
    });
  });

  return el;
}

function appendChatResponse(text, concepts) {
  const el = createChatResponseElement(text, concepts);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ========== SHARED GRAPH AWARENESS (F10) ==========

function refreshInGraphMarkers() {
  // Update inline concept spans
  document.querySelectorAll('#chat-messages .concept-inline').forEach(span => {
    const title = (span.dataset.conceptTitle || '').toLowerCase();
    if (graphTitleMap.has(title)) {
      span.classList.add('in-graph');
      span.dataset.graphNodeId = graphTitleMap.get(title);
    } else {
      span.classList.remove('in-graph');
      delete span.dataset.graphNodeId;
    }
  });

  // Update concept chips
  document.querySelectorAll('#chat-messages .concept-chip').forEach(chip => {
    const title = (chip.dataset.title || '').toLowerCase();
    const harvestBtn = chip.querySelector('.harvest-btn');
    if (graphTitleMap.has(title)) {
      chip.classList.add('in-graph');
      chip.dataset.graphNodeId = graphTitleMap.get(title);
      if (harvestBtn && !chip.classList.contains('harvested')) {
        harvestBtn.textContent = '\u25C9';
        harvestBtn.title = 'View in graph';
      }
    } else {
      chip.classList.remove('in-graph');
      delete chip.dataset.graphNodeId;
      if (harvestBtn && !chip.classList.contains('harvested')) {
        harvestBtn.textContent = '+';
        harvestBtn.title = '';
      }
    }
  });
}

// ========== CONCEPT TOOLTIP (F3) + HARVEST FORM (F6) ==========

const conceptTooltip = document.getElementById('concept-tooltip');
const tooltipTitle = conceptTooltip.querySelector('.concept-tooltip-title');
const tooltipDesc = conceptTooltip.querySelector('.concept-tooltip-desc');
const tooltipHarvestBtn = document.getElementById('tooltip-harvest-btn');
const tooltipExploreBtn = document.getElementById('tooltip-explore-btn');

const harvestForm = document.getElementById('harvest-inline-form');
const harvestFormTitle = document.getElementById('harvest-form-title');
const harvestFormDesc = document.getElementById('harvest-form-desc');
const harvestFormSubmit = document.getElementById('harvest-form-submit');
const harvestFormCancel = document.getElementById('harvest-form-cancel');

let tooltipTimeout = null;
let tooltipGraceTimeout = null;
let activeConceptSpan = null;

function getBreadcrumbForSpan(span) {
  const threadSection = span.closest('.thread-section');
  if (!threadSection) return [];
  const thread = threadMap.get(threadSection.dataset.threadId);
  return thread ? thread.breadcrumb : [];
}

async function fetchConceptDescription(title, breadcrumb) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`/api/rooms/${currentRoom.id}/describe-concept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, breadcrumb }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    return data.description;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

function showTooltip(span) {
  activeConceptSpan = span;
  tooltipTitle.textContent = span.dataset.conceptTitle;

  // F10: check if concept exists in shared graph
  const isInGraph = span.classList.contains('in-graph');
  const graphNodeId = span.dataset.graphNodeId;

  if (isInGraph && graphNodeId) {
    // Show description from graph node state, or auto-fetch if missing
    const graphNode = graph.nodeMap.get(graphNodeId);
    if (graphNode && graphNode.description) {
      tooltipDesc.textContent = graphNode.description;
      tooltipDesc.classList.remove('loading');
    } else {
      tooltipDesc.textContent = 'Loading\u2026';
      tooltipDesc.classList.add('loading');
      const breadcrumb = getBreadcrumbForSpan(span);
      fetchConceptDescription(span.dataset.conceptTitle, breadcrumb).then(desc => {
        const text = desc || 'No description available';
        if (activeConceptSpan === span) {
          tooltipDesc.textContent = text;
          tooltipDesc.classList.remove('loading');
        }
        if (desc && graphNode) {
          graphNode.description = desc;
          socket.emit('edit-node', { nodeId: graphNodeId, description: desc });
        }
      });
    }
  } else {
    const cachedDesc = span.dataset.conceptDescription;
    if (cachedDesc) {
      tooltipDesc.textContent = cachedDesc;
      tooltipDesc.classList.remove('loading');
    } else {
      tooltipDesc.textContent = 'Loading\u2026';
      tooltipDesc.classList.add('loading');

      const breadcrumb = getBreadcrumbForSpan(span);
      fetchConceptDescription(span.dataset.conceptTitle, breadcrumb).then(desc => {
        const fallback = 'No description available';
        span.dataset.conceptDescription = desc || fallback;
        // Update tooltip if it's still showing this span
        if (activeConceptSpan === span) {
          tooltipDesc.textContent = desc || fallback;
          tooltipDesc.classList.remove('loading');
        }
      });
    }
  }

  // F10: toggle harvest/view-in-graph button
  if (isInGraph) {
    tooltipHarvestBtn.textContent = '\u25C9 View in graph';
    tooltipHarvestBtn.className = 'concept-tooltip-btn view-in-graph';
  } else {
    tooltipHarvestBtn.textContent = '+ Harvest';
    tooltipHarvestBtn.className = 'concept-tooltip-btn harvest';
  }

  // Position above the span, centered
  const rect = span.getBoundingClientRect();
  conceptTooltip.classList.add('visible');

  const tooltipRect = conceptTooltip.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = rect.top - tooltipRect.height - 8;

  // Clamp to viewport
  left = Math.max(4, Math.min(left, window.innerWidth - tooltipRect.width - 4));
  if (top < 4) {
    top = rect.bottom + 8; // flip below if no room above
  }

  conceptTooltip.style.left = left + 'px';
  conceptTooltip.style.top = top + 'px';

  // Disable Explore button for already-explored concepts
  const isExplored = span.classList.contains('explored');
  tooltipExploreBtn.disabled = isExplored;
  tooltipExploreBtn.textContent = isExplored ? '\u2713 Explored' : '\u2192 Explore';
}

function hideTooltip() {
  conceptTooltip.classList.remove('visible');
  activeConceptSpan = null;
}

function hideHarvestForm() {
  harvestForm.classList.remove('visible');
}

// Event delegation on chat-messages for concept-inline hover
chatMessages.addEventListener('mouseover', (e) => {
  const span = e.target.closest('.concept-inline');
  if (!span || span.classList.contains('harvested')) return;

  clearTimeout(tooltipGraceTimeout);

  // If tooltip already showing for this span, do nothing
  if (activeConceptSpan === span && conceptTooltip.classList.contains('visible')) return;

  clearTimeout(tooltipTimeout);
  tooltipTimeout = setTimeout(() => showTooltip(span), 300);
});

chatMessages.addEventListener('mouseout', (e) => {
  const span = e.target.closest('.concept-inline');
  if (!span) return;

  clearTimeout(tooltipTimeout);

  // Grace period: allow moving into tooltip
  tooltipGraceTimeout = setTimeout(() => {
    hideTooltip();
  }, 100);
});

// Click on inline concept to explore (F4) or view in graph (F10)
chatMessages.addEventListener('click', (e) => {
  const span = e.target.closest('.concept-inline');
  if (!span) return;

  // F10: in-graph concepts navigate to the graph node
  if (span.classList.contains('in-graph') && span.dataset.graphNodeId) {
    hideTooltip();
    graph.focusNode(span.dataset.graphNodeId);
    return;
  }

  if (span.classList.contains('explored') || span.classList.contains('harvested')) return;
  if (activeThreadId) return;
  hideTooltip();
  exploreConcept(span.dataset.conceptTitle, span.dataset.conceptDescription, span);
});

// Keep tooltip open when hovering over it
conceptTooltip.addEventListener('mouseenter', () => {
  clearTimeout(tooltipGraceTimeout);
});

conceptTooltip.addEventListener('mouseleave', () => {
  tooltipGraceTimeout = setTimeout(() => {
    hideTooltip();
  }, 100);
});

// Harvest button in tooltip → show inline form (or view in graph for F10)
tooltipHarvestBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!activeConceptSpan) return;

  const span = activeConceptSpan;
  const isInGraph = span.classList.contains('in-graph');
  const graphNodeId = span.dataset.graphNodeId;

  hideTooltip();

  // F10: "View in graph" action
  if (isInGraph && graphNodeId) {
    graph.focusNode(graphNodeId);
    return;
  }

  // Populate and show harvest form
  harvestFormTitle.value = span.dataset.conceptTitle;
  harvestFormDesc.value = span.dataset.conceptDescription;
  activeConceptSpan = span; // restore after hideTooltip cleared it

  // Position below the span
  const rect = span.getBoundingClientRect();
  harvestForm.classList.add('visible');

  const formRect = harvestForm.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (formRect.width / 2);
  let top = rect.bottom + 8;

  // Clamp to viewport
  left = Math.max(4, Math.min(left, window.innerWidth - formRect.width - 4));
  if (top + formRect.height > window.innerHeight - 4) {
    top = rect.top - formRect.height - 8; // flip above
  }

  harvestForm.style.left = left + 'px';
  harvestForm.style.top = top + 'px';

  harvestFormTitle.focus();
});

// Explore button (F4)
tooltipExploreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!activeConceptSpan) return;
  const span = activeConceptSpan;
  hideTooltip();
  if (span.classList.contains('explored') || span.classList.contains('harvested')) return;
  if (activeThreadId) return;
  exploreConcept(span.dataset.conceptTitle, span.dataset.conceptDescription, span);
});

// Harvest form: Add to Graph
harvestFormSubmit.addEventListener('click', (e) => {
  e.stopPropagation();

  const title = harvestFormTitle.value.trim();
  const description = harvestFormDesc.value.trim();
  if (!title) return;

  socket.emit('harvest', { title, description });

  if (activeConceptSpan) {
    activeConceptSpan.classList.add('harvested');
  }

  hideHarvestForm();
  activeConceptSpan = null;
});

// Harvest form: Cancel
harvestFormCancel.addEventListener('click', (e) => {
  e.stopPropagation();
  hideHarvestForm();
  activeConceptSpan = null;
});

// Dismiss harvest form on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (harvestForm.classList.contains('visible')) {
      hideHarvestForm();
      activeConceptSpan = null;
    }
    if (conceptTooltip.classList.contains('visible')) {
      hideTooltip();
    }
    if (selectionToolbar.classList.contains('visible')) {
      hideSelectionToolbar();
    }
    if (editNodeModal && editNodeModal.classList.contains('visible')) {
      hideEditNodeModal();
    }
  }
});

// Dismiss harvest form and selection toolbar on outside click
document.addEventListener('click', (e) => {
  if (harvestForm.classList.contains('visible') && !harvestForm.contains(e.target) && !e.target.closest('.concept-tooltip') && !e.target.closest('.selection-toolbar')) {
    hideHarvestForm();
    activeConceptSpan = null;
  }
  if (selectionToolbar.classList.contains('visible') && !selectionToolbar.contains(e.target)) {
    hideSelectionToolbar();
  }
});

// ========== TEXT SELECTION TOOLBAR (F5) ==========

const selectionToolbar = document.getElementById('selection-toolbar');
const selectionHarvestBtn = document.getElementById('selection-harvest-btn');
const selectionExploreBtn = document.getElementById('selection-explore-btn');
let selectedText = '';

function showSelectionToolbar(range) {
  const rect = range.getBoundingClientRect();
  selectionToolbar.classList.add('visible');

  const toolbarRect = selectionToolbar.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (toolbarRect.width / 2);
  let top = rect.top - toolbarRect.height - 8;

  // Clamp to viewport
  left = Math.max(4, Math.min(left, window.innerWidth - toolbarRect.width - 4));
  if (top < 4) {
    top = rect.bottom + 8; // flip below if no room above
  }

  selectionToolbar.style.left = left + 'px';
  selectionToolbar.style.top = top + 'px';
}

function hideSelectionToolbar() {
  selectionToolbar.classList.remove('visible');
  selectedText = '';
}

// Show toolbar on text selection within assistant messages
chatMessages.addEventListener('mouseup', (e) => {
  // Don't interfere with toolbar button clicks
  if (selectionToolbar.contains(e.target)) return;

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (!text) { hideSelectionToolbar(); return; }

    // Check that the selection is within an assistant message
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    const assistantMsg = el.closest('.chat-msg.assistant');
    if (!assistantMsg) { hideSelectionToolbar(); return; }

    selectedText = text;
    showSelectionToolbar(range);
  }, 10);
});

// Harvest button — open F6 inline form with selected text
selectionHarvestBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedText) return;

  const title = selectedText.length > 60 ? selectedText.substring(0, 60) + '\u2026' : selectedText;
  const description = selectedText.length > 200 ? selectedText : '';

  // Grab selection rect and breadcrumb context before hiding toolbar
  const sel = window.getSelection();
  let selRect = null;
  let breadcrumb = [];
  if (sel.rangeCount > 0) {
    selRect = sel.getRangeAt(0).getBoundingClientRect();
    const container = sel.getRangeAt(0).commonAncestorContainer;
    const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    const threadSection = el.closest('.thread-section');
    if (threadSection) {
      const thread = threadMap.get(threadSection.dataset.threadId);
      if (thread) breadcrumb = thread.breadcrumb;
    }
  }

  hideSelectionToolbar();

  // Populate and show harvest form (reuses F6)
  harvestFormTitle.value = title;
  harvestFormDesc.value = description;
  activeConceptSpan = null; // no source span for text selection harvest

  // Fetch description for free text if none available
  if (!description) {
    harvestFormDesc.placeholder = 'Generating description\u2026';
    fetchConceptDescription(title, breadcrumb).then(desc => {
      // Only populate if user hasn't typed anything yet
      if (!harvestFormDesc.value) {
        harvestFormDesc.value = desc || '';
      }
      harvestFormDesc.placeholder = '';
    });
  }

  if (selRect) {
    harvestForm.classList.add('visible');
    const formRect = harvestForm.getBoundingClientRect();
    let left = selRect.left + (selRect.width / 2) - (formRect.width / 2);
    let top = selRect.bottom + 8;
    left = Math.max(4, Math.min(left, window.innerWidth - formRect.width - 4));
    if (top + formRect.height > window.innerHeight - 4) {
      top = selRect.top - formRect.height - 8;
    }
    harvestForm.style.left = left + 'px';
    harvestForm.style.top = top + 'px';
  }

  harvestFormTitle.focus();
});

// Explore button — create child thread with selected text
selectionExploreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedText || activeThreadId) return;

  // Find parent thread from the selection's assistant message
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return;
  const container = sel.getRangeAt(0).commonAncestorContainer;
  const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  const assistantMsg = el.closest('.chat-msg.assistant');
  if (!assistantMsg) return;
  const threadSection = assistantMsg.closest('.thread-section');
  if (!threadSection) return;
  const parentThreadId = threadSection.dataset.threadId;
  const parentThread = threadMap.get(parentThreadId);
  if (!parentThread) return;

  const conceptTitle = selectedText.length > 60 ? selectedText.substring(0, 60) : selectedText;
  const newBreadcrumb = [...parentThread.breadcrumb, conceptTitle];
  const breadcrumbPath = newBreadcrumb.join(' \u2192 ');
  const prompt = `Context path: ${breadcrumbPath}\nTell me more about: ${selectedText}`;

  hideSelectionToolbar();
  window.getSelection().removeAllRanges();

  const threadNode = createThreadNode(prompt, parentThreadId, 'explore');
  threadNode.breadcrumb = newBreadcrumb;
  renderThreadSection(threadNode);
  showTypingIndicator(threadNode);

  chatHistory.push({ role: 'user', content: prompt });
  activeThreadId = threadNode.id;
  chatSend.disabled = true;
  chatCancel.style.display = '';
  socket.emit('chat', { messages: chatHistory });
});

// Dismiss toolbar on scroll
chatMessages.addEventListener('scroll', () => {
  hideSelectionToolbar();
});

// ========== THREAD RENDERING ==========

function renderThreadSection(threadNode) {
  const section = document.createElement('div');
  section.className = `thread-section depth-${Math.min(threadNode.depth, 3)}`;
  section.dataset.threadId = threadNode.id;
  if (threadNode.origin === 'graph') section.classList.add('from-graph');

  // Thread header with collapse toggle
  const header = document.createElement('div');
  const originClass = threadNode.origin === 'graph' ? ' from-graph' : threadNode.origin === 'explore' ? ' from-explore' : '';
  header.className = `thread-header${originClass}`;

  const toggle = document.createElement('span');
  toggle.className = 'thread-collapse-toggle';
  toggle.textContent = '\u25BE'; // ▾
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleThreadCollapse(threadNode);
  });

  const headerLabel = document.createElement('span');
  headerLabel.className = 'thread-header-label';
  if (threadNode.origin === 'explore') {
    const conceptName = threadNode.breadcrumb[threadNode.breadcrumb.length - 1] || threadNode.prompt;
    headerLabel.textContent = `\u2192 ${conceptName}`;
  } else if (threadNode.origin === 'graph') {
    const conceptName = threadNode.breadcrumb[threadNode.breadcrumb.length - 1] || threadNode.prompt;
    headerLabel.innerHTML = `<span class="graph-icon">\u25C9</span> ${escapeHtml(conceptName)}`;
  } else {
    headerLabel.textContent = threadNode.prompt.length > 60
      ? threadNode.prompt.substring(0, 57) + '...'
      : threadNode.prompt;
  }

  const closeBtn = document.createElement('span');
  closeBtn.className = 'thread-close-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Remove from view';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeThreadId === threadNode.id) return; // Don't remove while waiting for response
    removeThreadSection(threadNode);
  });

  header.appendChild(toggle);
  header.appendChild(headerLabel);
  header.appendChild(closeBtn);
  section.appendChild(header);

  // Thread body (holds the actual messages)
  const body = document.createElement('div');
  body.className = 'thread-body';

  const userMsg = createChatMessageElement('user', threadNode.prompt);
  if (threadNode.origin === 'explore' || threadNode.origin === 'graph') {
    userMsg.classList.add('auto-prompt');
    const conceptName = threadNode.breadcrumb[threadNode.breadcrumb.length - 1] || threadNode.prompt;
    userMsg.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'auto-prompt-icon';
    icon.textContent = threadNode.origin === 'graph' ? '\u25C9' : '\u2192';
    userMsg.appendChild(icon);
    userMsg.appendChild(document.createTextNode(` Tell me more about: ${conceptName}`));
  }
  body.appendChild(userMsg);

  section.appendChild(body);

  // Children container (for nested threads from F4/F7)
  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'thread-children';
  section.appendChild(childrenContainer);

  // Store DOM reference
  threadNode.domElement = section;

  // Insert into correct location
  if (threadNode.parentId) {
    const parentNode = threadMap.get(threadNode.parentId);
    const parentChildren = parentNode.domElement.querySelector('.thread-children');

    const connector = document.createElement('div');
    connector.className = 'thread-connector';
    parentChildren.appendChild(connector);

    parentChildren.appendChild(section);
  } else {
    chatMessages.appendChild(section);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTypingIndicator(threadNode) {
  const body = threadNode.domElement.querySelector('.thread-body');
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-msg assistant typing-indicator-wrapper';
  typingEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  body.appendChild(typingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function fillThreadResponse(threadNode, text, concepts) {
  // Remove typing indicator from this section
  const typing = threadNode.domElement.querySelector('.typing-indicator-wrapper');
  if (typing) typing.remove();

  // Create and insert response element
  const body = threadNode.domElement.querySelector('.thread-body');
  const responseEl = createChatResponseElement(text, concepts);
  body.appendChild(responseEl);

  // Store in the thread node
  threadNode.response = text;
  threadNode.concepts = concepts;

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function toggleThreadCollapse(threadNode) {
  threadNode.collapsed = !threadNode.collapsed;
  const section = threadNode.domElement;
  const toggle = section.querySelector('.thread-collapse-toggle');

  if (threadNode.collapsed) {
    section.classList.add('collapsed');
    toggle.textContent = '\u25B8'; // ▸
  } else {
    section.classList.remove('collapsed');
    toggle.textContent = '\u25BE'; // ▾
  }
}

function removeThreadSection(threadNode) {
  const section = threadNode.domElement;
  if (!section) return;

  // Remove preceding connector if it exists
  const prev = section.previousElementSibling;
  if (prev && prev.classList.contains('thread-connector')) {
    prev.remove();
  }

  section.remove();
  threadNode.hidden = true;
  threadNode.domElement = null;

  // Recursively hide children
  function hideChildren(node) {
    for (const child of node.children) {
      child.hidden = true;
      if (child.domElement) {
        child.domElement.remove();
        child.domElement = null;
      }
      hideChildren(child);
    }
  }
  hideChildren(threadNode);
}

// ========== SIMILAR CONCEPTS MODAL ==========

socket.on('similar-found', ({ newConcept, similar }) => {
  pendingHarvest = newConcept;
  const modal = document.getElementById('similar-modal');
  document.getElementById('similar-new-concept').textContent =
    `"${newConcept.title}" seems similar to existing concepts:`;

  const list = document.getElementById('similar-list');
  list.innerHTML = similar.map(s =>
    `<div class="similar-item">
      <div class="similar-title">${escapeHtml(s.title)}</div>
      <div class="similar-desc">${escapeHtml(s.description)}</div>
    </div>`
  ).join('');

  modal.classList.add('visible');
});

document.getElementById('similar-add-anyway').addEventListener('click', () => {
  if (pendingHarvest) {
    socket.emit('force-harvest', pendingHarvest);
    pendingHarvest = null;
  }
  document.getElementById('similar-modal').classList.remove('visible');
});

document.getElementById('similar-cancel').addEventListener('click', () => {
  pendingHarvest = null;
  document.getElementById('similar-modal').classList.remove('visible');
});

// ========== CONTEXT MENU ==========

const contextMenu = document.getElementById('context-menu');
let contextNodeId = null;

function showContextMenu(nodeId, x, y) {
  contextNodeId = nodeId;
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.add('visible');

  // Update upvote label
  const node = graph.nodeMap.get(nodeId);
  const upvoteItem = contextMenu.querySelector('[data-action="upvote"]');
  if (node) {
    upvoteItem.querySelector('.cm-icon').textContent = '△';
  }
}

function hideContextMenu() {
  contextMenu.classList.remove('visible');
  contextNodeId = null;
}

document.addEventListener('click', () => hideContextMenu());

contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = item.dataset.action;
    if (!contextNodeId) return;

    switch (action) {
      case 'expand':
        socket.emit('expand-node', { nodeId: contextNodeId });
        break;
      case 'elaborate':
        socket.emit('elaborate-node', { nodeId: contextNodeId });
        break;
      case 'edit':
        showEditNodeModal(contextNodeId);
        break;
      case 'connect':
        startConnectionMode(contextNodeId);
        break;
      case 'merge':
        startMergeMode(contextNodeId);
        break;
      case 'upvote':
        socket.emit('upvote-node', { nodeId: contextNodeId });
        break;
      case 'prune':
        socket.emit('prune-node', { nodeId: contextNodeId });
        break;
    }
    hideContextMenu();
  });
});

// ========== EDIT NODE MODAL ==========

let editingNodeId = null;
const editNodeModal = document.getElementById('edit-node-modal');
const editNodeTitle = document.getElementById('edit-node-title');
const editNodeDesc = document.getElementById('edit-node-desc');

function showEditNodeModal(nodeId) {
  const node = graph.nodeMap.get(nodeId);
  if (!node) return;
  editingNodeId = nodeId;
  editNodeTitle.value = node.title || '';
  editNodeDesc.value = node.description || '';
  editNodeModal.classList.add('visible');
  editNodeTitle.focus();
}

function hideEditNodeModal() {
  editNodeModal.classList.remove('visible');
  editingNodeId = null;
}

document.getElementById('edit-node-save').addEventListener('click', () => {
  if (!editingNodeId) return;
  const title = editNodeTitle.value.trim();
  const description = editNodeDesc.value.trim();
  if (!title) return;
  socket.emit('edit-node', { nodeId: editingNodeId, title, description });
  hideEditNodeModal();
});

document.getElementById('edit-node-cancel').addEventListener('click', () => {
  hideEditNodeModal();
});

editNodeModal.addEventListener('click', (e) => {
  if (e.target === editNodeModal) hideEditNodeModal();
});

const editNodeGenerateBtn = document.getElementById('edit-node-generate');
editNodeGenerateBtn.addEventListener('click', async () => {
  const title = editNodeTitle.value.trim();
  if (!title) return;
  editNodeGenerateBtn.disabled = true;
  editNodeGenerateBtn.textContent = '\u2728 Generating\u2026';
  const desc = await fetchConceptDescription(title, []);
  editNodeDesc.value = desc || '';
  editNodeGenerateBtn.textContent = '\u2728 Generate';
  editNodeGenerateBtn.disabled = false;
});

// ========== CONNECTION MODE ==========

function startConnectionMode(sourceId) {
  connectionSourceId = sourceId;
  graph.setSelected(sourceId);
  document.getElementById('connection-banner').classList.add('visible');
}

function cancelConnectionMode() {
  connectionSourceId = null;
  graph.setSelected(null);
  document.getElementById('connection-banner').classList.remove('visible');
}

document.getElementById('cancel-connect').addEventListener('click', cancelConnectionMode);

// ========== MERGE MODE ==========

function startMergeMode(sourceId) {
  mergeSourceId = sourceId;
  graph.setSelected(sourceId);
  document.getElementById('merge-banner').classList.add('visible');
}

function cancelMergeMode() {
  mergeSourceId = null;
  graph.setSelected(null);
  document.getElementById('merge-banner').classList.remove('visible');
}

document.getElementById('cancel-merge').addEventListener('click', cancelMergeMode);

// ========== NODE CLICK HANDLER ==========

function handleNodeClick(nodeId, event) {
  if (connectionSourceId) {
    if (nodeId !== connectionSourceId) {
      socket.emit('connect-nodes', { sourceId: connectionSourceId, targetId: nodeId });
    }
    cancelConnectionMode();
    return;
  }

  if (mergeSourceId) {
    if (nodeId !== mergeSourceId) {
      socket.emit('merge-nodes', { keepId: nodeId, mergeId: mergeSourceId });
    }
    cancelMergeMode();
    return;
  }

  // Default: select/deselect
  if (graph.selectedNodeId === nodeId) {
    graph.setSelected(null);
  } else {
    graph.setSelected(nodeId);
  }
}

// ========== NODE DOUBLE-CLICK: EXPLORE IN PERSONAL WORKSPACE (F7) ==========

function handleNodeDoubleClick(nodeId) {
  // Block if waiting for LLM response or in connection/merge mode
  if (activeThreadId) return;
  if (connectionSourceId || mergeSourceId) return;

  const nodeData = graph.nodeMap.get(nodeId);
  if (!nodeData) return;

  // Auto-expand panel if collapsed
  const chatPanel = document.getElementById('chat-panel');
  const chatToggle = document.getElementById('chat-toggle');
  if (chatPanel.classList.contains('collapsed')) {
    chatPanel.classList.remove('collapsed');
    chatToggle.textContent = '\u25C0'; // ◀
  }

  // Build prompt
  const title = nodeData.title;
  const description = nodeData.description || '';
  const prompt = description
    ? `Tell me more about "${title}": ${description}`
    : `Tell me more about "${title}"`;

  // Create root-level thread with origin 'graph'
  const threadNode = createThreadNode(prompt, null, 'graph');
  threadNode.breadcrumb = [title];

  renderThreadSection(threadNode);
  showTypingIndicator(threadNode);

  chatHistory.push({ role: 'user', content: prompt });
  activeThreadId = threadNode.id;
  chatSend.disabled = true;
  chatCancel.style.display = '';
  socket.emit('chat', { messages: chatHistory });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ========== TOOLBAR ==========

document.getElementById('btn-fit-view').addEventListener('click', () => {
  if (graph) graph.fitView();
});

document.getElementById('btn-auto-layout').addEventListener('click', () => {
  if (graph) graph.autoLayout();
});

// ========== PANEL TOGGLES ==========

document.getElementById('chat-toggle').addEventListener('click', () => {
  const panel = document.getElementById('chat-panel');
  const toggle = document.getElementById('chat-toggle');
  panel.classList.toggle('collapsed');
  toggle.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
});

document.getElementById('activity-toggle').addEventListener('click', () => {
  const panel = document.getElementById('activity-panel');
  panel.classList.toggle('collapsed');
});

// ========== RESIZABLE CHAT PANEL ==========

(function initChatResize() {
  const chatPanel = document.getElementById('chat-panel');
  const handle = document.getElementById('chat-resize-handle');
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 600;

  // Restore saved width
  const savedWidth = localStorage.getItem('tapestry-chat-width');
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= MIN_WIDTH && w <= MAX_WIDTH) {
      chatPanel.style.setProperty('--chat-panel-width', w + 'px');
    }
  }

  let isDragging = false;
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    startX = e.clientX;
    startWidth = chatPanel.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
    chatPanel.style.setProperty('--chat-panel-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const currentWidth = chatPanel.getBoundingClientRect().width;
    localStorage.setItem('tapestry-chat-width', Math.round(currentWidth));
  });
})();

// ========== CLEAR WORKSPACE ==========

document.getElementById('clear-workspace-btn').addEventListener('click', () => {
  chatHistory = [];
  threadTree = [];
  threadMap = new Map();
  threadIdCounter = 0;
  activeThreadId = null;
  document.getElementById('chat-messages').innerHTML = '';
});

// ========== LEAVE ROOM ==========

document.getElementById('leave-room-btn').addEventListener('click', () => {
  socket.emit('leave-room');
});

socket.on('left-room', () => {
  // Reset all app state
  currentUser = null;
  currentRoom = null;
  chatHistory = [];
  threadTree = [];
  threadMap = new Map();
  threadIdCounter = 0;
  activeThreadId = null;
  connectionSourceId = null;
  mergeSourceId = null;
  pendingHarvest = null;
  selectedRoomId = null;
  myUpvotes = new Set();
  graphTitleMap = new Map();

  // Clear DOM
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('activity-list').innerHTML = '';

  // Destroy graph
  if (graph) {
    graph.nodes = [];
    graph.edges = [];
    graph.nodeMap.clear();
    graph.edgeMap.clear();
    graph.render();
    graph = null;
  }

  // Clear graph SVG
  document.getElementById('graph-svg').innerHTML = '';

  // Hide banners
  document.getElementById('connection-banner').classList.remove('visible');
  document.getElementById('merge-banner').classList.remove('visible');

  // Switch screens
  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('login-screen').style.display = 'flex';

  // Refresh room list
  loadRooms();
});

// ========== ACTIVITY LOG ==========

function addActivityItem(item) {
  const list = document.getElementById('activity-list');
  const el = document.createElement('div');
  el.className = 'activity-item';

  const time = item.created_at
    ? new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const actionVerbs = {
    'joined': 'joined the room',
    'left': 'left the room',
    'harvested': 'harvested',
    'connected': 'connected',
    'expanded': 'expanded',
    'elaborated': 'elaborated',
    'pruned': 'pruned',
    'merged': 'merged',
    'upvoted': 'upvoted',
    'seed': 'seeded'
  };

  const verb = actionVerbs[item.action] || item.action;
  const detail = item.details ? ` <span class="activity-detail">${escapeHtml(item.details)}</span>` : '';

  el.innerHTML = `<span class="activity-user">${escapeHtml(item.user_name || 'System')}</span> ${verb}${detail} <span class="activity-time">${time}</span>`;

  list.prepend(el);

  // Keep max 100 items
  while (list.children.length > 100) {
    list.removeChild(list.lastChild);
  }
}

// ========== USER COUNT ==========

function updateUserCount(count) {
  document.getElementById('user-count').textContent = `${count} user${count !== 1 ? 's' : ''}`;
}

// ========== UTILS ==========

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== INIT ==========

loadRooms();

// Close context menu on escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    cancelConnectionMode();
    cancelMergeMode();
  }
});
