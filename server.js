const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/quizzes'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/materials', require('./routes/materials'));

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('*', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (require('fs').existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('index.html not found at ' + filePath);
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`QuizMaster server running at http://localhost:${PORT}`);
});
