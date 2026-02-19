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
let pendingHarvestExtra = null; // stores {related, broader} during duplicate modal
let selectedRoomId = null;
let myUpvotes = new Set();
let graphTitleMap = new Map(); // lowercase title -> nodeId (F10: shared graph awareness)
let lastInteractionEventType = null;
let isAdmin = false;

// ========== PDF.JS DYNAMIC LOADER (F17) ==========
let _pdfJsLoaded = false;
function loadPdfJs() {
  if (_pdfJsLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      _pdfJsLoaded = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ========== TOAST NOTIFICATIONS ==========
function showToast(message, durationMs = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

// ========== ADMIN AUTH ==========

(async function initAdminAuth() {
  const urlParams = new URLSearchParams(window.location.search);
  const adminSecret = urlParams.get('admin');

  if (adminSecret) {
    try {
      const res = await fetch(`/api/auth/admin?secret=${encodeURIComponent(adminSecret)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.role === 'admin') isAdmin = true;
      }
    } catch (e) {
      console.error('Admin auth failed:', e);
    }
    history.replaceState(null, '', window.location.pathname);
  } else {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.role === 'admin') isAdmin = true;
    } catch (e) {
      // Not authenticated
    }
  }

  updateAdminUI();
})();

function updateAdminUI() {
  const toggle = document.getElementById('create-room-toggle');
  if (isAdmin) {
    toggle.classList.remove('hidden');
  }
}

// ========== MARKED.JS CONFIG ==========
marked.setOptions({ gfm: true, breaks: true });

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

function getThreadMessages(threadNode) {
  const chain = [];
  let current = threadNode;
  while (current) {
    chain.unshift(current);
    current = current.parentId ? threadMap.get(current.parentId) : null;
  }
  const messages = [];
  for (const node of chain) {
    messages.push({ role: 'user', content: node.prompt });
    if (node.response) {
      messages.push({ role: 'assistant', content: node.response });
    }
  }
  return messages;
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

  list.innerHTML = rooms.map(r => {
    const stateLabel = r.state && r.state !== 'normal' ? `<span class="room-state-badge ${r.state}">${r.state === 'in-progress' ? 'in progress' : r.state}</span>` : '';
    const deleteBtn = isAdmin ? `<button class="room-delete-btn" data-room-id="${r.id}" title="Delete room">&times;</button>` : '';
    const closedClass = (!isAdmin && r.state === 'closed') ? ' room-closed' : '';
    return `<div class="room-item${closedClass}" data-room-id="${r.id}" data-room-state="${r.state || 'normal'}">
      <span class="room-name">${r.name}</span>
      ${stateLabel}
      <span class="room-item-right">${deleteBtn}<span class="room-arrow">&rarr;</span></span>
    </div>`;
  }).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.room-delete-btn')) return;
      // Block non-admin from selecting closed rooms
      if (!isAdmin && el.dataset.roomState === 'closed') return;
      list.querySelectorAll('.room-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      selectedRoomId = el.dataset.roomId;
      updateJoinButton();
    });
  });

  list.querySelectorAll('.room-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const roomId = btn.dataset.roomId;
      const roomName = btn.closest('.room-item').querySelector('.room-name').textContent;
      if (!confirm(`Delete room "${roomName}"? This cannot be undone.`)) return;
      await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
      if (selectedRoomId === roomId) selectedRoomId = null;
      updateJoinButton();
      loadRooms();
    });
  });
}

function updateJoinButton() {
  const name = document.getElementById('login-name').value.trim();
  document.getElementById('join-btn').disabled = !(name && selectedRoomId);
}

document.getElementById('login-name').addEventListener('input', updateJoinButton);

document.getElementById('create-room-toggle').addEventListener('click', () => {
  document.getElementById('create-room-form').classList.toggle('visible');
});

document.getElementById('create-room-cancel').addEventListener('click', () => {
  document.getElementById('create-room-form').classList.remove('visible');
  resetCreateRoomForm();
});

// Mutual exclusivity: PDF file vs pasted text
document.getElementById('paper-file-input').addEventListener('change', (e) => {
  const textarea = document.getElementById('paper-text-input');
  if (e.target.files.length > 0) {
    textarea.value = '';
    textarea.disabled = true;
  } else {
    textarea.disabled = false;
  }
});

document.getElementById('paper-text-input').addEventListener('input', (e) => {
  const fileInput = document.getElementById('paper-file-input');
  if (e.target.value.trim()) {
    fileInput.disabled = true;
  } else {
    fileInput.disabled = false;
  }
});

function resetCreateRoomForm() {
  document.getElementById('new-room-name').value = '';
  const fileInput = document.getElementById('paper-file-input');
  fileInput.value = '';
  fileInput.disabled = false;
  const textInput = document.getElementById('paper-text-input');
  textInput.value = '';
  textInput.disabled = false;
  document.getElementById('extract-concepts-checkbox').checked = true;
  const status = document.getElementById('create-room-status');
  status.classList.remove('visible');
  status.innerHTML = '';
  const progress = document.getElementById('create-room-progress');
  progress.classList.remove('visible');
  progress.querySelectorAll('.progress-step').forEach(s => s.classList.remove('active', 'done'));
  progress.querySelectorAll('.progress-step-connector').forEach(c => c.classList.remove('done'));
  document.getElementById('progress-bar-fill').style.width = '0%';
  document.getElementById('progress-bar-fill').classList.remove('indeterminate');
  document.getElementById('progress-status').textContent = '';
}

document.getElementById('create-room-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-room-name').value.trim();
  if (!name) return;

  const fileInput = document.getElementById('paper-file-input');
  const pastedText = document.getElementById('paper-text-input').value.trim();
  const extractChecked = document.getElementById('extract-concepts-checkbox').checked;
  const statusEl = document.getElementById('create-room-status');
  const createBtn = document.getElementById('create-room-btn');
  const loginCard = document.querySelector('.login-card');

  const progressEl = document.getElementById('create-room-progress');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressStatus = document.getElementById('progress-status');
  const steps = progressEl.querySelectorAll('.progress-step');
  const connectors = progressEl.querySelectorAll('.progress-step-connector');

  const hasPaper = fileInput.files.length > 0 || pastedText;
  const willExtract = extractChecked && hasPaper;

  createBtn.disabled = true;

  function setStep(stepName, statusText) {
    const stepOrder = ['create', 'extract', 'review'];
    const idx = stepOrder.indexOf(stepName);
    steps.forEach((s, i) => {
      s.classList.remove('active', 'done');
      if (i < idx) s.classList.add('done');
      else if (i === idx) s.classList.add('active');
    });
    connectors.forEach((c, i) => {
      c.classList.toggle('done', i < idx);
    });
    // Progress bar: 0% at create, 33% during extract, 66% at review, 100% done
    const pct = idx === 0 ? 10 : idx === 1 ? 40 : 75;
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = pct + '%';
    progressStatus.textContent = statusText;
  }

  function setIndeterminate(statusText) {
    progressFill.classList.add('indeterminate');
    progressFill.style.width = '';
    progressStatus.textContent = statusText;
  }

  function setDone(statusText) {
    steps.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
    connectors.forEach(c => c.classList.add('done'));
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '100%';
    progressStatus.textContent = statusText;
  }

  // Lock UI and show progress
  loginCard.classList.add('locked');
  statusEl.classList.remove('visible');
  progressEl.classList.add('visible');

  setStep('create', 'Creating room...');

  try {
    const formData = new FormData();
    formData.append('name', name);

    if (fileInput.files.length > 0) {
      formData.append('paper', fileInput.files[0]);
    } else if (pastedText) {
      formData.append('pastedText', pastedText);
    }

    const res = await fetch('/api/rooms', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to create room');
    }

    const room = await res.json();
    selectedRoomId = room.id;

    // Extract and seed if requested
    if (willExtract) {
      setStep('extract', 'Extracting concepts from paper...');
      setIndeterminate('Extracting concepts from paper...');

      const extractRes = await fetch(`/api/rooms/${room.id}/extract-concepts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (extractRes.ok) {
        const extractData = await extractRes.json();
        const concepts = extractData.concepts || [];

        if (concepts.length > 0) {
          setStep('review', 'Review extracted concepts below.');

          // Show preview modal and wait for user decision
          const result = await showSeedPreviewModal(room.id, extractData);
          if (result && result.seeded) {
            setDone(`Seeded ${result.count} concepts.`);
          } else {
            setDone('Room created without seed concepts.');
          }
        } else {
          setDone('No concepts extracted. Room created.');
        }
      } else {
        setDone('Extraction failed. Room created without seed concepts.');
      }
    } else {
      setDone('Room created.');
    }

    await loadRooms();
    const items = document.querySelectorAll('.room-item');
    items.forEach(el => {
      if (el.dataset.roomId === room.id) {
        el.classList.add('selected');
      }
    });
    updateJoinButton();

    setTimeout(() => {
      document.getElementById('create-room-form').classList.remove('visible');
      resetCreateRoomForm();
      progressEl.classList.remove('visible');
      loginCard.classList.remove('locked');
      createBtn.disabled = false;
    }, 1500);

  } catch (e) {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '0%';
    progressStatus.textContent = `Error: ${e.message}`;
    loginCard.classList.remove('locked');
    createBtn.disabled = false;
  }
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
  graph.onEdgeContext = showEdgeContextMenu;
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
  graph.onPaperDoubleClick = openPdfPanel;

  // Load existing state
  const res = await fetch(`/api/rooms/${selectedRoomId}/state`);
  const state = await res.json();

  // Track which nodes the current user has upvoted
  myUpvotes = new Set(
    (state.upvotes || []).filter(u => u.user_id === currentUser.id).map(u => u.node_id)
  );
  graph.userUpvotes = myUpvotes;
  graph.loadState(state);

  // Load paper overlay if room has an attached PDF (F17)
  if (room.has_paper && room.paper_filename) {
    loadPdfJs().then(async () => {
      try {
        const pdfDoc = await pdfjsLib.getDocument(`/api/rooms/${room.id}/paper`).promise;
        graph.showPaper(pdfDoc, room.paper_title || 'Paper', `/api/rooms/${room.id}/paper`);
        document.getElementById('pdf-panel').classList.remove('no-paper');
      } catch (err) {
        console.error('Failed to load paper PDF:', err);
      }
    }).catch(err => {
      console.error('Failed to load pdf.js library:', err);
    });
  }

  // Build shared graph title index (F10)
  graphTitleMap.clear();
  (state.nodes || []).forEach(n => graphTitleMap.set(n.title.toLowerCase(), n.id));

  // Populate activity log
  if (state.activity) {
    state.activity.reverse().forEach(addActivityItem);
  }

  updateUserCount(state.userCount || 1);

  // Initialize admin controls after joining
  if (isAdmin) {
    initAdminControls(room);
  }

  // Initialize room timer state (but don't show to users until admin starts it)
  if (room.durationMinutes) {
    roomTimerState.durationMinutes = room.durationMinutes;
    roomTimerState.remainingSeconds = room.durationMinutes * 60;
    updateRoomTimerDisplay();
  }

  // Initialize ESM if eval mode is on
  resetEsmState();
  if (room.esmCadenceMinutes) {
    esmState.cadenceMinutes = room.esmCadenceMinutes;
  }
  if (room.evalMode) {
    esmState.enabled = true;
    scheduleNextEsm();
  }
});

// ========== ROOM DETAILS PANEL ==========

const roomDetailsPanel = document.getElementById('room-details-panel');
const roomDetailsName = document.getElementById('room-details-name');
const roomDetailsSummary = document.getElementById('room-details-summary');
const roomDetailsActions = document.getElementById('room-details-actions');
const roomDetailsSave = document.getElementById('room-details-save');
const roomDetailsCancel = document.getElementById('room-details-cancel');

document.getElementById('room-label').addEventListener('click', (e) => {
  e.stopPropagation();
  if (roomDetailsPanel.classList.contains('visible')) {
    closeRoomDetailsPanel();
  } else {
    openRoomDetailsPanel();
  }
});

function openRoomDetailsPanel() {
  if (!currentRoom) return;

  roomDetailsName.value = currentRoom.name;
  roomDetailsSummary.value = currentRoom.summary || '';

  if (isAdmin) {
    roomDetailsName.removeAttribute('readonly');
    roomDetailsSummary.removeAttribute('readonly');
    roomDetailsSummary.placeholder = 'Add a summary to guide LLM responses...';
    roomDetailsActions.classList.remove('hidden');
  } else {
    roomDetailsName.setAttribute('readonly', true);
    roomDetailsSummary.setAttribute('readonly', true);
    roomDetailsSummary.placeholder = 'No summary set';
    roomDetailsActions.classList.add('hidden');
  }

  roomDetailsPanel.classList.add('visible');
  document.getElementById('room-label').classList.add('panel-open');
}

function closeRoomDetailsPanel() {
  roomDetailsPanel.classList.remove('visible');
  document.getElementById('room-label').classList.remove('panel-open');
}

document.addEventListener('click', (e) => {
  if (roomDetailsPanel.classList.contains('visible')
      && !roomDetailsPanel.contains(e.target)
      && e.target !== document.getElementById('room-label')) {
    closeRoomDetailsPanel();
  }
});

roomDetailsCancel.addEventListener('click', () => {
  closeRoomDetailsPanel();
});

roomDetailsSave.addEventListener('click', async () => {
  const newName = roomDetailsName.value.trim();
  const newSummary = roomDetailsSummary.value;

  if (!newName) {
    roomDetailsName.focus();
    return;
  }

  try {
    const res = await fetch(`/api/rooms/${currentRoom.id}/details`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, summary: newSummary })
    });
    if (res.ok) {
      closeRoomDetailsPanel();
      showToast('Room details updated');
    } else {
      const err = await res.json();
      showToast(err.error || 'Failed to update');
    }
  } catch (e) {
    showToast('Failed to update room details');
  }
});

socket.on('error', ({ message }) => {
  console.error('Socket error:', message);
  // Show user-facing errors (e.g., "This room is closed")
  if (message && document.getElementById('login-screen').style.display !== 'none') {
    alert(message);
  }
});

// ========== SOCKET: REAL-TIME EVENTS ==========

socket.on('node-added', (node) => {
  graph.addNode(node);
  if (!node.hidden) {
    graphTitleMap.set(node.title.toLowerCase(), node.id);
  }
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
  edge.directed = edge.directed !== undefined ? !!edge.directed : true;
  graph.addEdge(edge);
});

socket.on('edge-label-updated', ({ id, label, directed }) => {
  graph.updateEdgeLabel(id, label);
  if (directed !== undefined) {
    graph.updateEdgeDirected(id, !!directed);
  }
});

socket.on('edge-removed', ({ id }) => {
  graph.removeEdge(id);
});

socket.on('edge-direction-flipped', ({ id, source_id, target_id }) => {
  graph.flipEdgeDirection(id, source_id, target_id);
});

socket.on('edge-directed-toggled', ({ id, directed }) => {
  graph.updateEdgeDirected(id, !!directed);
});

socket.on('suggest-connections', ({ nodeId, nodeTitle, suggestions }) => {
  showConnectionsModal(nodeId, nodeTitle, suggestions);
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
  const adminCount = document.getElementById('admin-user-count');
  if (adminCount) adminCount.textContent = count;
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
  lastInteractionEventType = 'chat:send';

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

  socket.emit('chat', {
    messages: getThreadMessages(threadNode),
    roomName: currentRoom.name,
    breadcrumb: threadNode.breadcrumb
  });
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

  // Set active thread, send thread-scoped history
  chatHistory.push({ role: 'user', content: prompt });
  activeThreadId = threadNode.id;
  chatSend.disabled = true;
  chatCancel.style.display = '';
  socket.emit('chat', {
    messages: getThreadMessages(threadNode),
    roomName: currentRoom.name,
    breadcrumb: threadNode.breadcrumb
  });
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

// Highlight a single concept title in DOM text nodes (skips code/pre elements).
// Returns true if a match was found and highlighted, false otherwise.
function highlightConceptInDOM(container, concept, index) {
  const titleLower = concept.title.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text inside <code> and <pre> elements
      let parent = node.parentNode;
      while (parent && parent !== container) {
        if (parent.tagName === 'CODE' || parent.tagName === 'PRE') return NodeFilter.FILTER_REJECT;
        parent = parent.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const matchIdx = node.textContent.toLowerCase().indexOf(titleLower);
    if (matchIdx === -1) continue;

    // Split text node and wrap the match in a concept span
    const matchEnd = matchIdx + concept.title.length;
    const before = node.textContent.substring(0, matchIdx);
    const matchText = node.textContent.substring(matchIdx, matchEnd);
    const after = node.textContent.substring(matchEnd);

    const secondaryClass = concept.type === 'secondary' ? ' secondary' : '';
    const inGraphClass = graphTitleMap.has(concept.title.toLowerCase()) ? ' in-graph' : '';
    const graphNodeIdAttr = graphTitleMap.has(concept.title.toLowerCase())
      ? graphTitleMap.get(concept.title.toLowerCase()) : '';

    const span = document.createElement('span');
    span.className = `concept-inline${secondaryClass}${inGraphClass}`;
    span.dataset.conceptTitle = concept.title;
    span.dataset.conceptDescription = concept.description || '';
    span.dataset.conceptType = concept.type || 'primary';
    span.dataset.conceptIndex = index;
    if (graphNodeIdAttr) span.dataset.graphNodeId = graphNodeIdAttr;
    span.textContent = matchText;

    const parentNode = node.parentNode;
    if (after) parentNode.insertBefore(document.createTextNode(after), node.nextSibling);
    parentNode.insertBefore(span, node.nextSibling);
    if (before) parentNode.insertBefore(document.createTextNode(before), span);
    parentNode.removeChild(node);

    return true; // Only highlight first occurrence
  }
  return false;
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

  // Render markdown to HTML
  el.innerHTML = marked.parse(text);

  // Inline concept highlighting: walk DOM text nodes to find and wrap matches
  const unmatchedConcepts = [];
  if (allConcepts.length > 0) {
    allConcepts.forEach((concept, i) => {
      if (!highlightConceptInDOM(el, concept, i)) {
        unmatchedConcepts.push({ concept, index: i });
      }
    });

    // Fallback: append chips for concepts not found in text
    if (unmatchedConcepts.length > 0) {
      const chipsDiv = document.createElement('div');
      chipsDiv.style.cssText = 'margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;';
      unmatchedConcepts.forEach(({ concept, index }) => {
        const secondaryClass = concept.type === 'secondary' ? ' secondary' : '';
        const chipInGraph = graphTitleMap.has(concept.title.toLowerCase());
        const chipInGraphClass = chipInGraph ? ' in-graph' : '';
        const chipGraphAttr = chipInGraph
          ? ` data-graph-node-id="${graphTitleMap.get(concept.title.toLowerCase())}"` : '';
        const chipBtnText = chipInGraph ? '\u25C9' : '+';
        chipsDiv.innerHTML += `<span class="concept-chip${secondaryClass}${chipInGraphClass}" data-index="${index}" data-title="${escapeAttr(concept.title)}" data-description="${escapeAttr(concept.description || '')}" data-type="${concept.type || 'primary'}"${chipGraphAttr} title="${escapeHtml(concept.title)}">
          ${escapeHtml(concept.title)}
          <button class="harvest-btn" data-index="${index}">${chipBtnText}</button>
        </span>`;
      });
      el.appendChild(chipsDiv);
    }
  }

  // Attach harvest handlers for fallback chip buttons
  el.querySelectorAll('.harvest-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const chip = btn.closest('.concept-chip');

      // F10: in-graph chips navigate to the graph node instead of harvesting
      if (chip.classList.contains('in-graph') && chip.dataset.graphNodeId) {
        graph.focusNode(chip.dataset.graphNodeId);
        return;
      }

      if (chip.classList.contains('harvested')) return;

      const title = chip.dataset.title;
      let description = chip.dataset.description;

      chip.classList.add('harvested');
      btn.textContent = '\u2713';

      // Auto-generate description if empty
      if (!description) {
        const breadcrumb = getBreadcrumbForSpan(chip);
        const generated = await fetchConceptDescription(title, breadcrumb);
        if (generated) description = generated;
      }

      lastInteractionEventType = 'concept:harvest';
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

async function fetchConceptDescription(title, breadcrumb, excerpt = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`/api/rooms/${currentRoom.id}/describe-concept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, breadcrumb, excerpt }),
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
  harvestFormDesc.value = span.dataset.conceptDescription || '';
  activeConceptSpan = span; // restore after hideTooltip cleared it

  // Auto-generate description if not cached (user never hovered to trigger lazy-load)
  if (!harvestFormDesc.value) {
    harvestFormDesc.placeholder = 'Generating description\u2026';
    const breadcrumb = getBreadcrumbForSpan(span);
    fetchConceptDescription(span.dataset.conceptTitle, breadcrumb).then(desc => {
      if (!harvestFormDesc.value) {
        harvestFormDesc.value = desc || '';
      }
      harvestFormDesc.placeholder = 'Add a description...';
    });
  }

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

  lastInteractionEventType = 'concept:harvest';
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
    fetchConceptDescription(title, breadcrumb, selectedText).then(desc => {
      // Only populate if user hasn't typed anything yet
      if (!harvestFormDesc.value) {
        harvestFormDesc.value = desc || '';
      }
      harvestFormDesc.placeholder = 'Add a description...';
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
  socket.emit('chat', {
    messages: getThreadMessages(threadNode),
    roomName: currentRoom.name,
    breadcrumb: threadNode.breadcrumb
  });
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

socket.on('similar-found', ({ newConcept, duplicates, related, broader }) => {
  pendingHarvest = newConcept;
  pendingHarvestExtra = { related: related || [], broader: broader || [] };

  const modal = document.getElementById('similar-modal');
  document.getElementById('similar-modal-heading').textContent = 'Possible duplicates found';
  document.getElementById('similar-new-concept').textContent =
    `"${newConcept.title}" may already exist in the graph:`;

  const list = document.getElementById('similar-list');
  list.innerHTML = duplicates.map(s =>
    `<div class="similar-item">
      <div class="similar-title">${escapeHtml(s.title)}</div>
      <div class="similar-desc">${escapeHtml(s.description)}</div>
      ${s.reason ? `<div class="similar-reason">${escapeHtml(s.reason)}</div>` : ''}
    </div>`
  ).join('');

  modal.classList.add('visible');
});

document.getElementById('similar-add-anyway').addEventListener('click', () => {
  if (pendingHarvest) {
    const extra = pendingHarvestExtra || { related: [], broader: [] };
    socket.emit('force-harvest', {
      ...pendingHarvest,
      broader: extra.broader,
      related: extra.related
    });

    pendingHarvest = null;
    pendingHarvestExtra = null;
  }
  document.getElementById('similar-modal').classList.remove('visible');
});

document.getElementById('similar-cancel').addEventListener('click', () => {
  pendingHarvest = null;
  pendingHarvestExtra = null;
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

    lastInteractionEventType = 'graph:' + action;
    switch (action) {
      case 'explore':
        handleNodeDoubleClick(contextNodeId);
        break;
      case 'expand':
        socket.emit('expand-node', { nodeId: contextNodeId });
        break;
      case 'suggest-connections':
        socket.emit('suggest-connections', { nodeId: contextNodeId });
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

// ========== EDGE CONTEXT MENU ==========

const edgeContextMenu = document.getElementById('edge-context-menu');
let contextEdgeId = null;

function showEdgeContextMenu(edgeId, x, y) {
  contextEdgeId = edgeId;
  hideContextMenu(); // hide node context menu if open
  const edge = graph.edgeMap.get(edgeId);
  if (!edge) return;

  // Show/hide "Flip direction" only for directed edges
  const flipItem = edgeContextMenu.querySelector('[data-action="flip-direction"]');
  flipItem.style.display = edge.directed ? '' : 'none';

  // Update toggle label
  const toggleItem = edgeContextMenu.querySelector('[data-action="toggle-directed"]');
  toggleItem.querySelector('.cm-label').textContent = edge.directed ? 'Make symmetric' : 'Make directed';

  edgeContextMenu.style.left = x + 'px';
  edgeContextMenu.style.top = y + 'px';
  edgeContextMenu.classList.add('visible');
}

function hideEdgeContextMenu() {
  edgeContextMenu.classList.remove('visible');
  contextEdgeId = null;
}

document.addEventListener('click', () => hideEdgeContextMenu());

edgeContextMenu.querySelectorAll('.context-menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = item.dataset.action;
    if (!contextEdgeId) return;

    switch (action) {
      case 'flip-direction':
        socket.emit('flip-edge-direction', { edgeId: contextEdgeId });
        break;
      case 'toggle-directed':
        socket.emit('toggle-edge-directed', { edgeId: contextEdgeId });
        break;
      case 'delete-edge':
        socket.emit('delete-edge', { edgeId: contextEdgeId });
        break;
    }
    hideEdgeContextMenu();
  });
});

// ========== CANVAS CONTEXT MENU ==========

const canvasContextMenu = document.getElementById('canvas-context-menu');

function showCanvasContextMenu(x, y) {
  hideContextMenu();
  hideEdgeContextMenu();
  canvasContextMenu.style.left = x + 'px';
  canvasContextMenu.style.top = y + 'px';
  canvasContextMenu.classList.add('visible');
}

function hideCanvasContextMenu() {
  canvasContextMenu.classList.remove('visible');
}

document.addEventListener('click', () => hideCanvasContextMenu());

let canvasClickX = 0;
let canvasClickY = 0;

canvasContextMenu.querySelectorAll('.context-menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = item.dataset.action;
    if (action === 'export-svg') triggerExportSVG();
    if (action === 'add-concept') showManualSeedForm(canvasClickX, canvasClickY);
    hideCanvasContextMenu();
  });
});

document.getElementById('graph-svg').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  canvasClickX = event.clientX;
  canvasClickY = event.clientY;
  showCanvasContextMenu(event.clientX, event.clientY);
});

// ========== MANUAL SEED FORM (F15) ==========

const manualSeedForm = document.getElementById('manual-seed-form');
const manualSeedInput = document.getElementById('manual-seed-input');
const manualSeedHint = document.getElementById('manual-seed-hint');

function showManualSeedForm(screenX, screenY) {
  manualSeedInput.value = '';
  manualSeedHint.textContent = 'Enter to add \u00b7 Esc to cancel';
  manualSeedHint.classList.remove('error');
  manualSeedInput.classList.remove('error');
  manualSeedInput.disabled = false;

  manualSeedForm.style.left = screenX + 'px';
  manualSeedForm.style.top = screenY + 'px';
  manualSeedForm.classList.add('visible');

  // Store screen coordinates for graph-space conversion
  manualSeedForm.dataset.screenX = screenX;
  manualSeedForm.dataset.screenY = screenY;

  setTimeout(() => manualSeedInput.focus(), 0);
}

function hideManualSeedForm() {
  manualSeedForm.classList.remove('visible');
  manualSeedInput.value = '';
}

function screenToGraphCoords(screenX, screenY) {
  const svgRect = document.getElementById('graph-svg').getBoundingClientRect();
  const svgX = screenX - svgRect.left;
  const svgY = screenY - svgRect.top;
  const t = graph.currentTransform;
  return {
    x: (svgX - t.x) / t.k,
    y: (svgY - t.y) / t.k
  };
}

manualSeedInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    hideManualSeedForm();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const title = manualSeedInput.value.trim();

    if (title.length < 3) {
      manualSeedHint.textContent = 'Title must be at least 3 characters';
      manualSeedHint.classList.add('error');
      manualSeedInput.classList.add('error');
      return;
    }

    if (graphTitleMap.has(title.toLowerCase())) {
      manualSeedHint.textContent = 'This concept already exists in the graph';
      manualSeedHint.classList.add('error');
      manualSeedInput.classList.add('error');
      return;
    }

    const graphCoords = screenToGraphCoords(
      parseFloat(manualSeedForm.dataset.screenX),
      parseFloat(manualSeedForm.dataset.screenY)
    );

    manualSeedInput.disabled = true;
    manualSeedHint.textContent = 'Creating concept\u2026';
    manualSeedHint.classList.remove('error');
    manualSeedInput.classList.remove('error');

    try {
      const res = await fetch(`/api/rooms/${currentRoom.id}/manual-seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          username: currentUser.name,
          x: graphCoords.x,
          y: graphCoords.y
        })
      });

      if (!res.ok) {
        const err = await res.json();
        manualSeedHint.textContent = err.error || 'Failed to create concept';
        manualSeedHint.classList.add('error');
        manualSeedInput.disabled = false;
        manualSeedInput.focus();
        return;
      }

      hideManualSeedForm();
    } catch (err) {
      manualSeedHint.textContent = 'Network error';
      manualSeedHint.classList.add('error');
      manualSeedInput.disabled = false;
    }
  }
});

manualSeedInput.addEventListener('input', () => {
  manualSeedInput.classList.remove('error');
  manualSeedHint.textContent = 'Enter to add \u00b7 Esc to cancel';
  manualSeedHint.classList.remove('error');
});

document.addEventListener('click', (e) => {
  if (manualSeedForm.classList.contains('visible') && !manualSeedForm.contains(e.target)) {
    hideManualSeedForm();
  }
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

// ========== CONNECTIONS SUGGESTION MODAL ==========

let connectionsNodeId = null;
let connectionsSuggestions = [];
const selectedConnections = new Set();
const connectionsModal = document.getElementById('connections-modal');
const connectionsAddBtn = document.getElementById('connections-add');

function showConnectionsModal(nodeId, nodeTitle, suggestions) {
  connectionsNodeId = nodeId;
  connectionsSuggestions = suggestions;
  selectedConnections.clear();

  document.getElementById('connections-concept-name').textContent =
    `Suggested connections for "${nodeTitle}":`;

  const list = document.getElementById('connections-list');
  list.innerHTML = suggestions.map((s, i) => {
    const dots = Array.from({ length: 5 }, (_, d) =>
      `<span class="connections-strength-dot${d < s.strength ? ' filled' : ''}"></span>`
    ).join('');

    const desc = s.targetDescription
      ? `<div class="connections-item-description">${escapeHtml(s.targetDescription)}</div>`
      : '';

    return `<div class="connections-item" data-index="${i}">
      <input type="checkbox" data-index="${i}">
      <div class="connections-item-content">
        <div class="connections-item-header">
          <span class="connections-item-target">${escapeHtml(s.targetTitle)}</span>
          <span class="connections-item-label">${escapeHtml(s.label)}</span>
          <div class="connections-item-strength">${dots}</div>
        </div>
        ${desc}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.connections-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    const idx = parseInt(item.dataset.index);

    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });

    cb.addEventListener('change', () => {
      if (cb.checked) {
        item.classList.add('selected');
        selectedConnections.add(idx);
      } else {
        item.classList.remove('selected');
        selectedConnections.delete(idx);
      }
      connectionsAddBtn.disabled = selectedConnections.size === 0;
    });
  });

  connectionsAddBtn.disabled = true;
  connectionsModal.classList.add('visible');
}

function hideConnectionsModal() {
  connectionsModal.classList.remove('visible');
  connectionsNodeId = null;
  connectionsSuggestions = [];
  selectedConnections.clear();
}

connectionsAddBtn.addEventListener('click', () => {
  if (!connectionsNodeId || selectedConnections.size === 0) return;
  const connections = Array.from(selectedConnections).map(i => ({
    targetId: connectionsSuggestions[i].targetId,
    label: connectionsSuggestions[i].label,
    directed: connectionsSuggestions[i].directed
  }));
  socket.emit('accept-connections', { nodeId: connectionsNodeId, connections });
  hideConnectionsModal();
});

document.getElementById('connections-skip').addEventListener('click', hideConnectionsModal);

connectionsModal.addEventListener('click', (e) => {
  if (e.target === connectionsModal) hideConnectionsModal();
});

// ========== SEED PREVIEW MODAL ==========

let seedPreviewRoomId = null;
let seedPreviewData = null;
let seedPreviewResolve = null;
const seedPreviewModal = document.getElementById('seed-preview-modal');

const SEED_TYPE_COLORS = {
  entity: 'type-entity',
  concept: 'type-concept',
  method: 'type-method',
  artifact: 'type-artifact',
  event: 'type-event',
  property: 'type-property'
};

function showSeedPreviewModal(roomId, extractData) {
  seedPreviewRoomId = roomId;
  seedPreviewData = extractData;

  document.getElementById('seed-preview-title').textContent =
    extractData.paperTitle ? `Extracted from: "${extractData.paperTitle}"` : 'Extracted concepts';
  document.getElementById('seed-preview-subtitle').textContent =
    extractData.paperAuthors || '';

  const body = document.getElementById('seed-preview-body');
  const primaryConcepts = extractData.concepts.filter(c => c.tier === 'primary');
  const secondaryConcepts = extractData.concepts.filter(c => c.tier === 'secondary');
  const relationships = extractData.relationships || [];

  // Group secondary concepts by parent
  const secondaryByParent = {};
  for (const sc of secondaryConcepts) {
    const parent = sc.parentConcept || 'Other';
    if (!secondaryByParent[parent]) secondaryByParent[parent] = [];
    secondaryByParent[parent].push(sc);
  }

  let html = '';

  // --- Paper link info ---
  if (extractData.paperTitle) {
    html += `<div class="seed-preview-section" style="font-size:12px; color:var(--text-muted); font-weight:normal;">
      Primary concepts will be connected to the paper with labeled edges.
    </div>`;
  }

  // --- Primary Concepts ---
  html += `<div class="seed-preview-section">Primary Concepts (${primaryConcepts.length})</div>`;
  primaryConcepts.forEach((c, i) => {
    const typeClass = SEED_TYPE_COLORS[(c.type || 'concept').toLowerCase()] || 'type-concept';
    html += `<div class="seed-preview-item" data-tier="primary" data-index="${i}">
      <input type="checkbox" checked data-tier="primary" data-index="${i}">
      <span class="seed-preview-type-dot ${typeClass}" title="${escapeHtml(c.type || 'Concept')}"></span>
      <div class="seed-preview-item-content">
        <span class="seed-preview-item-title" data-tier="primary" data-index="${i}">${escapeHtml(c.title)}</span>
        <div class="seed-preview-item-desc">${escapeHtml(c.description || '')}</div>
      </div>
    </div>`;
  });

  // --- Secondary Concepts (grouped by parent) ---
  if (secondaryConcepts.length > 0) {
    html += `<div class="seed-preview-section">Secondary Concepts (${secondaryConcepts.length})</div>`;
    for (const [parentTitle, children] of Object.entries(secondaryByParent)) {
      html += `<div class="seed-preview-parent-label">${escapeHtml(parentTitle)}</div>`;
      html += '<div class="seed-preview-secondary">';
      children.forEach(c => {
        const globalIdx = secondaryConcepts.indexOf(c);
        const typeClass = SEED_TYPE_COLORS[(c.type || 'concept').toLowerCase()] || 'type-concept';
        html += `<div class="seed-preview-item" data-tier="secondary" data-index="${globalIdx}">
          <input type="checkbox" checked data-tier="secondary" data-index="${globalIdx}">
          <span class="seed-preview-type-dot ${typeClass}" title="${escapeHtml(c.type || 'Concept')}"></span>
          <div class="seed-preview-item-content">
            <span class="seed-preview-item-title" data-tier="secondary" data-index="${globalIdx}">${escapeHtml(c.title)}</span>
            <div class="seed-preview-item-desc">${escapeHtml(c.description || '')}</div>
          </div>
        </div>`;
      });
      html += '</div>';
    }
  }

  // --- Relationships ---
  if (relationships.length > 0) {
    html += `<div class="seed-preview-section">Relationships (${relationships.length})</div>`;
    relationships.forEach((r, i) => {
      const arrow = r.directed ? '\u2192' : '\u2194';
      html += `<div class="seed-preview-relationship" data-index="${i}">
        <input type="checkbox" checked data-rel-index="${i}">
        <span class="seed-preview-rel-text">
          <span class="rel-source">${escapeHtml(r.source)}</span>
          <span class="rel-arrow"> ${arrow} ${escapeHtml(r.label)} ${arrow} </span>
          <span class="rel-target">${escapeHtml(r.target)}</span>
        </span>
      </div>`;
    });
  }

  body.innerHTML = html;

  // --- Checkbox toggling ---
  body.querySelectorAll('.seed-preview-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.classList.contains('seed-preview-item-title') || e.target.classList.contains('seed-preview-item-title-input')) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    cb.addEventListener('change', () => {
      item.classList.toggle('unchecked', !cb.checked);
    });
  });

  body.querySelectorAll('.seed-preview-relationship').forEach(row => {
    const cb = row.querySelector('input[type="checkbox"]');
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
    cb.addEventListener('change', () => {
      row.classList.toggle('unchecked', !cb.checked);
    });
  });

  // --- Inline title editing ---
  body.querySelectorAll('.seed-preview-item-title').forEach(titleSpan => {
    titleSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      if (titleSpan.querySelector('input')) return;
      const currentText = titleSpan.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'seed-preview-item-title-input';
      input.value = currentText;
      titleSpan.textContent = '';
      titleSpan.appendChild(input);
      input.focus();
      input.select();

      function commit() {
        const newVal = input.value.trim() || currentText;
        titleSpan.textContent = newVal;
        // Update the stored data
        const tier = titleSpan.dataset.tier;
        const idx = parseInt(titleSpan.dataset.index);
        const list = tier === 'primary' ? primaryConcepts : secondaryConcepts;
        if (list[idx]) list[idx].title = newVal;
      }

      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
        if (ke.key === 'Escape') { titleSpan.textContent = currentText; }
      });
      input.addEventListener('blur', commit);
    });
  });

  seedPreviewModal.classList.add('visible');

  return new Promise(resolve => { seedPreviewResolve = resolve; });
}

function hideSeedPreviewModal(result) {
  seedPreviewModal.classList.remove('visible');
  seedPreviewRoomId = null;
  seedPreviewData = null;
  if (seedPreviewResolve) {
    seedPreviewResolve(result);
    seedPreviewResolve = null;
  }
}

function computeRadialPositions(concepts) {
  const primary = concepts.filter(c => c.tier === 'primary');
  const secondary = concepts.filter(c => c.tier === 'secondary');
  const startAngle = -Math.PI / 2; // Start at 12 o'clock
  const primaryGap = (2 * Math.PI) / Math.max(primary.length, 1);

  const parentAngleMap = new Map();
  primary.forEach((c, i) => {
    parentAngleMap.set(c.title, startAngle + primaryGap * i);
  });

  let orphanCounter = 0;

  return concepts.map(c => {
    let angle, radius;
    if (c.tier === 'primary') {
      radius = 300;
      angle = parentAngleMap.get(c.title);
    } else {
      radius = 500;
      const parentAngle = parentAngleMap.get(c.parentConcept);
      if (parentAngle != null) {
        const siblings = secondary.filter(s => s.parentConcept === c.parentConcept);
        const sibIdx = siblings.indexOf(c);
        const maxSpread = primaryGap * 0.4;
        const spread = Math.min(0.3, maxSpread / Math.max(siblings.length - 1, 1));
        angle = parentAngle + (sibIdx - (siblings.length - 1) / 2) * spread;
      } else {
        angle = startAngle + primaryGap * (orphanCounter + 0.5);
        orphanCounter++;
      }
    }
    return {
      title: c.title,
      description: c.description,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    };
  });
}

document.getElementById('seed-preview-confirm').addEventListener('click', async () => {
  if (!seedPreviewData || !seedPreviewRoomId) return;

  const body = document.getElementById('seed-preview-body');
  const primaryConcepts = seedPreviewData.concepts.filter(c => c.tier === 'primary');
  const secondaryConcepts = seedPreviewData.concepts.filter(c => c.tier === 'secondary');
  const relationships = seedPreviewData.relationships || [];

  // Collect checked concepts
  const checkedConcepts = [];
  const checkedTitles = new Set();

  body.querySelectorAll('.seed-preview-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    if (!cb.checked) return;
    const tier = item.dataset.tier;
    const idx = parseInt(item.dataset.index);
    const list = tier === 'primary' ? primaryConcepts : secondaryConcepts;
    const concept = list[idx];
    if (concept) {
      checkedConcepts.push(concept);
      checkedTitles.add(concept.title);
    }
  });

  // Collect checked relationships, filtering out those with unchecked endpoints
  const checkedRelationships = [];
  body.querySelectorAll('.seed-preview-relationship').forEach(row => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb.checked) return;
    const idx = parseInt(row.dataset.index);
    const rel = relationships[idx];
    if (rel && checkedTitles.has(rel.source) && checkedTitles.has(rel.target)) {
      checkedRelationships.push(rel);
    }
  });

  if (checkedConcepts.length === 0) {
    hideSeedPreviewModal({ seeded: false });
    return;
  }

  // Calculate radial positions: primary at 300px, secondary at 500px
  const seedConcepts = computeRadialPositions(checkedConcepts);

  // Add a central paper node and connect all primary concepts to it
  const paperTitle = seedPreviewData.paperTitle || 'Paper';
  const paperAuthors = seedPreviewData.paperAuthors || '';
  const paperDescription = paperAuthors
    ? `${paperTitle} by ${paperAuthors}`
    : paperTitle;

  seedConcepts.push({
    title: paperTitle,
    description: paperDescription,
    x: 0,
    y: 0,
    pinned: true,
    hidden: true
  });

  for (const concept of checkedConcepts) {
    if (concept.tier === 'primary') {
      checkedRelationships.push({
        source: paperTitle,
        target: concept.title,
        label: concept.paperRelationship || 'discusses',
        directed: true
      });
    }
  }

  const confirmBtn = document.getElementById('seed-preview-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Seeding...';

  try {
    await fetch(`/api/rooms/${seedPreviewRoomId}/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concepts: seedConcepts, relationships: checkedRelationships })
    });
    hideSeedPreviewModal({ seeded: true, count: checkedConcepts.length });
  } catch (e) {
    console.error('Seed failed:', e);
    hideSeedPreviewModal({ seeded: false });
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Seed Graph';
  }
});

document.getElementById('seed-preview-cancel').addEventListener('click', () => {
  hideSeedPreviewModal({ seeded: false });
});

seedPreviewModal.addEventListener('click', (e) => {
  if (e.target === seedPreviewModal) hideSeedPreviewModal({ seeded: false });
});

// ========== CONNECTION MODE ==========

function startConnectionMode(sourceId) {
  connectionSourceId = sourceId;
  graph.setSelected(sourceId);
  graph.showRubberband(sourceId);
  document.getElementById('connection-banner').classList.add('visible');
}

function cancelConnectionMode() {
  connectionSourceId = null;
  graph.setSelected(null);
  graph.hideRubberband();
  document.getElementById('connection-banner').classList.remove('visible');
}

document.getElementById('cancel-connect').addEventListener('click', cancelConnectionMode);

// ========== MERGE MODE ==========

function startMergeMode(sourceId) {
  mergeSourceId = sourceId;
  graph.setSelected(sourceId);
  graph._mergeMode = true;
  document.getElementById('merge-banner').classList.add('visible');
}

function cancelMergeMode() {
  mergeSourceId = null;
  graph.setSelected(null);
  graph._mergeMode = false;
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
  socket.emit('chat', {
    messages: getThreadMessages(threadNode),
    roomName: currentRoom.name,
    breadcrumb: threadNode.breadcrumb
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ========== TOOLBAR ==========

document.getElementById('btn-fit-view').addEventListener('click', () => {
  if (graph) graph.fitView();
});

document.getElementById('btn-auto-layout').addEventListener('click', () => {
  if (graph) graph.autoLayout();
});

function triggerExportSVG() {
  if (!graph) return;
  const result = graph.exportSVG({
    roomName: currentRoom ? currentRoom.name : 'tapestry-graph',
    includeMetadata: true
  });
  if (result && !result.success && result.reason === 'empty') {
    showToast('Nothing to export — the graph is empty');
  } else if (result && result.success) {
    showToast('SVG exported');
  }
}

document.getElementById('btn-export-svg').addEventListener('click', triggerExportSVG);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
    e.preventDefault();
    triggerExportSVG();
  }
});

// ========== PANEL TOGGLES ==========

document.getElementById('chat-toggle').addEventListener('click', () => {
  const panel = document.getElementById('chat-panel');
  const toggle = document.getElementById('chat-toggle');
  panel.classList.toggle('collapsed');
  toggle.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
  lastInteractionEventType = 'panel:toggle';
  socket.emit('panel:toggle', {
    panelState: {
      chat: !panel.classList.contains('collapsed'),
      activity: !document.getElementById('activity-panel').classList.contains('collapsed')
    }
  });
});

document.getElementById('activity-toggle').addEventListener('click', () => {
  const panel = document.getElementById('activity-panel');
  panel.classList.toggle('collapsed');
  lastInteractionEventType = 'panel:toggle';
  socket.emit('panel:toggle', {
    panelState: {
      chat: !document.getElementById('chat-panel').classList.contains('collapsed'),
      activity: !panel.classList.contains('collapsed')
    }
  });
});

// ========== PDF PANEL ==========

function openPdfPanel(pdfUrl) {
  const panel = document.getElementById('pdf-panel');
  const iframe = document.getElementById('pdf-panel-iframe');
  const title = document.getElementById('pdf-panel-title');

  if (iframe.src !== pdfUrl) {
    iframe.src = pdfUrl;
  }

  if (graph && graph._paperTitle) {
    title.textContent = graph._paperTitle;
  }

  panel.classList.remove('collapsed');
}

function closePdfPanel() {
  document.getElementById('pdf-panel').classList.add('collapsed');
}

function togglePdfPanel() {
  const panel = document.getElementById('pdf-panel');
  if (panel.classList.contains('collapsed')) {
    if (graph && graph._paperUrl) {
      openPdfPanel(graph._paperUrl);
    }
  } else {
    closePdfPanel();
  }
}

document.getElementById('pdf-panel-toggle').addEventListener('click', togglePdfPanel);
document.getElementById('pdf-panel-close').addEventListener('click', closePdfPanel);

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
  closeRoomDetailsPanel();
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
  pendingHarvestExtra = null;
  selectedRoomId = null;
  myUpvotes = new Set();
  graphTitleMap = new Map();

  // Clear DOM
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('activity-list').innerHTML = '';

  // Destroy graph
  if (graph) {
    graph.removePaper();
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

  // Hide admin control strip
  const strip = document.getElementById('admin-control-strip');
  if (strip) strip.classList.add('hidden');

  // Reset timer state
  pauseTimer();
  roomTimerState.durationMinutes = null;
  roomTimerState.remainingSeconds = null;
  timerVisible = false;
  const roomTimer = document.getElementById('room-timer');
  if (roomTimer) roomTimer.style.display = 'none';

  // Reset ESM state
  if (esmState.showing) esmModal.classList.remove('visible');
  resetEsmState();

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

// ========== FEEDBACK MODAL ==========

const feedbackModal = document.getElementById('feedback-modal');
const feedbackText = document.getElementById('feedback-text');

function showFeedbackModal() {
  feedbackModal.classList.add('visible');
  feedbackText.focus();
}

function hideFeedbackModal() {
  feedbackModal.classList.remove('visible');
  feedbackText.value = '';
  const defaultRadio = document.querySelector('input[name="feedback-cat"][value="general"]');
  if (defaultRadio) defaultRadio.checked = true;
}

document.getElementById('feedback-btn').addEventListener('click', () => {
  if (typeof esmState !== 'undefined' && esmState.showing) {
    dismissEsm('dismissed_for_feedback');
  }
  showFeedbackModal();
});
document.getElementById('feedback-close').addEventListener('click', hideFeedbackModal);

feedbackModal.addEventListener('click', (e) => {
  if (e.target === feedbackModal) hideFeedbackModal();
});

document.getElementById('feedback-submit').addEventListener('click', () => {
  const catRadio = document.querySelector('input[name="feedback-cat"]:checked');
  const category = catRadio ? catRadio.value : 'general';
  const text = feedbackText.value.trim();
  if (!text) return;

  const context = {
    nodeCount: graph ? graph.nodes.length : 0,
    threadDepth: activeThreadId ? (threadMap.get(activeThreadId)?.depth ?? 0) : 0,
    lastEventType: lastInteractionEventType,
    panelState: {
      chat: !document.getElementById('chat-panel').classList.contains('collapsed'),
      activity: !document.getElementById('activity-panel').classList.contains('collapsed')
    }
  };

  socket.emit('feedback:submit', {
    category,
    text,
    timestamp: new Date().toISOString(),
    context
  });

  // Show thanks confirmation
  const card = feedbackModal.querySelector('.modal-card');
  const originalHTML = card.innerHTML;
  card.innerHTML = '<div class="feedback-thanks">Thanks!</div>';
  setTimeout(() => {
    card.innerHTML = originalHTML;
    hideFeedbackModal();
    // Re-attach close button listener after DOM replacement
    document.getElementById('feedback-close').addEventListener('click', hideFeedbackModal);
  }, 1500);
});

// ========== ESM (EXPERIENCE SAMPLING) ==========

const esmModal = document.getElementById('esm-modal');

let esmState = {
  enabled: false,
  entryCount: 0,
  maxEntries: 3,
  cadenceMinutes: 3,
  timerId: null,
  autoDismissId: null,
  showing: false,
  triggeredAt: null,
  delayTimerId: null
};

function resetEsmState() {
  esmState.enabled = false;
  esmState.entryCount = 0;
  esmState.showing = false;
  clearTimeout(esmState.timerId);
  clearTimeout(esmState.delayTimerId);
  clearTimeout(esmState.autoDismissId);
  esmState.timerId = null;
  esmState.delayTimerId = null;
  esmState.autoDismissId = null;
}

function scheduleNextEsm() {
  clearTimeout(esmState.timerId);
  clearTimeout(esmState.delayTimerId);
  if (!esmState.enabled || esmState.entryCount >= esmState.maxEntries) return;
  esmState.timerId = setTimeout(() => attemptShowEsm(), esmState.cadenceMinutes * 60 * 1000);
}

function attemptShowEsm() {
  // If feedback modal is open, suppress entirely
  if (feedbackModal.classList.contains('visible')) {
    submitEsmEntry('suppressed_feedback_open', null);
    return; // do not queue
  }
  // If chat input focused with text, delay 20 seconds
  const chatInput = document.getElementById('chat-input');
  if (document.activeElement === chatInput && chatInput.value.trim().length > 0) {
    esmState.delayTimerId = setTimeout(() => showEsmPopup(), 20 * 1000);
    return;
  }
  showEsmPopup();
}

function showEsmPopup() {
  if (isAdmin) {
    showToast('ESM check-in sent to users (' + (esmState.entryCount + 1) + ' of ' + esmState.maxEntries + ')');
    esmState.entryCount++;
    scheduleNextEsm();
    return;
  }
  esmState.showing = true;
  esmState.triggeredAt = new Date().toISOString();
  const n = esmState.entryCount + 1;
  document.getElementById('esm-header').textContent = `Quick check-in (${n} of 3)`;
  // Reset selections
  document.querySelectorAll('.esm-likert button').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('input[name="esm-activity"]').forEach(r => r.checked = false);
  esmModal.classList.add('visible');
  // Auto-dismiss after 45 seconds
  esmState.autoDismissId = setTimeout(() => dismissEsm('timeout'), 45 * 1000);
}

function dismissEsm(status) {
  if (!esmState.showing) return;
  clearTimeout(esmState.autoDismissId);
  esmModal.classList.remove('visible');
  esmState.showing = false;
  if (status !== 'completed') {
    submitEsmEntry(status, null);
  }
  scheduleNextEsm();
}

function submitEsmEntry(status, data) {
  esmState.entryCount++;
  socket.emit('diary:submit', {
    entryNumber: esmState.entryCount,
    engagement: data?.engagement ?? null,
    awareness: data?.awareness ?? null,
    relevance: data?.relevance ?? null,
    activity: data?.activity ?? null,
    triggeredAt: esmState.triggeredAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: status
  });
  lastInteractionEventType = 'esm:' + status;
}

// Likert button selection
document.querySelectorAll('.esm-likert button').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

// Submit
document.getElementById('esm-submit').addEventListener('click', () => {
  clearTimeout(esmState.autoDismissId);
  const engagement = document.querySelector('.esm-likert[data-field="engagement"] button.selected')?.dataset.value;
  const awareness = document.querySelector('.esm-likert[data-field="awareness"] button.selected')?.dataset.value;
  const relevance = document.querySelector('.esm-likert[data-field="relevance"] button.selected')?.dataset.value;
  const activityRadio = document.querySelector('input[name="esm-activity"]:checked');
  submitEsmEntry('completed', {
    engagement: engagement ? parseInt(engagement) : null,
    awareness: awareness ? parseInt(awareness) : null,
    relevance: relevance ? parseInt(relevance) : null,
    activity: activityRadio ? activityRadio.value : null
  });
  esmModal.classList.remove('visible');
  esmState.showing = false;
  scheduleNextEsm();
});

// Close button
document.getElementById('esm-close').addEventListener('click', () => dismissEsm('dismissed'));

// Backdrop click to dismiss
esmModal.addEventListener('click', (e) => {
  if (e.target === esmModal) dismissEsm('dismissed');
});

// ========== ADMIN CONTROLS ==========

let roomTimerState = {
  durationMinutes: null,
  remainingSeconds: null,
  running: false,
  interval: null
};

let timerVisible = false;

function initAdminControls(room) {
  const strip = document.getElementById('admin-control-strip');
  if (!strip) return;
  strip.classList.remove('hidden');

  const roomStateSelect = document.getElementById('room-state-select');
  const timerDisplay = document.getElementById('timer-display');
  const timerVisibilityBtn = document.getElementById('timer-visibility-btn');
  const esmToggleBtn = document.getElementById('esm-toggle-btn');
  const esmToggleText = document.getElementById('esm-toggle-text');
  const triggerPosttestBtn = document.getElementById('trigger-posttest-btn');
  const exportDataBtn = document.getElementById('export-data-btn');
  const adminUserCount = document.getElementById('admin-user-count');

  // Set initial room state
  const state = room.state || 'normal';
  roomStateSelect.value = state;
  roomStateSelect.className = `control-select state-select ${state}`;

  // Set initial timer
  if (room.durationMinutes) {
    roomTimerState.durationMinutes = room.durationMinutes;
    roomTimerState.remainingSeconds = room.durationMinutes * 60;
    updateTimerDisplay();
  }

  // Set initial ESM state
  const evalMode = room.evalMode === 1;
  esmToggleBtn.dataset.enabled = evalMode;
  esmToggleText.textContent = evalMode ? 'ON' : 'OFF';

  // Timer visibility toggle (icon button)
  timerVisibilityBtn.addEventListener('click', () => {
    timerVisible = !timerVisible;
    timerVisibilityBtn.classList.toggle('active', timerVisible);
    const roomTimer = document.getElementById('room-timer');
    if (roomTimer) roomTimer.style.display = timerVisible ? 'flex' : 'none';
    // Broadcast to all users
    fetch(`/api/rooms/${currentRoom.id}/timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: timerVisible ? 'show' : 'hide' })
    });
  });

  // Room state: dropdown change
  roomStateSelect.addEventListener('change', async () => {
    const newState = roomStateSelect.value;
    try {
      const res = await fetch(`/api/rooms/${currentRoom.id}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState })
      });
      if (!res.ok) {
        const err = await res.json();
        console.warn('State change failed:', err.error);
        roomStateSelect.value = state; // revert on failure
        return;
      }
      const data = await res.json();
      roomStateSelect.className = `control-select state-select ${data.state}`;

      // Auto-start timer when switching to in-progress
      if (data.state === 'in-progress' && roomTimerState.durationMinutes) {
        if (!roomTimerState.running) {
          startTimer();
          // Show timer and broadcast
          timerVisible = true;
          timerVisibilityBtn.classList.add('active');
          const roomTimer = document.getElementById('room-timer');
          if (roomTimer) roomTimer.style.display = 'flex';
          fetch(`/api/rooms/${currentRoom.id}/timer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' })
          });
        }
      }

      // Auto-enable ESM when switching to in-progress
      if (data.state === 'in-progress' && esmToggleBtn.dataset.enabled !== 'true') {
        fetch(`/api/rooms/${currentRoom.id}/eval-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true })
        });
        esmToggleBtn.dataset.enabled = 'true';
        esmToggleText.textContent = 'ON';
      }

      // Auto-reset timer when switching to normal
      if (data.state === 'normal') {
        resetTimer();
        timerVisible = false;
        timerVisibilityBtn.classList.remove('active');
        fetch(`/api/rooms/${currentRoom.id}/timer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset' })
        });
      }
    } catch (e) {
      console.error('Failed to change room state:', e);
    }
  });

  // Timer: inline duration input
  const timerDurationInput = document.getElementById('timer-duration-input');
  if (roomTimerState.durationMinutes) {
    timerDurationInput.value = roomTimerState.durationMinutes;
  }

  timerDurationInput.addEventListener('change', () => {
    const raw = timerDurationInput.value.trim();
    const mins = parseInt(raw, 10);
    // Allow 0 or empty to clear the timer
    if (raw === '' || mins === 0) {
      roomTimerState.durationMinutes = null;
      roomTimerState.remainingSeconds = null;
      pauseTimer();
      timerDurationInput.value = '';
      updateTimerDisplay();
      updateRoomTimerDisplay();
      return;
    }
    if (isNaN(mins) || mins < 1 || mins > 120) {
      timerDurationInput.value = roomTimerState.durationMinutes || '';
      return;
    }
    roomTimerState.durationMinutes = mins;
    roomTimerState.remainingSeconds = mins * 60;
    roomTimerState.running = false;
    if (roomTimerState.interval) {
      clearInterval(roomTimerState.interval);
      roomTimerState.interval = null;
    }
    updateTimerDisplay();
    updateRoomTimerDisplay();
  });

  // Timer: play/pause/reset buttons
  const timerPlayBtn = document.getElementById('timer-play-btn');
  const timerPauseBtn = document.getElementById('timer-pause-btn');
  const timerResetBtn = document.getElementById('timer-reset-btn');

  timerPlayBtn.addEventListener('click', () => {
    if (!roomTimerState.durationMinutes) return;
    startTimer();
    // Auto-show timer when started
    if (!timerVisible) {
      timerVisible = true;
      timerVisibilityBtn.classList.add('active');
      const roomTimer = document.getElementById('room-timer');
      if (roomTimer) roomTimer.style.display = 'flex';
    }
    fetch(`/api/rooms/${currentRoom.id}/timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' })
    });
  });

  timerPauseBtn.addEventListener('click', () => {
    pauseTimer();
    fetch(`/api/rooms/${currentRoom.id}/timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' })
    });
  });

  timerResetBtn.addEventListener('click', () => {
    resetTimer();
    fetch(`/api/rooms/${currentRoom.id}/timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' })
    });
  });

  // ESM toggle
  esmToggleBtn.addEventListener('click', async () => {
    const newState = esmToggleBtn.dataset.enabled !== 'true';
    try {
      await fetch(`/api/rooms/${currentRoom.id}/eval-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newState })
      });
      esmToggleBtn.dataset.enabled = newState;
      esmToggleText.textContent = newState ? 'ON' : 'OFF';
    } catch (e) {
      console.error('Failed to toggle eval mode:', e);
    }
  });

  // ESM cadence input
  const esmCadenceInput = document.getElementById('esm-cadence-input');
  if (room.esmCadenceMinutes) {
    esmCadenceInput.value = room.esmCadenceMinutes;
    esmState.cadenceMinutes = room.esmCadenceMinutes;
  }

  esmCadenceInput.addEventListener('change', async () => {
    const mins = parseInt(esmCadenceInput.value, 10);
    if (!mins || mins < 1 || mins > 30) {
      esmCadenceInput.value = esmState.cadenceMinutes;
      return;
    }
    try {
      await fetch(`/api/rooms/${currentRoom.id}/esm-cadence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: mins })
      });
    } catch (e) {
      console.error('Failed to update ESM cadence:', e);
    }
  });

  // Post-Test button
  triggerPosttestBtn.addEventListener('click', async () => {
    if (!confirm('Push post-test survey to all connected users?')) return;
    try {
      const res = await fetch(`/api/rooms/${currentRoom.id}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'posttest' })
      });
      if (res.ok) {
        roomStateSelect.value = 'posttest';
        roomStateSelect.className = 'control-select state-select posttest';
      }
    } catch (e) {
      console.error('Failed to trigger post-test:', e);
    }
  });

  // Export button
  exportDataBtn.addEventListener('click', () => {
    window.open(`/api/rooms/${currentRoom.id}/export/all`, '_blank');
  });
}

function updateTimerDisplay() {
  const timerText = document.getElementById('timer-text');
  const timerDisplay = document.getElementById('timer-display');
  if (!timerText || !timerDisplay) return;

  if (!roomTimerState.durationMinutes) {
    timerText.textContent = '--:--';
    return;
  }

  const mins = Math.floor(roomTimerState.remainingSeconds / 60);
  const secs = roomTimerState.remainingSeconds % 60;
  timerText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  timerDisplay.classList.toggle('running', roomTimerState.running);

  if (roomTimerState.remainingSeconds <= 0) {
    timerDisplay.classList.add('expired');
    setTimeout(() => timerDisplay.classList.remove('expired'), 3000);
  }
}

function updateRoomTimerDisplay() {
  const roomTimerText = document.getElementById('room-timer-text');
  if (!roomTimerText) return;

  if (!roomTimerState.durationMinutes) return;

  if (roomTimerState.remainingSeconds <= 0) {
    roomTimerText.textContent = "Time's up";
    return;
  }

  const mins = Math.floor(roomTimerState.remainingSeconds / 60);
  const secs = roomTimerState.remainingSeconds % 60;
  roomTimerText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startTimer() {
  if (roomTimerState.running) return;
  if (!roomTimerState.durationMinutes || roomTimerState.remainingSeconds <= 0) return;
  roomTimerState.running = true;

  roomTimerState.interval = setInterval(() => {
    if (roomTimerState.remainingSeconds > 0) {
      roomTimerState.remainingSeconds--;
      updateTimerDisplay();
      updateRoomTimerDisplay();
    } else {
      pauseTimer();
    }
  }, 1000);
  updateTimerDisplay();
  updateRoomTimerDisplay();
}

function pauseTimer() {
  roomTimerState.running = false;
  if (roomTimerState.interval) {
    clearInterval(roomTimerState.interval);
    roomTimerState.interval = null;
  }
  updateTimerDisplay();
}

function resetTimer() {
  pauseTimer();
  if (roomTimerState.durationMinutes) {
    roomTimerState.remainingSeconds = roomTimerState.durationMinutes * 60;
  }
  updateTimerDisplay();
  updateRoomTimerDisplay();
}

// Socket: room state changed
socket.on('room:state-changed', ({ state }) => {
  const select = document.getElementById('room-state-select');
  if (select) {
    select.value = state;
    select.className = `control-select state-select ${state}`;
  }

  // Hide timer and pause when closed or normal
  if (state === 'closed' || state === 'normal') {
    const roomTimer = document.getElementById('room-timer');
    if (roomTimer) roomTimer.style.display = 'none';
    pauseTimer();
    timerVisible = false;
    const visBtn = document.getElementById('timer-visibility-btn');
    if (visBtn) visBtn.classList.remove('active');
  }
});

// Socket: room details changed
socket.on('room:details-changed', ({ name, summary }) => {
  if (currentRoom) {
    currentRoom.name = name;
    currentRoom.summary = summary;
  }
  document.getElementById('room-label').textContent = name;

  if (roomDetailsPanel.classList.contains('visible')) {
    roomDetailsName.value = name;
    roomDetailsSummary.value = summary || '';
  }
});

// Socket: eval mode changed
socket.on('room:eval-mode-changed', ({ enabled }) => {
  const btn = document.getElementById('esm-toggle-btn');
  const text = document.getElementById('esm-toggle-text');
  if (btn && text) {
    btn.dataset.enabled = enabled;
    text.textContent = enabled ? 'ON' : 'OFF';
  }
  esmState.enabled = enabled;
  if (enabled) {
    scheduleNextEsm();
  } else {
    clearTimeout(esmState.timerId);
    clearTimeout(esmState.delayTimerId);
    if (esmState.showing) dismissEsm('dismissed');
  }
});

// Socket: ESM cadence changed
socket.on('room:esm-cadence-changed', ({ minutes }) => {
  esmState.cadenceMinutes = minutes;
  const cadenceInput = document.getElementById('esm-cadence-input');
  if (cadenceInput) cadenceInput.value = minutes;
  // Reschedule with new cadence if ESM is active
  if (esmState.enabled) {
    clearTimeout(esmState.timerId);
    scheduleNextEsm();
  }
});

// Socket: timer control (sync across clients)
socket.on('room:timer-control', ({ action }) => {
  const roomTimer = document.getElementById('room-timer');
  if (action === 'start') {
    startTimer();
    if (roomTimer) roomTimer.style.display = 'flex';
    timerVisible = true;
  } else if (action === 'pause') {
    pauseTimer();
  } else if (action === 'reset') {
    resetTimer();
    if (roomTimer) roomTimer.style.display = 'none';
    timerVisible = false;
  } else if (action === 'show') {
    if (roomTimer) roomTimer.style.display = 'flex';
    timerVisible = true;
  } else if (action === 'hide') {
    if (roomTimer) roomTimer.style.display = 'none';
    timerVisible = false;
  }
});

// ========== POST-TEST SURVEY ==========

const posttestModal = document.getElementById('posttest-modal');

function showPosttestModal() {
  // Reset all selections
  posttestModal.querySelectorAll('.posttest-likert button').forEach(b => b.classList.remove('selected'));
  posttestModal.querySelectorAll('.posttest-textarea').forEach(t => t.value = '');
  posttestModal.classList.add('visible');
}

function hidePosttestModal() {
  posttestModal.classList.remove('visible');
}

// Likert button selection (event delegation)
posttestModal.addEventListener('click', (e) => {
  const btn = e.target.closest('.posttest-likert button');
  if (!btn) return;
  const row = btn.closest('.posttest-likert');
  row.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
});

// Submit
document.getElementById('posttest-submit').addEventListener('click', () => {
  const data = {};
  let allLikertAnswered = true;
  posttestModal.querySelectorAll('.posttest-likert').forEach(row => {
    const field = row.dataset.field;
    const sel = row.querySelector('button.selected');
    if (sel) {
      data[field] = parseInt(sel.dataset.value);
    } else {
      allLikertAnswered = false;
    }
  });
  if (!allLikertAnswered) {
    alert('Please answer all rating items before submitting.');
    return;
  }
  posttestModal.querySelectorAll('.posttest-textarea').forEach(ta => {
    data[ta.dataset.field] = ta.value.trim();
  });
  socket.emit('posttest:submit', data);
  hidePosttestModal();
});

// Skip
document.getElementById('posttest-skip').addEventListener('click', (e) => {
  e.preventDefault();
  socket.emit('posttest:dismiss');
  hidePosttestModal();
});

// Socket: post-test trigger
socket.on('posttest:trigger', () => {
  console.log('Post-test triggered');
  if (isAdmin) {
    showToast('Post-test survey sent to all users');
    return;
  }
  showPosttestModal();
});

// ========== INIT ==========

loadRooms();

// Close context menu on escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu();
    hideEdgeContextMenu();
    hideCanvasContextMenu();
    cancelConnectionMode();
    cancelMergeMode();
    if (connectionsModal.classList.contains('visible')) hideConnectionsModal();
    if (feedbackModal.classList.contains('visible')) hideFeedbackModal();
    if (esmState.showing) dismissEsm('dismissed');
    if (posttestModal.classList.contains('visible')) {
      socket.emit('posttest:dismiss');
      hidePosttestModal();
    }
    // F12: Clear graph search on Escape
    const searchInput = document.getElementById('graph-search-input');
    if (searchInput && (searchInput.value || document.activeElement === searchInput)) {
      searchInput.value = '';
      searchInput.closest('.graph-search-container').classList.remove('has-query');
      graph.applySearchFilter(null);
      searchInput.blur();
    }
  }
});

// --- Graph search (F12) ---

(function initGraphSearch() {
  const searchInput = document.getElementById('graph-search-input');
  const searchClear = document.getElementById('graph-search-clear');
  const searchContainer = searchInput.closest('.graph-search-container');

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  const handleSearch = debounce(() => {
    const query = searchInput.value.trim().toLowerCase();
    searchContainer.classList.toggle('has-query', query.length > 0);

    if (!query) {
      graph.applySearchFilter(null);
      return;
    }

    const matchIds = new Set();
    for (const node of graph.nodes) {
      if (node.title.toLowerCase().includes(query) || (node.description && node.description.toLowerCase().includes(query))) {
        matchIds.add(node.id);
      }
    }

    graph.applySearchFilter(matchIds.size > 0 ? matchIds : new Set());

    // Auto-pan/zoom based on match count
    if (matchIds.size === 1) {
      graph.focusNode([...matchIds][0]);
    } else if (matchIds.size >= 2 && matchIds.size <= 5) {
      graph.fitNodes([...matchIds]);
    }
    // >5 matches: dim only, no pan
  }, 50);

  searchInput.addEventListener('input', handleSearch);

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchContainer.classList.remove('has-query');
    graph.applySearchFilter(null);
    searchInput.focus();
  });

  // Ctrl+F / Cmd+F to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });
})();
