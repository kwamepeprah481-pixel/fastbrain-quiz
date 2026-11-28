const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
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

function htmlToPlainText(html) {
  // Preserve formatting markers before stripping HTML
  html = html.replace(/<(?:strong|b)>(.*?)<\/(?:strong|b)>/g, '\x00B$1\x00b');
  html = html.replace(/<u>(.*?)<\/u>/g, '\x00U$1\x00u');
  html = html.replace(/<(?:em|i)>(.*?)<\/(?:em|i)>/g, '\x00I$1\x00i');

  // Convert list tags with nesting support.
  // Top-level items get numbered (1., 2., 3.…), nested items get lettered (a., b., c., d.…).
  // A newline is emitted before a nested <ol><ul> so the first option doesn't merge with question text.
  const listStack = [];
  html = html.replace(/<ol[^>]*>|<\/ol>|<ul[^>]*>|<\/ul>|<li>|<\/li>/gi, (match) => {
    if (match.startsWith('<ol')) {
      const s = match.match(/start\s*=\s*["\']?(\d+)/i);
      listStack.push({ counter: (s ? parseInt(s[1]) - 1 : 0), isOrdered: true });
      return listStack.length > 1 ? '\n' : '';
    }
    if (match.startsWith('<ul')) {
      listStack.push({ counter: 0, isOrdered: false });
      return listStack.length > 1 ? '\n' : '';
    }
    if (match === '</ol>' || match === '</ul>') {
      listStack.pop();
      return '\n';
    }
    if (match === '<li>') {
      if (listStack.length === 0) return '* ';
      const cur = listStack[listStack.length - 1];
      cur.counter++;
      if (listStack.length > 1) {
        return String.fromCharCode(96 + cur.counter) + '. ';
      }
      return cur.counter + '. ';
    }
    if (match === '</li>') return '\n';
    return match;
  });

  // Handle <p> and <br> newlines
  html = html.replace(/<\/p>\s*<p>/g, '\n\n');
  html = html.replace(/<\/p>/g, '\n');
  html = html.replace(/<p>/g, '');
  html = html.replace(/<br\s*\/?>/g, '\n');

  // Strip remaining HTML tags
  html = html.replace(/<[^>]*>/g, '');

  // Decode HTML entities
  html = html.replace(/&amp;/g, '&');
  html = html.replace(/&lt;/g, '<');
  html = html.replace(/&gt;/g, '>');
  html = html.replace(/&quot;/g, '"');
  html = html.replace(/&#39;/g, "'");
  html = html.replace(/&nbsp;/g, ' ');
  html = html.replace(/&deg;/g, '°');
  html = html.replace(/&#176;/g, '°');
  html = html.replace(/&#x?B0;/gi, '°');

  // Convert formatting markers to final form
  html = html.replace(/\x00B(.*?)\x00b/g, '**$1**');
  html = html.replace(/\x00U(.*?)\x00u/g, '__$1__');
  html = html.replace(/\x00I(.*?)\x00i/g, '*$1*');

  // Remove list numbering incorrectly applied to option lines (e.g., "1. A. stains" → "A. stains")
  html = html.replace(/^\d+[\.\)]\s+(?=[A-Da-d][\.\)])/gm, '');

  // Clean up excessive whitespace
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

async function parseDocx(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath });
  return htmlToPlainText(result.value);
}

async function parsePdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = new Uint8Array(fs.readFileSync(filePath));
  const standardFontDataUrl = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts')
    .split(path.sep).join('/') + '/';

  const doc = await pdfjs.getDocument({ data: buf, standardFontDataUrl }).promise;
  const lines = [];
  // Raised glyphs (superscripts) are often used for degree signs / exponents.
  const superscripts = { '0': '°', '1': '¹', '2': '²', '3': '³', 'n': 'ⁿ' };
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      let prev = null;
      for (const item of content.items) {
        const str = item.str || '';
        const size = Math.hypot(item.transform[0], item.transform[1]);
        const y = item.transform[5];
        let text = str;
        if (prev && str && size > 0 && size < prev.size * 0.85 && y > prev.y + prev.size * 0.15) {
          text = [...str].map(ch => superscripts[ch] || ch).join('');
        }
        line += text;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
          prev = null;
        } else if (str.trim()) {
          prev = { size, y };
        }
      }
      if (line.trim()) lines.push(line);
    }
  } finally {
    await doc.destroy();
  }
  return lines.join('\n');
}

async function parseFile(filePath, ext) {
  if (ext === '.pdf') return parsePdf(filePath);
  return parseDocx(filePath);
}

const MCQ_OPTION_RE = /^[\(]?[A-Da-d][\)\.\:\-]\s*/;
const MCQ_OPTION_RE_G = /(?:\(?[A-D]|(?<![a-zA-Z])\(?[a-d])[\)\.\:\-]\s*/g;
const MCQ_ANSWER_RE = /\b(?:answer|ans|correct|key)\s*:?\s*[\(]?([A-Da-d])[\)]?(?![a-zA-Z])/i;

function parseClozePassage(lines, startIdx) {
  const line = lines[startIdx];
  // Detect passage: contains gap markers like ---31--- or ---**31**---
  const gapRegex = /---\**(\d+)\**---/g;
  const gaps = [];
  let m;
  while ((m = gapRegex.exec(line)) !== null) {
    gaps.push(parseInt(m[1]));
  }
  if (gaps.length === 0) return null;
  if (line.length < 30) return null;

  // Clean passage text: strip ** from gap markers
  const cleanLine = line.replace(gapRegex, '---$1---');

  let idx = startIdx + 1;
  while (idx < lines.length && !lines[idx]) idx++;

  const questions = [];
  for (let g = 0; g < gaps.length; g++) {
    const options = [];
    for (let o = 0; o < 4; o++) {
      if (idx >= lines.length) return questions.length > 0 ? questions : null;
      let optLine = lines[idx];
      // Handle list-numbered option lines (e.g., "1. A. stains" → "A. stains")
      if (!MCQ_OPTION_RE.test(optLine)) {
        optLine = optLine.replace(/^\d+[\.\)]\s*/, '');
      }
      if (!MCQ_OPTION_RE.test(optLine)) return questions.length > 0 ? questions : null;
      options.push(optLine.replace(MCQ_OPTION_RE, ''));
      idx++;
      while (idx < lines.length && !lines[idx]) idx++;
    }
    questions.push({
      q: cleanLine + '\n\nChoose the word that is most suitable for gap ' + gaps[g] + '.',
      o: options,
      a: -1,
      nextIndex: idx
    });
  }
  return questions;
}

function extractQuestions(text) {
  const rawLines = text.split('\n');
  const lines = rawLines.map(l => l.trim());
  const questions = [];
  let i = 0;
  let currentInstruction = null;

  while (i < lines.length) {
    if (!lines[i]) { i++; continue; }

    // Try cloze passage format first (passage with gap markers ---N---)
    const passageQuestions = parseClozePassage(lines, i);
    if (passageQuestions) {
      for (const pq of passageQuestions) {
        questions.push({ q: pq.q, o: pq.o, a: pq.a });
      }
      const last = passageQuestions[passageQuestions.length - 1];
      i = last.nextIndex;
      currentInstruction = null;
      continue;
    }

    const mcq = parseMCQ(lines, i);
    if (mcq) {
      if (currentInstruction) {
        mcq.question = '__SECTION__' + currentInstruction + '\n' + mcq.question;
        currentInstruction = null;
      }
      questions.push({ q: mcq.question, o: mcq.options, a: mcq.answer });
      i = mcq.nextIndex;
      continue;
    }
    // Capture instruction lines as section headings for subsequent questions
    const instrCheck = lines[i].replace(/[\*_]/g, '').trim();
    if (!instrCheck.includes('?') && (/^(?:choose|select|read|answer|use|write|complete|fill|match|note|instruction|direction)/i.test(instrCheck) || /(?:choose the|from the options|for each|the correct|the suitable)/i.test(instrCheck))) {
      currentInstruction = lines[i];
    }
    i++;
  }

  return questions;
}

function stripLeadingNumberPrefix(text) {
  let s = text;
  let prev;
  do {
    prev = s;
    s = s.replace(/^[\*_]*(?:\s*(?:Question\s*)?\d+[\.\)]\s*)?/i, '').replace(/[\*_]+$/, '');
  } while (s !== prev);
  return s;
}

function parseMCQ(lines, startIdx) {
  let question = lines[startIdx];
  if (question.length < 10) return null;

  // Strip leading/trailing formatting markers (*/_) before prefix detection
  const stripped = question.replace(/[\*_]/g, '');
  const hadPrefix = /^\d+[\.\)]/.test(stripped);

  // Strip leading formatting markers + number prefix + trailing markers
  question = stripLeadingNumberPrefix(question);

  // Skip section headers (SECTION A:, PART I:, etc.)
  if (/^(?:SECTION|PART|UNIT|TOPIC|CHAPTER)\s/i.test(question)) return null;
  if (/\(questions?\s+\d+/i.test(question)) return null;

  let idx = startIdx + 1;
  // Skip blank lines after question
  while (idx < lines.length && !lines[idx]) idx++;

  let options = [];
  // Try parsing options on separate lines
  while (idx < lines.length && MCQ_OPTION_RE.test(lines[idx]) && options.length < 4) {
    const optText = lines[idx].replace(MCQ_OPTION_RE, '').trim();
    if (optText) options.push(optText);
    idx++;
    while (idx < lines.length && !lines[idx]) idx++;
  }

  // If no separate options found, try inline (options on the same line as question or next line)
  if (options.length !== 4) {
    const inlineOpts = tryParseInlineOptions(lines, startIdx);
    if (inlineOpts) {
      if (inlineOpts.question !== undefined) {
        question = inlineOpts.question;
      }
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

  // Reject instruction lines (not real questions)
  // Relaxed: if we actually found 4 options, it's likely a question even if it looks like an instruction
  if (!hadPrefix && !question.includes('?') && options.length !== 4) {
    const qLower = question.toLowerCase();
    if (/^(?:choose|select|read|answer|use|write|complete|fill|match|note|instruction|direction)/i.test(question) || /(?:choose the|from the options|for each)/i.test(qLower)) return null;
  }

  if (options.length !== 4) return null;

  // Look for answer key within next few lines, but never scan into the next
  // question. Otherwise a following question's option text (e.g. "C. key")
  // can falsely match MCQ_ANSWER_RE and cause that question to be swallowed.
  let answer = -1;
  for (let k = idx; k < Math.min(idx + 5, lines.length); k++) {
    if (!lines[k]) continue;
    if (/^\d+[\.\)]\s+\S/.test(lines[k])) break;
    const m = lines[k].match(MCQ_ANSWER_RE);
    if (m) {
      const letter = m[1].toUpperCase();
      const ai = 'ABCD'.indexOf(letter);
      if (ai !== -1) { answer = ai; idx = k + 1; break; }
    }
  }

  // Strip leading letter option prefixes from question when options were extracted inline.
  // e.g. "A. their B. themselves C. them D. theirs" → "their B. themselves C. them D. theirs"
  // Only strip when we have 4 options and the question still has a leading letter+dot+space pattern.
  if (options.length === 4 && /^[A-Da-d][\.\)]\s*/.test(question)) {
    question = question.replace(/^[A-Da-d][\.\)]\s*/, '');
  }

  return { question, options, answer, nextIndex: idx };
}

function tryParseInlineOptions(lines, startIdx) {
  let line = lines[startIdx];
  let question = line;
  let nextIdx = startIdx + 1;
  while (nextIdx < lines.length && !lines[nextIdx]) nextIdx++;

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
    if (/[.?!…]$/.test(text)) return true;
    return false;
  }
  // Reject section headers and instructions
  if (/^(?:SECTION|PART|UNIT|TOPIC|CHAPTER)\s/i.test(text)) return false;
  if (/\(questions?\s+\d+/i.test(text)) return false;
  if (!text.includes('?')) {
    if (/^(?:choose|select|read|answer|use|write|complete|fill|match|note|instruction|direction)/i.test(text)) return false;
    if (/(?:choose the|from the options|for each)/i.test(text)) return false;
  }
  return true;
}

function tryParsePlainOptions(lines, startIdx) {
  let question = lines[startIdx];

  if (!looksLikeQuestion(question)) return null;

  // Strip any leading number prefix from question (e.g. "5. All the following…" → "All the following…")
  question = stripLeadingNumberPrefix(question).trim();

  // Detect an absorbed first option fused onto the question line.
  // Three patterns:
  //   1) "?1. Option"         – '?' immediately before the option number
  //   2) "? 6. 7. 1. Option"  – '?' followed by artifact numbers then the real option
  //   3) "except 1. Option"    – no '?' at all, option attached at the end
  let absorbedOpt = null;
  {
    // Work on the suffix after the last '?' (if any)
    const qi = question.lastIndexOf('?');
    const suffix = qi >= 0 ? question.slice(qi + 1).trim() : question;
    // Find every "N." segment in the suffix and pick the LAST one whose N is 1-4
    const segments = [...suffix.matchAll(/(\d+)[\.\)]\s*/g)];
    let pickIdx = -1;
    for (let si = segments.length - 1; si >= 0; si--) {
      const n = parseInt(segments[si][1]);
      if (n >= 1 && n <= 4) { pickIdx = segments[si].index; break; }
    }
    if (pickIdx >= 0) {
      const absText = suffix.slice(pickIdx).trim();
      // Only treat it as absorbed if there's actual option text (not just a bare number)
      const textAfter = absText.replace(/^\d+[\.\)]\s*/, '').trim();
      if (textAfter.length > 0) {
        absorbedOpt = absText;
        // Chop off everything from the split point
        if (qi >= 0) {
          question = question.slice(0, qi + 1).trim();
          // Restore the '?'
          question = question.replace(/\?+$/, '?');
        } else {
          question = question.slice(0, pickIdx).trim();
        }
      }
    }
  }

  let idx = startIdx + 1;
  while (idx < lines.length && !lines[idx]) idx++;

  // Collect up to 8 candidate lines to detect mixed formats
  const candidates = [];
  let scanIdx = idx;
  while (scanIdx < Math.min(idx + 20, lines.length) && candidates.length < 8) {
    if (lines[scanIdx]) {
      candidates.push({ text: lines[scanIdx], idx: scanIdx });
    }
    scanIdx++;
  }

  // Determine if we have a mix of lettered (A-D/a-d) and numbered lines
  const hasLettered = candidates.some(c => MCQ_OPTION_RE.test(c.text));
  const hasNumbered = candidates.some(c => /^\d+[\.\)]\s*/.test(c.text));

  let optLines;
  if (hasLettered && hasNumbered && !absorbedOpt) {
    // Scan for lettered options, but stop if we cross into the next question.
    // Track numbered lines encountered — if we hit a question boundary (numbered line
    // with >20 chars that's not an option), use those numbered lines as the options.
    optLines = [];
    const numberedLines = [];
    let extIdx = idx;
    while (extIdx < Math.min(idx + 20, lines.length) && optLines.length < 4) {
      if (lines[extIdx]) {
        // Check if this line looks like the next question (numbered, long, not letter-option)
        const numMatch = lines[extIdx].match(/^(\d+)[\.\)]\s*/);
        if (numMatch && lines[extIdx].length > 20 && !MCQ_OPTION_RE.test(lines[extIdx])) {
          if (numberedLines.length >= 3) {
            optLines = numberedLines.slice(0, 4);
          }
          break;
        }
        if (numMatch) {
          numberedLines.push({ text: lines[extIdx], idx: extIdx });
        } else if (MCQ_OPTION_RE.test(lines[extIdx])) {
          const txt = lines[extIdx].replace(MCQ_OPTION_RE, '').trim();
          if (txt) optLines.push({ text: lines[extIdx], idx: extIdx });
        }
      }
      extIdx++;
    }
  } else {
    // Standard: use first 4 candidates
    optLines = candidates.slice(0, 4);
    if (absorbedOpt && optLines.length > 3) optLines = optLines.slice(0, 3);
  }

  if (absorbedOpt && optLines.length !== 3) return null;
  if (!absorbedOpt && optLines.length !== 4) return null;

  for (const opt of optLines) {
    if (opt.text.length > 150) return null;
  }

  // Strip all leading number prefixes from option text (handles artifacts like "6. 7. 1. Rain forest")
  const stripNumericPrefixes = (s) => {
    let r = s;
    while (/^\d+[\.\)]\s*/.test(r)) r = r.replace(/^\d+[\.\)]\s*/, '');
    return r.trim();
  };
  let options = optLines.map(o => {
    const t = stripNumericPrefixes(o.text);
    // Also strip letter prefix if present (e.g. "a. Option text" → "Option text")
    return t.replace(MCQ_OPTION_RE, '');
  });
  if (absorbedOpt) {
    options = [stripNumericPrefixes(absorbedOpt), ...options];
  }

  return {
    question,
    options,
    nextIndex: optLines[optLines.length - 1].idx + 1
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
    let { material_id, quiz_id, subject_id, title, description, difficulty, questions } = req.body;
    if (!material_id || !quiz_id || !subject_id || !title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Material ID, quiz ID, subject, title, and questions array required' });
    }
    const valid = questions.every(q => q.q && q.o && q.o.length === 4 && q.a >= 0 && q.a <= 3);
    if (!valid) {
      return res.status(400).json({ error: 'Each question must have q, o (4 options), and a valid answer index (0-3)' });
    }
    // Prefix quiz_id with subject_id to prevent cross-subject overwrites
    if (!quiz_id.startsWith(subject_id + '--')) {
      quiz_id = subject_id + '--' + quiz_id;
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
module.exports.extractQuestions = extractQuestions;
module.exports.htmlToPlainText = htmlToPlainText;
module.exports.parseFile = parseFile;
