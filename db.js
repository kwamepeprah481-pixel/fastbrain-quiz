const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'quizmaster.db');
const HTML_PATH = path.join(__dirname, 'ghana_b7_bece_quiz.html');

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  enableWAL(db);
  createTables(db);
  try { trySeed(db); } catch (e) { console.error('Seed error:', e.message); }
  return db;
}

function enableWAL(db) {
  try { db.run('PRAGMA journal_mode=WAL;'); } catch (_) {}
}

function createTables(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      color_class TEXT
    )
  `);
  db.run(`
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
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id TEXT NOT NULL,
      question_text TEXT NOT NULL,
      options TEXT NOT NULL,
      answer INTEGER NOT NULL,
      question_order INTEGER NOT NULL,
      FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
    )
  `);
  db.run(`
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
    )
  `);
  db.run(`
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
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (admin_id) REFERENCES users(id)
    )
  `);
  saveDb(db);
}

function trySeed(db) {
  const rows = db.exec('SELECT COUNT(*) as cnt FROM subjects');
  if (rows.length > 0 && rows[0].values[0][0] > 0) return;
  if (!fs.existsSync(HTML_PATH)) return;
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  const m = html.match(/const DATA\s*=\s*({[\s\S]*?});/);
  if (!m) return;
  const DATA = eval('(' + m[1] + ')');
  db.run('DELETE FROM questions');
  db.run('DELETE FROM quizzes');
  db.run('DELETE FROM subjects');
  for (const s of DATA.subjects) {
    db.run('INSERT INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)', [s.id, s.name, s.icon, s.desc, s.cls]);
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
  const adminExists = db.exec('SELECT id FROM users WHERE email = "admin@quizmaster.com"');
  if (adminExists.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)', ['admin@quizmaster.com', 'admin', hash, 'admin']);
  }
  saveDb(db);
  console.log('Database auto-seeded successfully');
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

async function query(sql, params = []) {
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

module.exports = { getDb, query, run, get, all };
