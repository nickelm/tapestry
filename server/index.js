const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { initDatabase, saveDb, queryAll, queryOne, run } = require('./database');
const { LLMService } = require('./llm');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const llm = new LLMService();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// --- REST API ---

app.get('/api/rooms', (req, res) => {
  res.json(queryAll('SELECT * FROM rooms ORDER BY created_at DESC'));
});

app.post('/api/rooms', (req, res) => {
  const { name } = req.body;
  const id = uuidv4();
  run('INSERT INTO rooms (id, name) VALUES (?, ?)', [id, name]);
  saveDb();
  res.json({ id, name });
});

app.get('/api/rooms/:roomId/state', (req, res) => {
  const rid = req.params.roomId;
  const nodes = queryAll('SELECT * FROM nodes WHERE room_id = ?', [rid]);
  const edges = queryAll('SELECT * FROM edges WHERE room_id = ?', [rid]);
  const activity = queryAll('SELECT * FROM activity_log WHERE room_id = ? ORDER BY created_at DESC LIMIT 100', [rid]);

  // Live user count from Socket.IO room
  const userCount = io.sockets.adapter.rooms.get(rid)?.size || 0;

  const nodeIds = nodes.map(n => n.id);
  let contributors = [];
  let upvotes = [];
  if (nodeIds.length > 0) {
    // sql.js doesn't support IN with array directly, query per node
    for (const nid of nodeIds) {
      const c = queryAll('SELECT nc.node_id, u.id, u.name, u.color FROM node_contributors nc JOIN users u ON nc.user_id = u.id WHERE nc.node_id = ?', [nid]);
      contributors.push(...c);
      const u = queryAll('SELECT node_id, user_id FROM node_upvotes WHERE node_id = ?', [nid]);
      upvotes.push(...u);
    }
  }

  res.json({ nodes, edges, activity, userCount, contributors, upvotes });
});

app.post('/api/rooms/:roomId/seed', (req, res) => {
  const rid = req.params.roomId;
  const { concepts } = req.body;
  const systemUserId = 'system';

  if (!queryOne('SELECT id FROM users WHERE id = ?', [systemUserId])) {
    run('INSERT INTO users (id, name, color, room_id) VALUES (?, ?, ?, ?)', [systemUserId, 'System', '#94a3b8', rid]);
  }

  const seeded = [];
  for (const concept of concepts) {
    const id = uuidv4();
    run('INSERT INTO nodes (id, room_id, title, description, x, y, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, rid, concept.title, concept.description || '', concept.x || 0, concept.y || 0, systemUserId]);
    run('INSERT INTO node_contributors (node_id, user_id) VALUES (?, ?)', [id, systemUserId]);
    run('INSERT INTO activity_log (room_id, user_id, user_name, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [rid, systemUserId, 'System', 'seed', 'node', id, concept.title]);
    seeded.push({ id, ...concept });
  }
  saveDb();
  res.json({ seeded });
});

app.post('/api/rooms/:roomId/describe-concept', async (req, res) => {
  const { title, breadcrumb } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const description = await llm.describeConcept(title, breadcrumb || []);
    res.json({ description });
  } catch (e) {
    console.error('describe-concept error:', e.message);
    res.status(500).json({ error: 'Failed to generate description' });
  }
});

// --- SOCKET.IO ---

const COLORS = [
  '#e76f51', '#2a9d8f', '#e9c46a', '#264653', '#f4a261',
  '#606c38', '#bc6c25', '#0077b6', '#d62828', '#6a4c93',
  '#1d3557', '#457b9d', '#a8dadc', '#e07a5f', '#3d405b',
  '#81b29a', '#f2cc8f', '#6d6875', '#b5838d', '#ffb703',
  '#fb8500', '#023047', '#219ebc', '#8ecae6', '#d4a373',
  '#ccd5ae', '#588157', '#a3b18a', '#7c3aed', '#dc2626'
];
let colorIndex = 0;

io.on('connection', (socket) => {
  let currentUser = null;
  let currentRoom = null;
  let activeAbortController = null;

  socket.on('join-room', ({ roomId, userName }) => {
    const room = queryOne('SELECT * FROM rooms WHERE id = ?', [roomId]);
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    const userId = uuidv4();
    const color = COLORS[colorIndex++ % COLORS.length];

    run('INSERT INTO users (id, name, color, room_id) VALUES (?, ?, ?, ?)', [userId, userName, color, roomId]);
    currentUser = { id: userId, name: userName, color };
    currentRoom = roomId;

    socket.join(roomId);
    socket.emit('joined', { user: currentUser, room });
    io.to(roomId).emit('user-joined', { user: currentUser });

    // Broadcast updated user count
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 1;
    io.to(roomId).emit('user-count', { count: roomSize });

    run('INSERT INTO activity_log (room_id, user_id, user_name, action, target_type, details) VALUES (?, ?, ?, ?, ?, ?)',
      [roomId, userId, userName, 'joined', 'room', room.name]);
    socket.to(roomId).emit('activity', { user_name: userName, action: 'joined', target_type: 'room', details: room.name, created_at: new Date().toISOString() });
    saveDb();
  });

  socket.on('chat', async ({ messages }) => {
    if (!currentUser || !currentRoom) return;

    // Abort any previous pending request
    if (activeAbortController) {
      activeAbortController.abort();
    }

    const abortController = new AbortController();
    activeAbortController = abortController;

    try {
      const existing = queryAll('SELECT id, title, description FROM nodes WHERE room_id = ?', [currentRoom]);
      const result = await llm.chatWithExtraction(messages, existing, { signal: abortController.signal });
      if (!abortController.signal.aborted) {
        socket.emit('chat-response', result);
      }
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        return; // Request was cancelled
      }
      console.error('Chat error:', err);
      socket.emit('chat-error', { message: 'LLM request failed.' });
    } finally {
      if (activeAbortController === abortController) {
        activeAbortController = null;
      }
    }
  });

  socket.on('cancel-chat', () => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
  });

  socket.on('harvest', async ({ title, description }) => {
    if (!currentUser || !currentRoom) return;

    const existing = queryAll('SELECT id, title, description FROM nodes WHERE room_id = ?', [currentRoom]);

    let similarIds = [];
    if (existing.length > 0) {
      try { similarIds = await llm.findSimilarConcepts({ title, description }, existing); } catch (e) {}
    }

    if (similarIds.length > 0) {
      const similar = existing.filter(c => similarIds.includes(c.id));
      socket.emit('similar-found', { newConcept: { title, description }, similar });
      return;
    }

    addNodeToRoom(title, description, currentUser, currentRoom);
  });

  socket.on('force-harvest', ({ title, description }) => {
    if (!currentUser || !currentRoom) return;
    addNodeToRoom(title, description, currentUser, currentRoom);
  });

  function addNodeToRoom(title, description, user, roomId) {
    const nodeId = uuidv4();
    const x = (Math.random() - 0.5) * 800;
    const y = (Math.random() - 0.5) * 600;

    run('INSERT INTO nodes (id, room_id, title, description, x, y, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nodeId, roomId, title, description, x, y, user.id]);
    run('INSERT INTO node_contributors (node_id, user_id) VALUES (?, ?)', [nodeId, user.id]);
    run('INSERT INTO activity_log (room_id, user_id, user_name, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [roomId, user.id, user.name, 'harvested', 'node', nodeId, title]);

    const node = {
      id: nodeId, title, description, x, y, created_by: user.id,
      upvotes: 0, merged_count: 0, pinned: 0,
      contributors: [{ id: user.id, name: user.name, color: user.color }]
    };

    io.to(roomId).emit('node-added', node);
    io.to(roomId).emit('activity', { user_name: user.name, action: 'harvested', target_type: 'node', target_id: nodeId, details: title, created_at: new Date().toISOString() });
    saveDb();
  }

  socket.on('connect-nodes', async ({ sourceId, targetId }) => {
    if (!currentUser || !currentRoom) return;

    const exists = queryOne('SELECT id FROM edges WHERE room_id = ? AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))',
      [currentRoom, sourceId, targetId, targetId, sourceId]);
    if (exists) { socket.emit('error', { message: 'Connection already exists' }); return; }

    const source = queryOne('SELECT * FROM nodes WHERE id = ?', [sourceId]);
    const target = queryOne('SELECT * FROM nodes WHERE id = ?', [targetId]);
    if (!source || !target) return;

    let label = 'relates to';
    try { label = await llm.generateRelationshipLabel(source, target); } catch (e) {}

    const edgeId = uuidv4();
    run('INSERT INTO edges (id, room_id, source_id, target_id, label, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [edgeId, currentRoom, sourceId, targetId, label, currentUser.id]);
    run('INSERT INTO activity_log (room_id, user_id, user_name, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [currentRoom, currentUser.id, currentUser.name, 'connected', 'edge', edgeId, `${source.title} → ${target.title}`]);

    io.to(currentRoom).emit('edge-added', { id: edgeId, source_id: sourceId, target_id: targetId, label, created_by: currentUser.id });
    io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'connected', target_type: 'edge', target_id: edgeId, details: `${source.title} → ${target.title}: "${label}"`, created_at: new Date().toISOString() });
    saveDb();
  });

  socket.on('expand-node', async ({ nodeId }) => {
    if (!currentUser || !currentRoom) return;
    const node = queryOne('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return;

    const existing = queryAll('SELECT id, title, description FROM nodes WHERE room_id = ?', [currentRoom]);

    try {
      const expansions = await llm.expandConcept(node, existing);
      for (const exp of expansions) {
        const newId = uuidv4();
        const x = node.x + (Math.random() - 0.5) * 200;
        const y = node.y + (Math.random() - 0.5) * 200;

        run('INSERT INTO nodes (id, room_id, title, description, x, y, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [newId, currentRoom, exp.title, exp.description, x, y, currentUser.id]);
        run('INSERT INTO node_contributors (node_id, user_id) VALUES (?, ?)', [newId, currentUser.id]);

        io.to(currentRoom).emit('node-added', {
          id: newId, title: exp.title, description: exp.description, x, y,
          created_by: currentUser.id, upvotes: 0, merged_count: 0, pinned: 0,
          contributors: [{ id: currentUser.id, name: currentUser.name, color: currentUser.color }]
        });

        const edgeId = uuidv4();
        const label = exp.relationLabel || 'relates to';
        run('INSERT INTO edges (id, room_id, source_id, target_id, label, created_by) VALUES (?, ?, ?, ?, ?, ?)',
          [edgeId, currentRoom, nodeId, newId, label, currentUser.id]);
        io.to(currentRoom).emit('edge-added', { id: edgeId, source_id: nodeId, target_id: newId, label, created_by: currentUser.id });
      }

      io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'expanded', target_type: 'node', target_id: nodeId, details: `${node.title} → ${expansions.map(e => e.title).join(', ')}`, created_at: new Date().toISOString() });
      saveDb();
    } catch (e) {
      console.error('Expand failed:', e);
      socket.emit('error', { message: 'Failed to expand concept' });
    }
  });

  socket.on('elaborate-node', async ({ nodeId }) => {
    if (!currentUser || !currentRoom) return;
    const node = queryOne('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return;

    try {
      const elaboration = await llm.elaborateConcept(node);
      run('UPDATE nodes SET description = ? WHERE id = ?', [elaboration, nodeId]);
      io.to(currentRoom).emit('node-updated', { id: nodeId, description: elaboration });
      io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'elaborated', target_type: 'node', target_id: nodeId, details: node.title, created_at: new Date().toISOString() });
      saveDb();
    } catch (e) {
      console.error('Elaborate failed:', e);
    }
  });

  socket.on('edit-node', ({ nodeId, title, description }) => {
    if (!currentUser || !currentRoom) return;
    const node = queryOne('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return;

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;

    const setClauses = Object.keys(updates).map(k => `${k} = ?`);
    if (setClauses.length === 0) return;
    run(`UPDATE nodes SET ${setClauses.join(', ')} WHERE id = ?`, [...Object.values(updates), nodeId]);

    io.to(currentRoom).emit('node-updated', { id: nodeId, ...updates });
    io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'edited', target_type: 'node', target_id: nodeId, details: updates.title || node.title, created_at: new Date().toISOString() });
    saveDb();
  });

  socket.on('prune-node', ({ nodeId }) => {
    if (!currentUser || !currentRoom) return;
    const node = queryOne('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) return;

    run('DELETE FROM edges WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    run('DELETE FROM node_contributors WHERE node_id = ?', [nodeId]);
    run('DELETE FROM node_upvotes WHERE node_id = ?', [nodeId]);
    run('DELETE FROM merged_nodes WHERE parent_id = ?', [nodeId]);
    run('DELETE FROM nodes WHERE id = ?', [nodeId]);

    io.to(currentRoom).emit('node-removed', { id: nodeId });
    io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'pruned', target_type: 'node', target_id: nodeId, details: node.title, created_at: new Date().toISOString() });
    saveDb();
  });

  socket.on('upvote-node', ({ nodeId }) => {
    if (!currentUser || !currentRoom) return;
    const existing = queryOne('SELECT * FROM node_upvotes WHERE node_id = ? AND user_id = ?', [nodeId, currentUser.id]);
    if (existing) {
      run('DELETE FROM node_upvotes WHERE node_id = ? AND user_id = ?', [nodeId, currentUser.id]);
      run('UPDATE nodes SET upvotes = upvotes - 1 WHERE id = ?', [nodeId]);
    } else {
      run('INSERT INTO node_upvotes (node_id, user_id) VALUES (?, ?)', [nodeId, currentUser.id]);
      run('UPDATE nodes SET upvotes = upvotes + 1 WHERE id = ?', [nodeId]);
    }
    const node = queryOne('SELECT upvotes FROM nodes WHERE id = ?', [nodeId]);
    io.to(currentRoom).emit('node-upvoted', { id: nodeId, upvotes: node.upvotes });
    saveDb();
  });

  socket.on('merge-nodes', async ({ keepId, mergeId }) => {
    if (!currentUser || !currentRoom) return;
    const keepNode = queryOne('SELECT * FROM nodes WHERE id = ?', [keepId]);
    const mergeNode = queryOne('SELECT * FROM nodes WHERE id = ?', [mergeId]);
    if (!keepNode || !mergeNode) return;

    try {
      const merged = await llm.suggestMerge(keepNode, mergeNode);

      run('INSERT INTO merged_nodes (parent_id, original_title, original_description, merged_by) VALUES (?, ?, ?, ?)',
        [keepId, mergeNode.title, mergeNode.description, currentUser.id]);
      run('UPDATE nodes SET title = ?, description = ?, merged_count = merged_count + 1 WHERE id = ?',
        [merged.title, merged.description, keepId]);
      run('UPDATE edges SET source_id = ? WHERE source_id = ?', [keepId, mergeId]);
      run('UPDATE edges SET target_id = ? WHERE target_id = ?', [keepId, mergeId]);

      const mergeContribs = queryAll('SELECT user_id FROM node_contributors WHERE node_id = ?', [mergeId]);
      for (const c of mergeContribs) {
        const existing = queryOne('SELECT * FROM node_contributors WHERE node_id = ? AND user_id = ?', [keepId, c.user_id]);
        if (!existing) {
          run('INSERT INTO node_contributors (node_id, user_id) VALUES (?, ?)', [keepId, c.user_id]);
        }
      }

      run('DELETE FROM node_upvotes WHERE node_id = ?', [mergeId]);
      run('DELETE FROM node_contributors WHERE node_id = ?', [mergeId]);
      run('DELETE FROM nodes WHERE id = ?', [mergeId]);
      run('DELETE FROM edges WHERE source_id = target_id', []);

      const contributors = queryAll('SELECT u.id, u.name, u.color FROM node_contributors nc JOIN users u ON nc.user_id = u.id WHERE nc.node_id = ?', [keepId]);

      io.to(currentRoom).emit('nodes-merged', { keepId, mergeId, title: merged.title, description: merged.description, contributors });
      io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'merged', target_type: 'node', target_id: keepId, details: `${keepNode.title} + ${mergeNode.title} → ${merged.title}`, created_at: new Date().toISOString() });
      saveDb();
    } catch (e) {
      console.error('Merge failed:', e);
      socket.emit('error', { message: 'Failed to merge concepts' });
    }
  });

  socket.on('move-node', ({ nodeId, x, y, pinned }) => {
    if (!currentUser || !currentRoom) return;
    run('UPDATE nodes SET x = ?, y = ?, pinned = ? WHERE id = ?', [x, y, pinned ? 1 : 0, nodeId]);
    socket.to(currentRoom).emit('node-moved', { id: nodeId, x, y, pinned });
  });

  socket.on('delete-edge', ({ edgeId }) => {
    if (!currentUser || !currentRoom) return;
    run('DELETE FROM edges WHERE id = ?', [edgeId]);
    io.to(currentRoom).emit('edge-removed', { id: edgeId });
    saveDb();
  });

  socket.on('hover-node', ({ nodeId }) => {
    if (!currentUser || !currentRoom) return;
    socket.to(currentRoom).emit('user-hover', { userId: currentUser.id, userName: currentUser.name, color: currentUser.color, nodeId });
  });

  socket.on('unhover-node', () => {
    if (!currentUser || !currentRoom) return;
    socket.to(currentRoom).emit('user-unhover', { userId: currentUser.id });
  });

  socket.on('leave-room', () => {
    if (currentUser && currentRoom) {
      socket.leave(currentRoom);
      io.to(currentRoom).emit('user-left', { userId: currentUser.id });
      io.to(currentRoom).emit('activity', {
        user_name: currentUser.name,
        action: 'left',
        target_type: 'room',
        details: '',
        created_at: new Date().toISOString()
      });
      const roomSize = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('user-count', { count: roomSize });
      currentUser = null;
      currentRoom = null;
    }
    socket.emit('left-room');
  });

  socket.on('disconnect', () => {
    if (currentUser && currentRoom) {
      io.to(currentRoom).emit('user-left', { userId: currentUser.id });
      io.to(currentRoom).emit('activity', { user_name: currentUser.name, action: 'left', target_type: 'room', details: '', created_at: new Date().toISOString() });

      // Broadcast updated user count
      const roomSize = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('user-count', { count: roomSize });
    }
  });
});

// --- STARTUP ---

const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Tapestry running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
