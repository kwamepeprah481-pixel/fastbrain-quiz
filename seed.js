const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'quizmaster.db');
const HTML_PATH = path.join(__dirname, 'ghana_b7_bece_quiz.html');

async function seed() {
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL;');
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, description TEXT, color_class TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
    difficulty TEXT DEFAULT 'medium', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id TEXT NOT NULL, question_text TEXT NOT NULL,
    options TEXT NOT NULL, answer INTEGER NOT NULL, question_order INTEGER NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, quiz_id TEXT NOT NULL,
    score INTEGER NOT NULL, total INTEGER NOT NULL, answers TEXT,
    completed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL,
    action TEXT NOT NULL, details TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);

  let buf = fs.readFileSync(HTML_PATH);
  let html;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    html = buf.toString('utf16le');
  } else {
    html = buf.toString('utf-8');
  }
  const startIdx = html.indexOf('const DATA = {');
  if (startIdx === -1) {
    console.error('Could not find DATA in HTML file');
    return;
  }
  let depth = 0, endIdx = startIdx + 13;
  for (let i = startIdx + 14; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth < 0) { endIdx = i + 1; break; } }
  }
  const dataStr = html.substring(startIdx + 13, endIdx);
  const DATA = eval('(' + dataStr + ')');

  db.run('DELETE FROM questions');
  db.run('DELETE FROM quizzes');
  db.run('DELETE FROM subjects');

  for (const s of DATA.subjects) {
    db.run('INSERT INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)',
      [s.id, s.name, s.icon, s.desc, s.cls]);
  }

  for (const [qid, quiz] of Object.entries(DATA.quizzes)) {
    const subj = DATA.subjects.find(s => s.quizzes.includes(qid));
    db.run('INSERT INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [qid, subj ? subj.id : 'eng', quiz.title, quiz.desc, quiz.difficulty, 1]);
    if (quiz.qs) {
      for (let i = 0; i < quiz.qs.length; i++) {
        const q = quiz.qs[i];
        db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
          [qid, q.q, JSON.stringify(q.o), q.a, i]);
      }
    }
  }

  const adminExists = db.exec('SELECT id FROM users WHERE email = "admin@quizmaster.com"');
  if (adminExists.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    db.run('INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)',
      ['admin@quizmaster.com', 'admin', hash, 'admin']);
  }

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log('Database seeded successfully!');
  console.log('Admin login: admin@quizmaster.com / admin123');
  console.log('Subjects:', DATA.subjects.length);
  console.log('Quizzes:', Object.keys(DATA.quizzes).length);
  const qCount = db.exec('SELECT COUNT(*) as c FROM questions')[0].values[0][0];
  console.log('Questions:', qCount);
}

if (require.main === module) {
  seed().catch(console.error);
}

module.exports = seed;
