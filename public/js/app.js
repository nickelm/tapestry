// app.js — Main application logic

const socket = io();
let graph;
let currentUser = null;
let currentRoom = null;
let chatHistory = [];
let connectionSourceId = null;
let mergeSourceId = null;
let pendingHarvest = null;
let selectedRoomId = null;
let myUpvotes = new Set();

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

  // Load existing state
  const res = await fetch(`/api/rooms/${selectedRoomId}/state`);
  const state = await res.json();

  // Track which nodes the current user has upvoted
  myUpvotes = new Set(
    (state.upvotes || []).filter(u => u.user_id === currentUser.id).map(u => u.node_id)
  );
  graph.userUpvotes = myUpvotes;
  graph.loadState(state);

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
});

socket.on('node-removed', ({ id }) => {
  graph.removeNode(id);
});

socket.on('node-updated', (updates) => {
  graph.updateNode(updates.id, updates);
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
  graph.mergeNodes(keepId, mergeId, { title, description, merged_count: (graph.nodeMap.get(keepId)?.merged_count || 0) + 1, contributors });
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

chatSend.addEventListener('click', sendChat);

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  // Add user message to UI
  appendChatMessage('user', text);
  chatHistory.push({ role: 'user', content: text });

  chatInput.value = '';
  chatInput.style.height = '40px';
  chatSend.disabled = true;

  // Show typing indicator
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-msg assistant';
  typingEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  typingEl.id = 'typing-indicator';
  chatMessages.appendChild(typingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  socket.emit('chat', { messages: chatHistory });
}

socket.on('chat-response', ({ text, concepts }) => {
  // Remove typing indicator
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();

  chatSend.disabled = false;

  // Add to history
  chatHistory.push({ role: 'assistant', content: text });

  // Render response with concept chips
  appendChatResponse(text, concepts);
});

socket.on('chat-error', ({ message }) => {
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();
  chatSend.disabled = false;
  appendChatMessage('assistant', 'Sorry, something went wrong. Please try again.');
});

function appendChatMessage(role, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendChatResponse(text, concepts) {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';

  // Convert text to paragraphs
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  let html = paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('');

  // Add concept chips
  if (concepts && concepts.length > 0) {
    html += '<div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">';
    concepts.forEach((concept, i) => {
      html += `<span class="concept-chip" data-index="${i}" data-title="${escapeAttr(concept.title)}" data-description="${escapeAttr(concept.description)}" title="${escapeAttr(concept.description)}">
        ${escapeHtml(concept.title)}
        <button class="harvest-btn" data-index="${i}">+</button>
      </span>`;
    });
    html += '</div>';
  }

  el.innerHTML = html;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Attach harvest handlers
  el.querySelectorAll('.harvest-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = btn.closest('.concept-chip');
      const title = chip.dataset.title;
      const description = chip.dataset.description;

      if (chip.classList.contains('harvested')) return;

      chip.classList.add('harvested');
      btn.textContent = '✓';

      socket.emit('harvest', { title, description });
    });
  });
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
