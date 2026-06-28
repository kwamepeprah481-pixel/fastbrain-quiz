const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../middleware');

router.get('/subjects', async (req, res) => {
  try {
    const subjects = await db.all('SELECT * FROM subjects ORDER BY name');
    for (const s of subjects) {
      const qs = await db.all('SELECT id, title, description, difficulty FROM quizzes WHERE subject_id = ?', [s.id]);
      s.quizzes = qs;
    }
    res.json(subjects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/quizzes/in-progress', authMiddleware, async (req, res) => {
  try {
    const attempt = await db.get(
      `SELECT qa.*, q.title as quiz_title, q.difficulty, s.name as subject_name, s.id as subject_id
       FROM quiz_attempts qa
       JOIN quizzes q ON qa.quiz_id = q.id
       JOIN subjects s ON q.subject_id = s.id
       WHERE qa.user_id = ? AND qa.status = ?
       ORDER BY qa.id DESC LIMIT 1`,
      [req.user.id, 'in_progress']
    );
    if (!attempt) return res.json(null);
    const questions = await db.all(
      'SELECT id, question_text, options, answer, question_order FROM questions WHERE quiz_id = ? ORDER BY question_order',
      [attempt.quiz_id]
    );
    res.json({ ...attempt, questions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/quizzes/:quizId', authMiddleware, async (req, res) => {
  try {
    const quiz = await db.get('SELECT * FROM quizzes WHERE id = ?', [req.params.quizId]);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const questions = await db.all(
      'SELECT id, question_text, options, answer, question_order FROM questions WHERE quiz_id = ? ORDER BY question_order',
      [req.params.quizId]
    );
    res.json({ ...quiz, questions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quizzes/:quizId/start', authMiddleware, async (req, res) => {
  try {
    const existing = await db.get(
      'SELECT * FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND status = ?',
      [req.user.id, req.params.quizId, 'in_progress']
    );
    if (existing) {
      const questions = await db.all(
        'SELECT id, question_text, options, answer, question_order FROM questions WHERE quiz_id = ? ORDER BY question_order',
        [req.params.quizId]
      );
      return res.json({ ...existing, questions });
    }
    const quiz = await db.get('SELECT * FROM quizzes WHERE id = ?', [req.params.quizId]);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const questions = await db.all(
      'SELECT id, question_text, options, answer, question_order FROM questions WHERE quiz_id = ? ORDER BY question_order',
      [req.params.quizId]
    );
    const total = questions.length;
    await db.run(
      'INSERT INTO quiz_attempts (user_id, quiz_id, score, total, answers, status) VALUES (?, ?, 0, ?, ?, ?)',
      [req.user.id, req.params.quizId, total, JSON.stringify([]), 'in_progress']
    );
    const attempt = await db.get(
      'SELECT * FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND status = ?',
      [req.user.id, req.params.quizId, 'in_progress']
    );
    res.json({ ...attempt, questions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quizzes/:quizId/save-progress', authMiddleware, async (req, res) => {
  try {
    const { answers, score } = req.body;
    const attempt = await db.get(
      'SELECT id FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND status = ?',
      [req.user.id, req.params.quizId, 'in_progress']
    );
    if (!attempt) return res.status(404).json({ error: 'No active quiz session' });
    await db.run(
      'UPDATE quiz_attempts SET answers = ?, score = ? WHERE id = ?',
      [JSON.stringify(answers), score || 0, attempt.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quizzes/:quizId/abandon', authMiddleware, async (req, res) => {
  try {
    await db.run(
      'UPDATE quiz_attempts SET status = ?, completed_at = datetime(?) WHERE user_id = ? AND quiz_id = ? AND status = ?',
      ['abandoned', 'now', req.user.id, req.params.quizId, 'in_progress']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quizzes/:quizId/submit', authMiddleware, async (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Answers array required' });
    }
    const questions = await db.all(
      'SELECT id, answer FROM questions WHERE quiz_id = ? ORDER BY question_order',
      [req.params.quizId]
    );
    if (answers.length !== questions.length) {
      return res.status(400).json({ error: 'Answer count mismatch' });
    }
    let score = 0;
    const graded = answers.map((a, i) => {
      const correct = a === questions[i].answer;
      if (correct) score++;
      return { question_id: questions[i].id, user_answer: a, correct_answer: questions[i].answer, correct };
    });
    const existing = await db.get(
      'SELECT id FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? AND status = ?',
      [req.user.id, req.params.quizId, 'in_progress']
    );
    if (existing) {
      await db.run(
        'UPDATE quiz_attempts SET score = ?, answers = ?, status = ?, completed_at = datetime(?) WHERE id = ?',
        [score, JSON.stringify(answers), 'completed', 'now', existing.id]
      );
    } else {
      await db.run(
        'INSERT INTO quiz_attempts (user_id, quiz_id, score, total, answers, status, completed_at) VALUES (?, ?, ?, ?, ?, ?, datetime(?))',
        [req.user.id, req.params.quizId, score, questions.length, JSON.stringify(answers), 'completed', 'now']
      );
    }
    const attempt = await db.get(
      'SELECT id, score, total, completed_at FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? ORDER BY id DESC LIMIT 1',
      [req.user.id, req.params.quizId]
    );
    res.json({ ...attempt, graded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/progress', authMiddleware, async (req, res) => {
  try {
    const attempts = await db.all(
      `SELECT qa.id, qa.quiz_id, qa.score, qa.total, qa.completed_at, q.title as quiz_title, q.difficulty,
              s.name as subject_name, s.id as subject_id
       FROM quiz_attempts qa
       JOIN quizzes q ON qa.quiz_id = q.id
       JOIN subjects s ON q.subject_id = s.id
       WHERE qa.user_id = ? AND qa.status = ?
       ORDER BY qa.completed_at DESC`,
      [req.user.id, 'completed']
    );
    const stats = await db.get(
      `SELECT COUNT(*) as total_attempts,
              COALESCE(SUM(score), 0) as total_correct,
              COALESCE(SUM(total), 0) as total_questions,
              ROUND(AVG(CAST(score AS REAL) / CAST(total AS REAL) * 100), 1) as avg_percent
       FROM quiz_attempts WHERE user_id = ? AND status = ?`,
      [req.user.id, 'completed']
    );
    res.json({ attempts, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/progress/:quizId', authMiddleware, async (req, res) => {
  try {
    const attempts = await db.all(
      `SELECT id, score, total, completed_at
       FROM quiz_attempts
       WHERE user_id = ? AND quiz_id = ?
       ORDER BY completed_at DESC`,
      [req.user.id, req.params.quizId]
    );
    res.json(attempts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
