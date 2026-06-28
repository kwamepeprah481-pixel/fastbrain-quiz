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
    await db.run(
      'INSERT INTO quiz_attempts (user_id, quiz_id, score, total, answers) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, req.params.quizId, score, questions.length, JSON.stringify(answers)]
    );
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
       WHERE qa.user_id = ?
       ORDER BY qa.completed_at DESC`,
      [req.user.id]
    );
    const stats = await db.get(
      `SELECT COUNT(*) as total_attempts,
              COALESCE(SUM(score), 0) as total_correct,
              COALESCE(SUM(total), 0) as total_questions,
              ROUND(AVG(CAST(score AS REAL) / CAST(total AS REAL) * 100), 1) as avg_percent
       FROM quiz_attempts WHERE user_id = ?`,
      [req.user.id]
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
