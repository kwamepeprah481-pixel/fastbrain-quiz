const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware');

router.use(authMiddleware, adminMiddleware);

async function logAction(adminId, action, details) {
  await db.run('INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)',
    [adminId, action, JSON.stringify(details)]);
}

router.get('/users', async (req, res) => {
  try {
    const users = await db.all('SELECT id, email, username, role, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    await logAction(req.user.id, 'change_role', { target_user_id: req.params.id, new_role: role });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users', async (req, res) => {
  try {
    const { email, username, password, role } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username, and password are required' });
    }
    const existing = await db.get('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing) {
      return res.status(409).json({ error: 'Email or username already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    await db.run('INSERT INTO users (email, username, password, role) VALUES (?, ?, ?, ?)',
      [email, username, hash, role === 'admin' ? 'admin' : 'user']);
    const user = await db.get('SELECT id, email, username, role, created_at FROM users WHERE email = ?', [email]);
    await logAction(req.user.id, 'create_user', { user_id: user.id, email, username, role: role || 'user' });
    res.status(201).json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const target = await db.get('SELECT id, username FROM users WHERE id = ?', [req.params.id]);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    await db.run('DELETE FROM quiz_attempts WHERE user_id = ?', [req.params.id]);
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    await logAction(req.user.id, 'delete_user', { deleted_user_id: parseInt(req.params.id), username: target.username });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/subjects', async (req, res) => {
  try {
    const { id, name, icon, description, color_class } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Subject ID and name required' });
    await db.run('INSERT OR REPLACE INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)',
      [id, name, icon || '📘', description || '', color_class || '']);
    await logAction(req.user.id, 'create_subject', { id, name });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/subjects/:id', async (req, res) => {
  try {
    const { name, icon, description, color_class } = req.body;
    await db.run('UPDATE subjects SET name=?, icon=?, description=?, color_class=? WHERE id=?',
      [name, icon, description, color_class, req.params.id]);
    await logAction(req.user.id, 'update_subject', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/subjects/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM quizzes WHERE subject_id = ?', [req.params.id]);
    await db.run('DELETE FROM subjects WHERE id = ?', [req.params.id]);
    await logAction(req.user.id, 'delete_subject', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/quizzes', async (req, res) => {
  try {
    const quizzes = await db.all(
      `SELECT q.*, s.name as subject_name
       FROM quizzes q JOIN subjects s ON q.subject_id = s.id
       ORDER BY q.created_at DESC`
    );
    for (const q of quizzes) {
      q.question_count = (await db.get('SELECT COUNT(*) as cnt FROM questions WHERE quiz_id = ?', [q.id])).cnt;
    }
    res.json(quizzes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quizzes', async (req, res) => {
  try {
    const { id, subject_id, title, description, difficulty, questions } = req.body;
    if (!id || !subject_id || !title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Quiz id, subject_id, title and questions array required' });
    }
    await db.run('INSERT OR REPLACE INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, subject_id, title, description || '', difficulty || 'medium', req.user.id]);
    await db.run('DELETE FROM questions WHERE quiz_id = ?', [id]);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
        [id, q.q, JSON.stringify(q.o), q.a, i]);
    }
    await logAction(req.user.id, 'create_quiz', { id, title, question_count: questions.length });
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/quizzes/:id', async (req, res) => {
  try {
    const { title, description, difficulty, subject_id, questions } = req.body;
    await db.run('UPDATE quizzes SET title=?, description=?, difficulty=?, subject_id=? WHERE id=?',
      [title, description, difficulty, subject_id, req.params.id]);
    if (questions && Array.isArray(questions)) {
      await db.run('DELETE FROM questions WHERE quiz_id = ?', [req.params.id]);
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, q.q, JSON.stringify(q.o), q.a, i]);
      }
    }
    await logAction(req.user.id, 'update_quiz', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/quizzes/:id', async (req, res) => {
  try {
    const d = await db.getDb();
    d.run('DELETE FROM questions WHERE quiz_id = ?', [req.params.id]);
    d.run('DELETE FROM quiz_attempts WHERE quiz_id = ?', [req.params.id]);
    d.run('DELETE FROM quizzes WHERE id = ?', [req.params.id]);
    if (d.getRowsModified() === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    await logAction(req.user.id, 'delete_quiz', { id: req.params.id });
    // persist happens inside the next db.run call (logAction)
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const logs = await db.all(
      `SELECT al.*, u.username as admin_name
       FROM admin_logs al JOIN users u ON al.admin_id = u.id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import-bulk', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || !data.subjects || !data.quizzes) {
      return res.status(400).json({ error: 'Data must contain subjects and quizzes' });
    }
    for (const s of data.subjects) {
      await db.run('INSERT OR REPLACE INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)',
        [s.id, s.name, s.icon || '📘', s.desc || '', s.cls || '']);
    }
    let totalQuestions = 0;
    for (const [qid, quiz] of Object.entries(data.quizzes)) {
      await db.run('INSERT OR REPLACE INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [qid, quiz.subj_id || 'eng', quiz.title, quiz.desc, quiz.difficulty || 'medium', req.user.id]);
      await db.run('DELETE FROM questions WHERE quiz_id = ?', [qid]);
      if (quiz.qs) {
        for (let i = 0; i < quiz.qs.length; i++) {
          const q = quiz.qs[i];
          await db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
            [qid, q.q, JSON.stringify(q.o), q.a, i]);
        }
        totalQuestions += quiz.qs.length;
      }
    }
    await logAction(req.user.id, 'bulk_import', { subjects: data.subjects.length, quizzes: Object.keys(data.quizzes).length, questions: totalQuestions });
    res.json({ success: true, subjects: data.subjects.length, quizzes: Object.keys(data.quizzes).length, questions: totalQuestions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
