const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const db = require('./db');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/quizzes'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/materials', require('./routes/materials'));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});
app.get('/admin.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(PUBLIC, 'admin.html'));
});
app.get('*', (req, res) => {
  const p = path.join(PUBLIC, req.path === '/' ? 'index.html' : req.path);
  if (fs.existsSync(p)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.sendFile(p);
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, async () => {
  console.log(`QuizMaster server running at http://localhost:${PORT}`);
  try {
    await db.initialize();
    const admin = await db.get('SELECT id FROM users WHERE email = ?', ['admin@quizmaster.com']);
    if (!admin) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('admin123', 10);
      await db.run('INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)',
        ['admin@quizmaster.com', 'admin', hash, 'admin']);
      console.log('Admin user created');
    } else {
      console.log('Admin user exists');
    }
  } catch (e) {
    console.error('Admin check error:', e.message);
  }
});
