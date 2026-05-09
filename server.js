require('dotenv').config();
var express = require('express');
var fetch   = require('node-fetch');
var path    = require('path');
var fs      = require('fs');
var bcrypt  = require('bcryptjs');
var jwt     = require('jsonwebtoken');

var app    = express();
var PORT   = process.env.PORT || 3000;
var SECRET = process.env.JWT_SECRET || 'nexo-secret-2025';
var DB     = path.join(__dirname, 'users.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Base de datos JSON ───────────────────────
function getUsers() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch (e) { return {}; }
}

function setUsers(u) {
  try { fs.writeFileSync(DB, JSON.stringify(u, null, 2)); }
  catch (e) { console.log('DB error:', e.message); }
}

// ─── Middleware JWT ───────────────────────────
function auth(req, res, next) {
  var header = req.headers.authorization || '';
  var token  = header.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Inicia sesion para usar IA-NEXO.' });
  }
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sesion expirada. Inicia sesion de nuevo.' });
  }
}

// ─── REGISTRO ────────────────────────────────
app.post('/auth/register', async function(req, res) {
  var body     = req.body || {};
  var nombre   = (body.nombre   || '').trim();
  var email    = (body.email    || '').trim().toLowerCase();
  var password = (body.password || '');

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Email invalido.' });
  }

  var users = getUsers();
  if (users[email]) {
    return res.status(400).json({ error: 'Ya existe una cuenta con ese email.' });
  }

  var hash = await bcrypt.hash(password, 10);
  var id   = 'u' + Date.now();
  users[email] = { id: id, nombre: nombre, email: email, password: hash, creado: new Date().toISOString() };
  setUsers(users);

  var token = jwt.sign({ id: id, nombre: nombre, email: email }, SECRET, { expiresIn: '30d' });
  res.json({ token: token, nombre: nombre, email: email });
});

// ─── LOGIN ────────────────────────────────────
app.post('/auth/login', async function(req, res) {
  var body     = req.body || {};
  var email    = (body.email    || '').trim().toLowerCase();
  var password = (body.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contrasena requeridos.' });
  }

  var users = getUsers();
  var user  = users[email];
  if (!user) {
    return res.status(401).json({ error: 'No existe cuenta con ese email.' });
  }

  var ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.status(401).json({ error: 'Contrasena incorrecta.' });
  }

  var token = jwt.sign({ id: user.id, nombre: user.nombre, email: email }, SECRET, { expiresIn: '30d' });
  res.json({ token: token, nombre: user.nombre, email: email });
});

// ─── VERIFICAR SESION ─────────────────────────
app.get('/auth/me', auth, function(req, res) {
  res.json({ nombre: req.user.nombre, email: req.user.email });
});

// ─── PROMPTS ESPECIALIZADOS ───────────────────
var PROMPTS = {
  saber:    'Eres NEXO-SABER, especialista en informacion e investigacion. Responde SIEMPRE en espanol con datos precisos, verificables y bien estructurados. Usa listas cuando ayude.',
  codigo:   'Eres NEXO-CODIGO, experto en programacion y matematicas. Responde SIEMPRE en espanol. Usa bloques de codigo con el lenguaje apropiado. Explica cada paso con claridad.',
  creativo: 'Eres NEXO-CREATIVO, asistente creativo especializado en arte, escritura e ideas. Responde SIEMPRE en espanol. Se expresivo, imaginativo y original en cada respuesta.',
  sabio:    'Eres NEXO-SABIO, especialista en analisis profundo, filosofia y reflexion. Responde SIEMPRE en espanol con matices, profundidad y multiples perspectivas.'
};

// ─── FUNCION GEMINI ───────────────────────────
function llamarGemini(history, text, prompt, cb) {
  var key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.indexOf('PEGA_') === 0) {
    return cb(new Error('GEMINI_KEY no configurada en variables de entorno.'));
  }

  var hist = (history || []).slice(-14).map(function(m) {
    return {
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    };
  });

  hist.push({ role: 'user', parts: [{ text: text }] });

  var modelos = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
  var index   = 0;

  function tryNext() {
    if (index >= modelos.length) {
      return cb(new Error('Gemini no disponible. Intenta de nuevo en un momento.'));
    }
    var modelo = modelos[index++];
    var url    = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + key;

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents:           hist,
        generationConfig:   { maxOutputTokens: 1500, temperature: 0.7 }
      })
    })
    .then(function(r) { return r.text(); })
    .then(function(raw) {
      var json;
      try { json = JSON.parse(raw); } catch (e) { return tryNext(); }
      if (json.error) { console.log('skip', modelo, json.error.message); return tryNext(); }
      var parts = json.candidates && json.candidates[0] &&
                  json.candidates[0].content && json.candidates[0].content.parts;
      var reply = parts && parts[0] && parts[0].text;
      if (!reply) return tryNext();
      console.log('OK', modelo);
      cb(null, reply.trim());
    })
    .catch(function(e) { console.log('err', modelo, e.message); tryNext(); });
  }

  tryNext();
}

// ─── RUTAS IA (protegidas con JWT) ───────────
app.post('/api/saber', auth, function(req, res) {
  llamarGemini(req.body.history, req.body.text, PROMPTS.saber, function(err, reply) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ reply: reply });
  });
});

app.post('/api/codigo', auth, function(req, res) {
  llamarGemini(req.body.history, req.body.text, PROMPTS.codigo, function(err, reply) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ reply: reply });
  });
});

app.post('/api/creativo', auth, function(req, res) {
  llamarGemini(req.body.history, req.body.text, PROMPTS.creativo, function(err, reply) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ reply: reply });
  });
});

app.post('/api/sabio', auth, function(req, res) {
  llamarGemini(req.body.history, req.body.text, PROMPTS.sabio, function(err, reply) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ reply: reply });
  });
});

// ─── IMAGEN ───────────────────────────────────
app.post('/api/imagen', auth, function(req, res) {
  var prompt = (req.body.prompt || '').slice(0, 400);
  if (!prompt) return res.status(400).json({ error: 'Falta el prompt.' });
  var p    = encodeURIComponent(prompt);
  var seed = Math.floor(Math.random() * 999999);
  res.json({ imageUrl: 'https://image.pollinations.ai/prompt/' + p + '?width=768&height=768&seed=' + seed + '&nologo=true&nofeed=true' });
});

// ─── RUTA PRINCIPAL ───────────────────────────
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── INICIO ───────────────────────────────────
app.listen(PORT, function() {
  var g = process.env.GEMINI_KEY && process.env.GEMINI_KEY.indexOf('PEGA_') !== 0;
  console.log('');
  console.log('  IA-NEXO v5.0 corriendo en puerto ' + PORT);
  console.log('  Gemini:  ' + (g ? 'OK' : 'Falta GEMINI_KEY'));
  console.log('  Auth:    JWT + bcrypt activo');
  console.log('');
});
