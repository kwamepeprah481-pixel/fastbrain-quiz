const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const db = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.docx', '.pdf', '.doc'].includes(ext)) return cb(null, true);
    cb(new Error('Only .docx, .doc, and .pdf files are allowed'));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.use(authMiddleware, adminMiddleware);

async function logAction(adminId, action, details) {
  await db.run('INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)',
    [adminId, action, JSON.stringify(details)]);
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function parsePdf(filePath) {
  const buf = new Uint8Array(fs.readFileSync(filePath));
  const parser = new PDFParse(buf);
  const data = await parser.getText();
  return data.text;
}

async function parseFile(filePath, ext) {
  if (ext === '.pdf') return parsePdf(filePath);
  return parseDocx(filePath);
}

const MCQ_OPTION_RE = /^[\(]?[A-Da-d][\)\.\:\-]\s*/;
const MCQ_OPTION_RE_G = /[\(]?[A-Da-d][\)\.\:\-]\s*/g;
const MCQ_ANSWER_RE = /(?:answer|ans|correct|key)\s*:?\s*[\(]?([A-Da-d])[\)]?/i;

function extractQuestions(text) {
  const rawLines = text.split('\n');
  const lines = rawLines.map(l => l.trim());
  const questions = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]) { i++; continue; }
    const mcq = parseMCQ(lines, i);
    if (mcq) {
      questions.push({ q: mcq.question, o: mcq.options, a: mcq.answer });
      i = mcq.nextIndex;
      continue;
    }
    i++;
  }

  return questions;
}

function parseMCQ(lines, startIdx) {
  let question = lines[startIdx];
  if (question.length < 10) return null;

  // Strip leading number like "1.", "1)", "Question 1:", etc.
  question = question.replace(/^(?:Question\s*)?\d+[\.\)]\s*/i, '');

  let idx = startIdx + 1;
  // Skip blank lines after question
  while (idx < lines.length && !lines[idx]) idx++;

  let options = [];
  // Try parsing options on separate lines
  while (idx < lines.length && MCQ_OPTION_RE.test(lines[idx])) {
    options.push(lines[idx].replace(MCQ_OPTION_RE, ''));
    idx++;
    while (idx < lines.length && !lines[idx]) idx++;
  }

  // If no separate options found, try inline (options on the same line as question or next line)
  if (options.length !== 4) {
    const inlineOpts = tryParseInlineOptions(lines, startIdx);
    if (inlineOpts) {
      if (inlineOpts.question) question = inlineOpts.question;
      options = inlineOpts.options;
      idx = inlineOpts.nextIndex;
    }
  }

  // If still no 4 options, try plain lines without letter prefixes
  if (options.length !== 4) {
    const plainOpts = tryParsePlainOptions(lines, startIdx);
    if (plainOpts) {
      question = plainOpts.question;
      options = plainOpts.options;
      idx = plainOpts.nextIndex;
    }
  }

  if (options.length !== 4) return null;

  // Look for answer key within next few lines
  let answer = -1;
  for (let k = idx; k < Math.min(idx + 5, lines.length); k++) {
    if (!lines[k]) continue;
    const m = lines[k].match(MCQ_ANSWER_RE);
    if (m) {
      const letter = m[1].toUpperCase();
      const ai = 'ABCD'.indexOf(letter);
      if (ai !== -1) { answer = ai; idx = k + 1; break; }
    }
  }

  return { question, options, answer, nextIndex: idx };
}

function tryParseInlineOptions(lines, startIdx) {
  let line = lines[startIdx];
  let question = line;
  let nextIdx = startIdx + 1;

  let matches = [...line.matchAll(MCQ_OPTION_RE_G)];
  if (matches.length >= 4) {
    const options = [];
    question = line.slice(0, matches[0].index).trim();
    for (let m = 0; m < 4; m++) {
      const start = matches[m].index + matches[m][0].length;
      const end = m + 1 < matches.length ? matches[m + 1].index : line.length;
      options.push(line.slice(start, end).trim());
    }
    return { question, options, nextIndex: nextIdx };
  }

  if (nextIdx < lines.length && lines[nextIdx]) {
    const combined = line + ' ' + lines[nextIdx];
    matches = [...combined.matchAll(MCQ_OPTION_RE_G)];
    if (matches.length >= 4) {
      const options = [];
      for (let m = 0; m < 4; m++) {
        const start = matches[m].index + matches[m][0].length;
        const end = m + 1 < matches.length ? matches[m + 1].index : combined.length;
        options.push(combined.slice(start, end).trim());
      }
      return { question, options, nextIndex: nextIdx + 1 };
    }
  }

  return null;
}

function looksLikeQuestion(text) {
  if (text.length < 20) {
    // Very short: must end with a sentence-ending punctuation or ellipsis
    if (/[.?!…]$/.test(text)) return true;
    return false;
  }
  return true;
}

function tryParsePlainOptions(lines, startIdx) {
  let question = lines[startIdx];

  if (!looksLikeQuestion(question)) return null;

  let idx = startIdx + 1;
  while (idx < lines.length && !lines[idx]) idx++;

  // Check that we have a blank line between each option (separated pattern)
  // and that there are at least 4 non-blank lines within reasonable range
  const optLines = [];
  let scanIdx = idx;
  while (scanIdx < Math.min(idx + 15, lines.length) && optLines.length < 4) {
    if (lines[scanIdx]) {
      optLines.push({ text: lines[scanIdx], idx: scanIdx });
      scanIdx++;
    } else {
      scanIdx++;
    }
  }

  if (optLines.length !== 4) return null;

  for (const opt of optLines) {
    if (opt.text.length > 150) return null;
  }

  return {
    question,
    options: optLines.map(o => o.text),
    nextIndex: optLines[3].idx + 1
  };
}

function generateFillBlankQuestions(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const questions = [];
  const seen = new Set();

  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 30 || s.length > 300) continue;
    const words = s.split(/\s+/).filter(w => w.length > 3);
    const keyWords = words.filter(w =>
      /^[A-Z][a-z]/.test(w) || /^[a-z]{5,}$/.test(w)
    );
    if (keyWords.length < 2) continue;

    const keyword = keyWords[Math.floor(Math.random() * keyWords.length)];
    if (seen.has(keyword) || keyword.length < 4) continue;
    seen.add(keyword);

    const stem = s.replace(new RegExp(keyword, 'i'), '_____');
    const distractorPool = words.filter(w =>
      w.toLowerCase() !== keyword.toLowerCase() && w.length > 3
    ).slice(0, 6);
    const distractors = [...new Set(distractorPool)].slice(0, 3);
    while (distractors.length < 3) distractors.push('(other term)');

    const options = [keyword, ...distractors].sort(() => Math.random() - 0.5);
    const answerIdx = options.indexOf(keyword);

    questions.push({ q: stem, o: options, a: answerIdx });
    if (questions.length >= 40) break;
  }

  return questions;
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { subject_id, title } = req.body;
    if (!subject_id || !title || !req.file) {
      return res.status(400).json({ error: 'Subject, title, and file are required' });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const content = await parseFile(req.file.path, ext);

    await db.run(
      'INSERT INTO materials (subject_id, title, filename, content, file_type, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [subject_id, title, req.file.filename, content, ext, req.user.id]
    );
    const material = await db.get(
      'SELECT id, subject_id, title, filename, file_type, created_at FROM materials WHERE id = (SELECT MAX(id) FROM materials)'
    );
    await logAction(req.user.id, 'upload_material', { title, subject_id, filename: req.file.filename, original_name: req.file.originalname, content_length: content.length });

    const extracted = extractQuestions(content);

    res.status(201).json({ material, content_preview: content.slice(0, 5000), extracted_questions: extracted.slice(0, 40), fill_blank_questions: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const materials = await db.all(
      `SELECT m.*, s.name as subject_name
       FROM materials m JOIN subjects s ON m.subject_id = s.id
       ORDER BY m.created_at DESC`
    );
    for (const m of materials) {
      m.content_preview = m.content.slice(0, 200);
    }
    res.json(materials);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const material = await db.get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    const extracted = extractQuestions(material.content);
    res.json({ ...material, extracted_questions: extracted.slice(0, 40), fill_blank_questions: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const material = await db.get('SELECT filename FROM materials WHERE id = ?', [req.params.id]);
    if (!material) return res.status(404).json({ error: 'Material not found' });
    const filePath = path.join(UPLOAD_DIR, material.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await db.run('DELETE FROM materials WHERE id = ?', [req.params.id]);
    await logAction(req.user.id, 'delete_material', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auto-generate', upload.single('file'), async (req, res) => {
  try {
    const { subject_id, subject_name, title, difficulty } = req.body;
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const content = await parseFile(req.file.path, ext);

    const subjId = subject_id || content.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 10) || 'auto';
    const subjName = subject_name || title || req.file.originalname.replace(/\.[^.]+$/, '');
    const quizTitle = title || subjName + ' — Auto Quiz';
    const quizId = subjId + '-auto-' + Date.now().toString(36);

    const existingSubj = await db.get('SELECT id FROM subjects WHERE id = ?', [subjId]);
    if (!existingSubj) {
      await db.run('INSERT INTO subjects (id, name, icon, description, color_class) VALUES (?, ?, ?, ?, ?)',
        [subjId, subjName, '📄', 'Auto-created from uploaded material', '']);
    }

    const extracted = extractQuestions(content);
    const fillBlank = generateFillBlankQuestions(content);
    const allQuestions = [...extracted, ...fillBlank].slice(0, 40);

    if (allQuestions.length === 0) {
      return res.status(400).json({ error: 'No questions could be extracted from the file. Try a different file or create questions manually.' });
    }

    if (extracted.some(q => q.a === -1)) {
      return res.status(400).json({ error: 'No answer key found in the file. Please use "Upload & Review" to manually set correct answers before generating a quiz.' });
    }

    await db.run('INSERT OR REPLACE INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [quizId, subjId, quizTitle, 'Auto-generated from: ' + req.file.originalname, difficulty || 'medium', req.user.id]);
    await db.run('DELETE FROM questions WHERE quiz_id = ?', [quizId]);
    for (let i = 0; i < allQuestions.length; i++) {
      const q = allQuestions[i];
      await db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
        [quizId, q.q, JSON.stringify(q.o), q.a, i]);
    }

    await db.run(
      'INSERT INTO materials (subject_id, title, filename, content, file_type, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [subjId, quizTitle + ' (source)', req.file.filename, content, ext, req.user.id]
    );

    await logAction(req.user.id, 'auto_generate_all', { subject_id: subjId, quiz_id: quizId, title: quizTitle, question_count: allQuestions.length });

    res.status(201).json({
      success: true,
      subject: { id: subjId, name: subjName },
      quiz: { id: quizId, title: quizTitle, difficulty: difficulty || 'medium' },
      question_count: allQuestions.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/generate-quiz', async (req, res) => {
  try {
    const { material_id, quiz_id, subject_id, title, description, difficulty, questions } = req.body;
    if (!material_id || !quiz_id || !subject_id || !title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Material ID, quiz ID, subject, title, and questions array required' });
    }
    const valid = questions.every(q => q.q && q.o && q.o.length === 4 && q.a >= 0 && q.a <= 3);
    if (!valid) {
      return res.status(400).json({ error: 'Each question must have q, o (4 options), and a valid answer index (0-3)' });
    }
    await db.run('INSERT OR REPLACE INTO quizzes (id, subject_id, title, description, difficulty, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [quiz_id, subject_id, title, description || '', difficulty || 'medium', req.user.id]);
    await db.run('DELETE FROM questions WHERE quiz_id = ?', [quiz_id]);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await db.run('INSERT INTO questions (quiz_id, question_text, options, answer, question_order) VALUES (?, ?, ?, ?, ?)',
        [quiz_id, q.q, JSON.stringify(q.o), q.a, i]);
    }
    await logAction(req.user.id, 'generate_quiz_from_material', { material_id, quiz_id, title, question_count: questions.length });
    res.status(201).json({ success: true, quiz_id, question_count: questions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
