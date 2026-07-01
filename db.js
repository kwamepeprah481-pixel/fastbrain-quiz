const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'quizmaster.db');
const HTML_PATH = path.join(__dirname, 'ghana_b7_bece_quiz.html');

let db = null;
let pgPool = null;
let initPromise = null;

function isPostgres() {
  return !!process.env.DATABASE_URL;
}

async function getDb() {
  if (isPostgres()) return getPgPool();
  if (db) return db;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }
    enableWAL(db);
    createTablesSQLite(db);
    try { trySeedSQLite(db); } catch (e) { console.error('Seed error:', e.message); }
    return db;
  })();
  try { return await initPromise; } finally { initPromise = null; }
}

function getPgPool() {
  if (!pgPool) {
    const { Pool } = require('pg');
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
    });
  }
  return pgPool;
}

function pgify(sql) {
  let paramCount = 0;

  const upsertMatch = sql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (upsertMatch) {
    const cols = upsertMatch[2].split(',').map(c => c.trim());
    const vals = upsertMatch[3].split(',').map(v => v.trim());
    const pgVals = vals.map(v => v === '?' ? `$${++paramCount}` : v);
    const setClause = cols.map((c, i) => `${c} = ${pgVals[i]}`).join(', ');
    return `INSERT INTO ${upsertMatch[1]} (${cols.join(', ')}) VALUES (${pgVals.join(', ')}) ON CONFLICT (id) DO UPDATE SET ${setClause}`;
  }

  let result = sql.replace(/\?/g, () => `$${++paramCount}`);
  result = result.replace(/datetime\(\?\)/g, 'CURRENT_TIMESTAMP');
  result = result.replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP');
  return result;
}

function enableWAL(db) {
  try { db.run('PRAGMA journal_mode=WAL;'); } catch (_) {}
}

const CREATE_TABLES_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    description TEXT,
    color_class TEXT
  );
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    difficulty TEXT DEFAULT 'medium',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    options TEXT NOT NULL,
    answer INTEGER NOT NULL,
    question_order INTEGER NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    quiz_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    answers TEXT,
    status TEXT DEFAULT 'in_progress',
    completed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  );
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id TEXT NOT NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    file_type TEXT NOT NULL,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
  );
  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (admin_id) REFERENCES users(id)
  );
`;

const CREATE_TABLES_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    description TEXT,
    color_class TEXT
  );
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    difficulty TEXT DEFAULT 'medium',
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    options TEXT NOT NULL,
    answer INTEGER NOT NULL,
    question_order INTEGER NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    quiz_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    answers TEXT,
    status TEXT DEFAULT 'in_progress',
    completed_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  );
  CREATE TABLE IF NOT EXISTS materials (
    id SERIAL PRIMARY KEY,
    subject_id TEXT NOT NULL,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    file_type TEXT NOT NULL,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
  );
  CREATE TABLE IF NOT EXISTS admin_logs (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES users(id)
  );
`;

async function createTablesSQLite() {
  for (const stmt of CREATE_TABLES_SQLITE.split(';').filter(s => s.trim())) {
    db.run(stmt.trim() + ';');
  }
}

async function createTablesPG() {
  const pool = getPgPool();
  for (const stmt of CREATE_TABLES_PG.split(';').filter(s => s.trim())) {
    const client = await pool.connect();
    try {
      await client.query(stmt.trim() + ';');
    } finally {
      client.release();
    }
  }
}

function trySeedSQLite() {
  if (!fs.existsSync(HTML_PATH)) { console.log('Seed file not found:', HTML_PATH); return; }
  let buf = fs.readFileSync(HTML_PATH);
  let html;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    html = buf.toString('utf16le');
  } else {
    html = buf.toString('utf-8');
  }
  const startIdx = html.indexOf('const DATA = {');
  if (startIdx === -1) { console.log('DATA not found in seed file'); return; }
  let depth = 0;
  let endIdx = startIdx + 13;
  for (let i = startIdx + 14; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth < 0) { endIdx = i + 1; break; } }
  }
  const dataStr = html.substring(startIdx + 13, endIdx);
  let DATA;
  try { DATA = eval('(' + dataStr + ')'); } catch (e) { console.error('eval failed:', e.message); return; }
  if (!DATA || !DATA.subjects) { console.log('Invalid DATA structure'); return; }
  const existing = db.exec('SELECT COUNT(*) as c FROM subjects')[0].values[0][0];
  if (existing > 0) { console.log('Database already seeded (' + existing + ' subjects)'); return; }
  for (const s of DATA.subjects) {
    db.run('INSERT INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)', [s.id, s.name, s.icon || '', s.desc, s.cls]);
  }
  for (const [qid, quiz] of Object.entries(DATA.quizzes)) {
    const subj = DATA.subjects.find(s => s.quizzes.includes(qid));
    db.run('INSERT INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)', [qid, subj ? subj.id : 'eng', quiz.title, quiz.desc, quiz.difficulty, 1]);
    if (quiz.qs) {
      for (let i = 0; i < quiz.qs.length; i++) {
        const q = quiz.qs[i];
        db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)', [qid, q.q, JSON.stringify(q.o), q.a, i]);
      }
    }
  }
  saveDb(db);
  const cnt = db.exec('SELECT COUNT(*) as c FROM subjects')[0].values[0][0];
  console.log('Database auto-seeded:', cnt, 'subjects');
}

async function trySeedPG() {
  if (!fs.existsSync(HTML_PATH)) { console.log('Seed file not found:', HTML_PATH); return; }
  let buf = fs.readFileSync(HTML_PATH);
  let html;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    html = buf.toString('utf16le');
  } else {
    html = buf.toString('utf-8');
  }
  const startIdx = html.indexOf('const DATA = {');
  if (startIdx === -1) { console.log('DATA not found in seed file'); return; }
  let depth = 0;
  let endIdx = startIdx + 13;
  for (let i = startIdx + 14; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth < 0) { endIdx = i + 1; break; } }
  }
  const dataStr = html.substring(startIdx + 13, endIdx);
  let DATA;
  try { DATA = eval('(' + dataStr + ')'); } catch (e) { console.error('eval failed:', e.message); return; }
  if (!DATA || !DATA.subjects) { console.log('Invalid DATA structure'); return; }
  const rows = await pgQuery('SELECT COUNT(*) as c FROM subjects');
  if (rows[0].c > 0) { console.log('Database already seeded (' + rows[0].c + ' subjects)'); return; }
  const pool = getPgPool();
  for (const s of DATA.subjects) {
    await pgQuery('INSERT INTO subjects (id, name, icon, description, color_class) VALUES ($1, $2, $3, $4, $5)', [s.id, s.name, s.icon || '', s.desc, s.cls]);
  }
  for (const [qid, quiz] of Object.entries(DATA.quizzes)) {
    const subj = DATA.subjects.find(s => s.quizzes.includes(qid));
    await pgQuery('INSERT INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [qid, subj ? subj.id : 'eng', quiz.title, quiz.desc, quiz.difficulty, 1]);
    if (quiz.qs) {
      for (let i = 0; i < quiz.qs.length; i++) {
        const q = quiz.qs[i];
        await pgQuery('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES ($1, $2, $3, $4, $5)', [qid, q.q, JSON.stringify(q.o), q.a, i]);
      }
    }
  }
  const cnt = await pgQuery('SELECT COUNT(*) as c FROM subjects');
  console.log('Database auto-seeded:', cnt[0].c, 'subjects');
}

function saveDb(db) {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Save error:', e.message);
  }
}

function persistDb(db) {
  if (process.env.NODE_ENV !== 'test') {
    saveDb(db);
  }
}

async function pgQuery(text, params = []) {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

async function pgRun(text, params = []) {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return { changes: result.rowCount };
  } finally {
    client.release();
  }
}

async function query(sql, params = []) {
  if (isPostgres()) {
    const converted = pgify(sql);
    return pgQuery(converted, params);
  }
  const d = await getDb();
  const stmt = d.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function run(sql, params = []) {
  if (isPostgres()) {
    const converted = pgify(sql);
    return pgRun(converted, params);
  }
  const d = await getDb();
  try {
    d.run(sql, params);
    persistDb(d);
    return { changes: d.getRowsModified() };
  } catch (e) {
    throw e;
  }
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function all(sql, params = []) {
  return query(sql, params);
}

async function initialize() {
  if (isPostgres()) {
    await createTablesPG();
    await trySeedPG();
  } else {
    await getDb();
  }
}

module.exports = { getDb, query, run, get, all, initialize };
