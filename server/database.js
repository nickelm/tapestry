const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
const DB_PATH = path.join(__dirname, '..', 'tapestry.db');

async function initDatabase() {
  const SQL = await initSqlJs();

  let data = null;
  if (fs.existsSync(DB_PATH)) {
    data = fs.readFileSync(DB_PATH);
  }

  db = data ? new SQL.Database(data) : new SQL.Database();

  const tables = [
    `CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, room_id TEXT NOT NULL,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '',
      x REAL DEFAULT 0, y REAL DEFAULT 0, pinned INTEGER DEFAULT 0, upvotes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by TEXT NOT NULL, merged_count INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS node_contributors (
      node_id TEXT NOT NULL, user_id TEXT NOT NULL, contributed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (node_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS node_upvotes (
      node_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (node_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      label TEXT DEFAULT '', directed INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS merged_nodes (
      parent_id TEXT NOT NULL, original_title TEXT NOT NULL, original_description TEXT DEFAULT '',
      merged_by TEXT NOT NULL, merged_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, user_id TEXT, user_name TEXT,
      action TEXT NOT NULL, target_type TEXT, target_id TEXT, details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS interaction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT, userId TEXT, displayName TEXT,
      eventType TEXT, payload JSON, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT, userId TEXT, displayName TEXT,
      category TEXT, text TEXT, contextJson JSON, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  tables.forEach(sql => db.run(sql));

  // Migration: add directed column if missing (for existing databases)
  const edgeCols = queryAll("PRAGMA table_info(edges)");
  if (!edgeCols.some(c => c.name === 'directed')) {
    db.run("ALTER TABLE edges ADD COLUMN directed INTEGER DEFAULT 1");
  }

  // Migration: add room lifecycle fields
  const roomCols = queryAll("PRAGMA table_info(rooms)");
  if (!roomCols.some(c => c.name === 'state')) {
    db.run("ALTER TABLE rooms ADD COLUMN state TEXT DEFAULT 'normal'");
  }
  if (!roomCols.some(c => c.name === 'durationMinutes')) {
    db.run("ALTER TABLE rooms ADD COLUMN durationMinutes INTEGER DEFAULT NULL");
  }
  if (!roomCols.some(c => c.name === 'evalMode')) {
    db.run("ALTER TABLE rooms ADD COLUMN evalMode INTEGER DEFAULT 0");
  }

  // Migration: rename legacy state values
  db.run("UPDATE rooms SET state = 'normal' WHERE state = 'waiting'");
  db.run("UPDATE rooms SET state = 'in-progress' WHERE state = 'active'");

  setInterval(saveDb, 30000);
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
}

function logInteraction(roomId, userId, displayName, eventType, payload) {
  run(
    'INSERT INTO interaction_log (roomId, userId, displayName, eventType, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [roomId, userId, displayName, eventType, JSON.stringify(payload), new Date().toISOString()]
  );
}

function saveFeedback(roomId, userId, displayName, category, text, contextJson, timestamp) {
  run(
    'INSERT INTO feedback (roomId, userId, displayName, category, text, contextJson, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [roomId, userId, displayName, category, text, JSON.stringify(contextJson), timestamp]
  );
}

module.exports = { initDatabase, saveDb, queryAll, queryOne, run, logInteraction, saveFeedback };
