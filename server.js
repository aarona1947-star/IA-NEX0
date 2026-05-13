require('dotenv').config();
var express = require('express');
var fetch   = require('node-fetch');
var path    = require('path');
var fs      = require('fs');
var bcrypt  = require('bcryptjs');
var jwt     = require('jsonwebtoken');

var app    = express();
var PORT   = process.env.PORT || 3000;
var SECRET = process.env.JWT_SECRET || 'nexo-secret-2025-change-this';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE: MongoDB Atlas (si MONGO_URI) o archivo local ───
var useMongo = false;
var mongoClient = null;
var mongoDB = null;

// Intentar conectar a MongoDB si hay URI configurada
if (process.env.MONGO_URI) {
  try {
    var mongodb = require('mongodb');
    var MongoClient = mongodb.MongoClient;
    MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
      .then(function(client) {
        mongoClient = client;
        mongoDB = client.db('nexo');
        useMongo = true;
        console.log('  MongoDB: Conectado (cuentas persistentes)');
      })
      .catch(function(e) {
        console.log('  MongoDB: Error - usando archivo local (' + e.message + ')');
      });
  } catch(e) {
    console.log('  MongoDB: No instalado - usando archivo local');
  }
}

// ─── DB HELPERS (funciona con MongoDB O archivo) ───
var DB_FILE = path.join(__dirname, 'users.json');

function getUsers(cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').find({}).toArray(function(err, docs) {
      if (err) return cb({});
      var users = {};
      docs.forEach(function(d) { users[d.email] = d; });
      cb(users);
    });
  } else {
    try { cb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
    catch(e) { cb({}); }
  }
}

function getUser(email, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').findOne({ email: email }, function(err, doc) {
      cb(err ? null : doc);
    });
  } else {
    try {
      var users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      cb(users[email] || null);
    } catch(e) { cb(null); }
  }
}

function saveUser(email, userData, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').updateOne(
      { email: email },
      { $set: userData },
      { upsert: true },
      function(err) { cb(err ? false : true); }
    );
  } else {
    try {
      var users = {};
      try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
      users[email] = userData;
      fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
      cb(true);
    } catch(e) { cb(false); }
  }
}

// ─── AUTH middleware ───
function auth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Inicia sesion para continuar.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Sesion expirada. Inicia sesion de nuevo.' });
  }
}

// ─── AUTH ROUTES ───
app.post('/auth/register', function(req, res) {
  var b = req.body || {};
  var nombre = (b.nombre || '').trim();
  var email  = (b.email  || '').trim().toLowerCase();
  var pw     = b.password || '';

  if (!nombre || !email || !pw)
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  if (pw.length < 6)
    return res.status(400).json({ error: 'La contrasena debe tener minimo 6 caracteres.' });
  if (!email.includes('@') || !email.includes('.'))
    return res.status(400).json({ error: 'Email invalido.' });

  getUser(email, function(existing) {
    if (existing)
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email. Inicia sesion.' });

    bcrypt.hash(pw, 10, function(err, hash) {
      if (err) return res.status(500).json({ error: 'Error al procesar. Intenta de nuevo.' });

      var userData = {
        id: 'u' + Date.now(),
        nombre: nombre,
        email: email,
        password: hash,
        creado: new Date().toISOString()
      };

      saveUser(email, userData, function(ok) {
        if (!ok) return res.status(500).json({ error: 'Error al guardar. Intenta de nuevo.' });
        var token = jwt.sign({ id: userData.id, nombre: nombre, email: email }, SECRET, { expiresIn: '30d' });
        res.json({ token: token, nombre: nombre, email: email });
      });
    });
  });
});

app.post('/auth/login', function(req, res) {
  var b = req.body || {};
  var email = (b.email    || '').trim().toLowerCase();
  var pw    = b.password  || '';

  if (!email || !pw)
    return res.status(400).json({ error: 'Email y contrasena requeridos.' });

  getUser(email, function(user) {
    if (!user)
      return res.status(401).json({ error: 'No existe cuenta con ese email.' });

    bcrypt.compare(pw, user.password, function(err, ok) {
      if (!ok)
        return res.status(401).json({ error: 'Contrasena incorrecta.' });

      var token = jwt.sign({ id: user.id, nombre: user.nombre, email: email }, SECRET, { expiresIn: '30d' });
      res.json({ token: token, nombre: user.nombre, email: email });
    });
  });
});

app.get('/auth/me', auth, function(req, res) {
  res.json({ nombre: req.user.nombre, email: req.user.email });
});

// ─── AI PROMPTS ───
var ESTILOS = {
  sabio:    'Eres sabio y reflexivo. Usas analogias cuando ayuda. Para temas filosoficos profundizas; para preguntas simples vas directo.',
  saber:    'Eres preciso y factual. Citas datos reales o estimaciones realistas. Organizas bien la informacion.',
  codigo:   'Eres tecnico y directo. Para matematicas das el resultado correcto. Para codigo das fragmentos limpios y funcionales.',
  creativo: 'Eres imaginativo y expresivo. Escribes con metaforas, color y emocion.'
};

function buildPrompt(agentId) {
  var estilo = ESTILOS[agentId] || ESTILOS.sabio;
  return (
    'Eres un asistente de IA llamado IA-NEXO. ' + estilo + '\n\n' +
    'REGLAS:\n' +
    '- Responde SIEMPRE en espanol\n' +
    '- Responde CUALQUIER pregunta\n' +
    '- NUNCA digas "no puedo" o "no tengo acceso"\n' +
    '- NUNCA empieces con "Claro!", "Por supuesto!"\n' +
    '- Para matematicas: resultado exacto y correcto\n' +
    '- Para codigo: fragmento limpio que funcione\n' +
    '- Se natural, como un amigo muy inteligente'
  );
}

// ─── GEMINI ENGINE ───
function llamarGemini(history, text, agentId, fileData, cb) {
  var key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_'))
    return cb(new Error('Falta configurar GEMINI_KEY en las variables de Railway.'));

  var prompt = buildPrompt(agentId);
  var hist = (history || []).slice(-10).map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });

  var parts = [];
  if (fileData && fileData.data) {
    var isTextFile = fileData.mimeType && (fileData.mimeType.startsWith('text/') || fileData.mimeType === 'application/json');
    if (isTextFile && fileData.textContent) {
      parts.push({ text: (text || 'Analiza este archivo.') + '\n\nArchivo "' + fileData.fileName + '":\n' + fileData.textContent.slice(0, 8000) });
    } else {
      parts.push({ text: text || 'Analiza este archivo.' });
      parts.push({ inlineData: { mimeType: fileData.mimeType, data: fileData.data } });
    }
  } else {
    parts.push({ text: text });
  }
  hist.push({ role: 'user', parts: parts });

  var modelos = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
  var idx = 0;

  function next() {
    if (idx >= modelos.length) return cb(new Error('No pude conectar con la IA. Intenta en unos segundos.'));
    var modelo = modelos[idx++];
    fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents: hist,
        generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
      })
    })
    .then(function(r) { return r.text(); })
    .then(function(raw) {
      var json;
      try { json = JSON.parse(raw); } catch(e) { return next(); }
      if (json.error) return next();
      var reply = json.candidates && json.candidates[0] && json.candidates[0].content
        && json.candidates[0].content.parts && json.candidates[0].content.parts[0]
        && json.candidates[0].content.parts[0].text;
      if (!reply) return next();
      cb(null, reply.trim());
    })
    .catch(function() { next(); });
  }
  next();
}

// ─── AGENT ROUTES ───
['sabio', 'saber', 'codigo', 'creativo'].forEach(function(agente) {
  app.post('/api/' + agente, auth, function(req, res) {
    llamarGemini(req.body.history || [], req.body.text || '', agente, req.body.file || null,
      function(err, reply) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ reply: reply });
      }
    );
  });
});

app.post('/api/imagen', auth, function(req, res) {
  var prompt = (req.body.prompt || '').slice(0, 400);
  if (!prompt) return res.status(400).json({ error: 'Describe la imagen.' });
  res.json({ imageUrl: 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=768&height=768&seed=' + Math.floor(Math.random()*999999) + '&nologo=true' });
});

app.get('/landing', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'landing.html')); });
app.get('*',       function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, function() {
  var ok = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  IA-NEXO v9.1');
  console.log('  Puerto : ' + PORT);
  console.log('  Gemini : ' + (ok ? 'OK' : 'Falta GEMINI_KEY'));
  console.log('  DB     : ' + (process.env.MONGO_URI ? 'MongoDB (configurando...)' : 'Archivo local (usuarios.json)'));
  console.log('');
});
