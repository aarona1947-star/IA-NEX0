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

// ─── DATABASE ───
var useMongo = false;
var mongoDB  = null;
var DB_FILE  = path.join(__dirname, 'users.json');

if (process.env.MONGO_URI) {
  try {
    var mongodb    = require('mongodb');
    var MongoClient = mongodb.MongoClient;
    MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
      .then(function(client) {
        mongoDB  = client.db('nexo');
        useMongo = true;
        console.log('  MongoDB: Conectado');
        // Create indexes
        mongoDB.collection('users').createIndex({ email: 1 }, { unique: true }).catch(function(){});
        mongoDB.collection('usage').createIndex({ email: 1, date: 1 }).catch(function(){});
      })
      .catch(function(e) { console.log('  MongoDB error:', e.message); });
  } catch(e) { console.log('  MongoDB no instalado'); }
}

// ─── DB HELPERS ───
function getUser(email, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').findOne({ email: email }, cb);
  } else {
    try {
      var users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      cb(null, users[email] || null);
    } catch(e) { cb(null, null); }
  }
}

function saveUser(email, data, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').updateOne({ email: email }, { $set: data }, { upsert: true }, cb);
  } else {
    try {
      var users = {};
      try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
      users[email] = Object.assign(users[email] || {}, data);
      fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
      cb(null);
    } catch(e) { cb(e); }
  }
}

// ─── USAGE TRACKING ───
function getTodayUsage(email, cb) {
  var today = new Date().toISOString().slice(0, 10);
  if (useMongo && mongoDB) {
    mongoDB.collection('usage').findOne({ email: email, date: today }, function(err, doc) {
      cb(doc ? doc.count : 0);
    });
  } else {
    try {
      var usage = JSON.parse(fs.readFileSync(path.join(__dirname, 'usage.json'), 'utf8'));
      var key = email + '_' + today;
      cb(usage[key] || 0);
    } catch(e) { cb(0); }
  }
}

function incrementUsage(email, cb) {
  var today = new Date().toISOString().slice(0, 10);
  if (useMongo && mongoDB) {
    mongoDB.collection('usage').updateOne(
      { email: email, date: today },
      { $inc: { count: 1 } },
      { upsert: true },
      function() { if (cb) cb(); }
    );
  } else {
    try {
      var usageFile = path.join(__dirname, 'usage.json');
      var usage = {};
      try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch(e) {}
      var key = email + '_' + today;
      usage[key] = (usage[key] || 0) + 1;
      fs.writeFileSync(usageFile, JSON.stringify(usage));
    } catch(e) {}
    if (cb) cb();
  }
}

// ─── REFERRAL SYSTEM ───
function genRefCode(nombre) {
  var base = (nombre || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return base + Math.random().toString(36).slice(2, 6);
}

// ─── AUTH MIDDLEWARE ───
function auth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Inicia sesion para continuar.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Sesion expirada.' });
  }
}

// Check plan and usage
function checkPlan(req, res, next) {
  getUser(req.user.email, function(err, user) {
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado.' });
    var now = new Date();
    var isPro = user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > now;
    var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
    req.isPro = isPro || isTrial;
    req.user.plan = isPro ? 'pro' : (isTrial ? 'trial' : 'free');
    if (req.isPro) return next();
    // Free plan: check daily limit
    getTodayUsage(req.user.email, function(count) {
      var FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '25');
      if (count >= FREE_LIMIT) {
        return res.status(429).json({
          error: 'Llegaste al limite de ' + FREE_LIMIT + ' mensajes hoy.',
          limitReached: true,
          plan: 'free',
          count: count,
          limit: FREE_LIMIT
        });
      }
      req.msgCount = count;
      next();
    });
  });
}

// ─── REGISTER ───
app.post('/auth/register', function(req, res) {
  var b = req.body || {};
  var nombre = (b.nombre || '').trim();
  var email  = (b.email  || '').trim().toLowerCase();
  var pw     = b.password || '';
  var refCode = (b.refCode || '').trim().toLowerCase();

  if (!nombre || !email || !pw)
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  if (pw.length < 6)
    return res.status(400).json({ error: 'La contrasena debe tener minimo 6 caracteres.' });
  if (!email.includes('@') || !email.includes('.'))
    return res.status(400).json({ error: 'Email invalido.' });

  getUser(email, function(err, existing) {
    if (existing) return res.status(400).json({ error: 'Ya existe una cuenta con ese email.' });

    bcrypt.hash(pw, 10, function(err, hash) {
      if (err) return res.status(500).json({ error: 'Error al procesar. Intenta de nuevo.' });

      // 7-day free trial for all new users
      var trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      var myRefCode   = genRefCode(nombre);

      var userData = {
        id: 'u' + Date.now(),
        nombre: nombre,
        email: email,
        password: hash,
        plan: 'free',
        planExpiry: null,
        trialExpiry: trialExpiry.toISOString(),
        refCode: myRefCode,
        refCount: 0,
        creado: new Date().toISOString()
      };

      saveUser(email, userData, function(saveErr) {
        if (saveErr) return res.status(500).json({ error: 'Error al guardar. Intenta de nuevo.' });
        // WhatsApp notification to admin
        var waBotKey = process.env.WA_BOT_KEY || '';
        if (waBotKey) {
          var waMsg = encodeURIComponent('IA-NEXO Nuevo usuario: ' + nombre + ' (' + email + ')');
          fetch('https://api.callmebot.com/whatsapp.php?phone=584243602967&text=' + waMsg + '&apikey=' + waBotKey).catch(function(){});
        }
        console.log('[NUEVO USUARIO] ' + nombre + ' <' + email + '>');

        // Process referral - give referrer 7 extra days
        if (refCode) {
          if (useMongo && mongoDB) {
            mongoDB.collection('users').findOne({ refCode: refCode }, function(err, referrer) {
              if (referrer && referrer.email !== email) {
                var bonus = new Date(Math.max(Date.now(), new Date(referrer.planExpiry || Date.now()).getTime()) + 7 * 24 * 60 * 60 * 1000);
                mongoDB.collection('users').updateOne(
                  { refCode: refCode },
                  { $set: { plan: 'pro', planExpiry: bonus.toISOString() }, $inc: { refCount: 1 } },
                  function() {}
                );
              }
            });
          }
        }

        var token = jwt.sign({ id: userData.id, nombre: nombre, email: email }, SECRET, { expiresIn: '30d' });
        res.json({
          token: token,
          nombre: nombre,
          email: email,
          plan: 'trial',
          trialDays: 7,
          refCode: myRefCode
        });
      });
    });
  });
});

// ─── LOGIN ───
app.post('/auth/login', function(req, res) {
  var b = req.body || {};
  var email = (b.email    || '').trim().toLowerCase();
  var pw    = b.password  || '';

  if (!email || !pw) return res.status(400).json({ error: 'Email y contrasena requeridos.' });

  getUser(email, function(err, user) {
    if (!user) return res.status(401).json({ error: 'No existe cuenta con ese email.' });

    bcrypt.compare(pw, user.password, function(err, ok) {
      if (!ok) return res.status(401).json({ error: 'Contrasena incorrecta.' });

      var now = new Date();
      var isPro   = user.plan === 'pro'   && user.planExpiry  && new Date(user.planExpiry)  > now;
      var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
      var planLabel = isPro ? 'pro' : (isTrial ? 'trial' : 'free');

      var token = jwt.sign({ id: user.id, nombre: user.nombre, email: email }, SECRET, { expiresIn: '30d' });
      res.json({
        token: token,
        nombre: user.nombre,
        email: email,
        plan: planLabel,
        refCode: user.refCode || '',
        planExpiry: user.planExpiry || null,
        trialExpiry: user.trialExpiry || null
      });
    });
  });
});

// ─── ME ───
app.get('/auth/me', auth, function(req, res) {
  getUser(req.user.email, function(err, user) {
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    var now = new Date();
    var isPro   = user.plan === 'pro'   && user.planExpiry  && new Date(user.planExpiry)  > now;
    var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
    getTodayUsage(req.user.email, function(count) {
      res.json({
        nombre: user.nombre,
        email: user.email,
        plan: isPro ? 'pro' : (isTrial ? 'trial' : 'free'),
        planExpiry: user.planExpiry || null,
        trialExpiry: user.trialExpiry || null,
        refCode: user.refCode || '',
        refCount: user.refCount || 0,
        todayMsgs: count,
        freeLimit: parseInt(process.env.FREE_LIMIT || '25')
      });
    });
  });
});

// ─── ADMIN: Activate Pro ───
app.post('/admin/activate', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });

  var email = (req.body.email || '').trim().toLowerCase();
  var days  = parseInt(req.body.days || '30');
  if (!email) return res.status(400).json({ error: 'Email requerido.' });

  getUser(email, function(err, user) {
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    var base = (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > new Date())
      ? new Date(user.planExpiry) : new Date();
    var expiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    saveUser(email, { plan: 'pro', planExpiry: expiry.toISOString() }, function() {
      res.json({ ok: true, email: email, plan: 'pro', expiresAt: expiry.toISOString(), days: days });
    });
  });
});

// ─── ADMIN: List users ───
app.get('/admin/users', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });

  if (useMongo && mongoDB) {
    mongoDB.collection('users').find({}, { projection: { password: 0 } }).toArray(function(err, users) {
      var now = new Date();
      var result = (users || []).map(function(u) {
        return {
          nombre: u.nombre, email: u.email,
          plan: u.plan === 'pro' && u.planExpiry && new Date(u.planExpiry) > now ? 'pro' : 'free',
          planExpiry: u.planExpiry, trialExpiry: u.trialExpiry,
          refCode: u.refCode, refCount: u.refCount || 0, creado: u.creado
        };
      });
      res.json({ total: result.length, users: result });
    });
  } else {
    try {
      var users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      var result = Object.values(users).map(function(u) {
        return { nombre: u.nombre, email: u.email, plan: u.plan, creado: u.creado };
      });
      res.json({ total: result.length, users: result });
    } catch(e) { res.json({ total: 0, users: [] }); }
  }
});

// ─── USAGE STATS ───
app.get('/auth/usage', auth, function(req, res) {
  getTodayUsage(req.user.email, function(count) {
    res.json({ today: count, limit: parseInt(process.env.FREE_LIMIT || '25') });
  });
});

// ─── AI AGENT CONFIGS ───
var AGENTES = {

  general: {
    temperature: 0.7,
    maxTokens: 3000,
    prompt: `Eres NEXO GENERAL — el asistente de IA más útil, claro y completo disponible en español.

IDENTIDAD: Eres como tener acceso a un amigo que sabe de todo: tecnología, cultura, historia, ciencia, negocios, arte, matemáticas, idiomas, consejos de vida. Siempre tienes una respuesta útil y bien explicada.

LO QUE PUEDES HACER:
• Responder preguntas de cualquier tema con claridad
• Ayudar a redactar textos, emails, mensajes
• Explicar conceptos complejos de forma sencilla
• Dar consejos prácticos sobre situaciones cotidianas
• Ayudar con tareas, estudios, trabajo
• Traducir, resumir, corregir textos
• Dar ideas creativas, hacer listas, planificar

CÓMO RESPONDES:
- Directo al punto desde la primera oración
- Usa ejemplos concretos cuando el tema es complejo
- Para preguntas simples: respuesta corta y clara
- Para preguntas complejas: estructura con puntos o párrafos cortos
- Siempre en un tono amigable, nunca robótico

NOTA SOBRE LOS AGENTES PRO: Si el usuario pregunta algo muy especializado (filosofía profunda, código avanzado, datos precisos, contenido muy creativo), puedes mencionarle que con el Plan Pro tiene acceso a agentes especializados en esa área exacta.`
  },

  sabio: {
    temperature: 0.82,
    maxTokens: 3500,
    prompt: `Eres NEXO SABIO — el consejero de vida más profundo y sabio que existe.

IDENTIDAD: Tienes el conocimiento combinado de Marco Aurelio, Carl Jung, Sócrates, Epicteto, Viktor Frankl, Brené Brown y los mejores psicólogos cognitivos modernos. Pero hablas como un amigo cercano muy inteligente, nunca como un libro de texto.

TU ESPECIALIDAD:
• Filosofía práctica y estoicismo aplicado a la vida real
• Psicología: traumas, relaciones, autoestima, ansiedad, propósito
• Toma de decisiones difíciles bajo presión o incertidumbre
• Crecimiento personal: hábitos, disciplina, motivación real (no motivación basura)
• Relaciones: pareja, familia, amistades, conflictos, comunicación
• Preguntas existenciales: el sentido de la vida, la muerte, el sufrimiento
• Dilemas éticos y morales complejos

CÓMO RESPONDES (muy importante):
1. PRIMERO validas lo que siente el usuario. Una oración cálida y real.
2. LUEGO ofreces una perspectiva que cambia cómo ve el problema — algo que NO encontraría en Google.
3. Usas UNA historia, analogía o ejemplo concreto de la historia/psicología que haga "clic".
4. Terminas con 1-2 preguntas que inviten a la reflexión profunda, o pasos concretos accionables.
5. Para preguntas simples de filosofía/cultura: respuesta directa, brillante, sin rodeos.

VOZ: Cálido pero honesto. Profundo pero accesible. Sabio pero humano. Nunca condescendiente.
NUNCA des respuestas de "coach de Instagram". Da sabiduría real que duela un poco y cure mucho.`
  },

  saber: {
    temperature: 0.25,
    maxTokens: 4096,
    prompt: `Eres NEXO DATOS — el analista de información más preciso, riguroso y completo del mundo.

IDENTIDAD: Eres una combinación de periodista investigativo de The Economist, analista de la CIA, y enciclopedia viviente. Tu superpoder es transformar datos complejos en información clara y accionable.

TU ESPECIALIDAD:
• Datos, estadísticas y cifras exactas (países, población, economía, ciencia)
• Historia: fechas, eventos, causas, consecuencias, contexto
• Geografía, política internacional, geopolítica
• Ciencia: biología, física, química, medicina, tecnología
• Economía: indicadores, mercados, tendencias, comparaciones
• Rankings y comparaciones objetivas con datos reales
• Cultura general, récords, curiosidades verificables

CÓMO RESPONDES (estructura obligatoria según el tipo):
• Para DATOS/ESTADÍSTICAS: Contexto (1 oración) → Dato principal en negrita → Datos de apoyo → Fuente o período de referencia
• Para COMPARACIONES: Tabla o lista estructurada con criterios claros
• Para HISTORIA: Cronología clara → causa → desarrollo → consecuencia → impacto hoy
• Para CIENCIA: Definición precisa → mecanismo → ejemplo real → aplicación práctica
• Para preguntas simples: Respuesta directa con el dato exacto en la primera línea

REGLAS DE ORO:
• Siempre indica si un dato es estimado, proyectado o exacto
• Si hay controversia o múltiples fuentes, presentas TODAS las perspectivas
• Usas números específicos: nunca "varios millones" sino "3.2 millones"
• Para tablas usa formato markdown: | columna | columna |
• Nunca inventas datos. Si no estás seguro de un dato exacto, lo indicas claramente.`
  },

  codigo: {
    temperature: 0.18,
    maxTokens: 4096,
    prompt: `Eres NEXO LÓGICO — el ingeniero de software senior más experto y práctico del mundo.

IDENTIDAD: 20 años resolviendo problemas reales de código. Has trabajado en Google, escribes libros técnicos y enseñas en MIT. Pero tu estilo es directo, sin jerga innecesaria. Cada respuesta tuya es código que FUNCIONA.

TU ESPECIALIDAD:
• Python (ciencia de datos, automatización, scripts, Django, Flask)
• JavaScript / TypeScript (frontend, Node.js, React, APIs REST)
• HTML / CSS (layouts, responsive, animaciones, Tailwind)
• SQL (consultas complejas, optimización, bases de datos)
• Algoritmos y estructuras de datos
• Debugging: encuentras el error exacto y explicas por qué ocurrió
• Matemáticas: álgebra, estadística, cálculo, matrices
• Excel / Hojas de cálculo: fórmulas avanzadas, VLOOKUP, tablas dinámicas
• Arquitectura de software: patrones de diseño, mejores prácticas
• Terminal / Bash / Git

CÓMO RESPONDES (obligatorio):
1. Si piden código → código COMPLETO y LISTO PARA USAR, nada de "..." o "resto del código"
2. Comentarios en español explicando cada sección importante
3. Para errores: primero dices cuál es el bug exacto en UNA oración, luego el código corregido
4. Para matemáticas: procedimiento paso a paso con el resultado final en negrita
5. Si hay varias formas de resolver: haces la mejor directamente y mencionas brevemente la alternativa
6. Al final de cada código: 1-2 líneas de cómo ejecutarlo o probarlo

FORMATO DE CÓDIGO: Siempre en bloques de código con el lenguaje especificado:
\`\`\`python
# código aquí
\`\`\`

NUNCA des código incompleto. NUNCA uses frases como "aquí debes completar". El código siempre funciona tal cual.`
  },

  creativo: {
    temperature: 0.95,
    maxTokens: 2500,
    prompt: `Eres NEXO CREATIVO — el director creativo más talentoso y versátil del mundo hispanohablante.

IDENTIDAD: Mezclas el ingenio de un copywriter de Cannes, la imaginación de García Márquez, la visión de diseño de Dieter Rams y la estrategia de un CMO de Silicon Valley. Tu trabajo nunca es mediocre — siempre sorprende, siempre tiene alma.

TU ESPECIALIDAD:
• Escritura creativa: cuentos, poemas, canciones, guiones, cartas, discursos
• Estrategia de marca: nombres, slogans, identidad, posicionamiento
• Contenido para redes: posts virales, guiones de Reels/TikTok, descripciones
• Ideas de negocio: concepto + nombre + propuesta de valor única
• Marketing y publicidad: campañas, anuncios, emails, landings
• Poesía: libre, rimada, haiku, soneto, lo que pidan
• Letras de canciones con ritmo y emoción real
• Planes de eventos, experiencias, celebraciones
• Recetas y gastronomía creativa
• Humor, entretenimiento, juegos de palabras

CÓMO RESPONDES:
1. SIEMPRE entregas el resultado directamente — no describes lo que vas a hacer, HAZLO
2. Tu primer párrafo/verso/oración siempre engancha y tiene carácter propio
3. Para marcas/negocios: das NOMBRE + SLOGAN + concepto en 2 líneas
4. Para escritura: tienes voz propia, usas metáforas inesperadas, rompes lo predecible
5. Cuando aplica, ofreces 2 versiones: formal/casual, seria/divertida, etc.
6. Para canciones/poemas: el ritmo se SIENTE al leerlo en voz alta

VOZ: Apasionada, original, con personalidad. Nunca genérica. Nunca "aquí tienes un poema sobre...". Solo el poema. Directo.`
  }
};

// Smart image keywords for CREATIVO
var IMAGE_KEYWORDS = [
  'genera una imagen', 'genera imagen', 'crea una imagen', 'crea imagen',
  'dibuja', 'diseña una imagen', 'diseña el logo', 'crea el logo', 'hazme un logo',
  'ilustra', 'ilustración de', 'imagen de', 'foto de', 'retrato de',
  'pinta', 'visualiza', 'muéstrame una imagen', 'quiero ver',
  'make an image', 'draw', 'create an image', 'generate image'
];

function isImageRequest(text) {
  var t = (text || '').toLowerCase();
  return IMAGE_KEYWORDS.some(function(kw) { return t.indexOf(kw) >= 0; });
}

function buildPrompt(agentId) {
  var cfg = AGENTES[agentId] || AGENTES.sabio;
  return cfg.prompt + '\n\n' +
    'REGLAS ABSOLUTAS:\n' +
    '- Responde SIEMPRE en español, sin excepción\n' +
    '- NUNCA digas "no puedo", "como modelo de lenguaje", "no tengo opinión" — simplemente responde con profundidad\n' +
    '- NUNCA menciones que eres una IA a menos que te lo pregunten directamente\n' +
    '- Sé directo: la respuesta real en las primeras líneas, sin rodeos ni disclaimers\n' +
    '- Si la pregunta es simple, responde en 2-3 oraciones brillantes. Si es compleja, despliega toda tu profundidad.';
}

function getAgentConfig(agentId) {
  return AGENTES[agentId] || AGENTES.sabio;
}

function llamarGemini(history, text, agentId, fileData, cb) {
  var key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_'))
    return cb(new Error('Falta configurar GEMINI_KEY.'));

  var cfg = getAgentConfig(agentId);

  var hist = (history || []).slice(-12).map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });

  var parts = [];
  if (fileData && fileData.data) {
    var isText = fileData.mimeType && fileData.mimeType.startsWith('text/');
    if (isText && fileData.textContent) {
      parts.push({ text: (text || 'Analiza.') + '\nArchivo "' + fileData.fileName + '":\n' + fileData.textContent.slice(0, 8000) });
    } else {
      parts.push({ text: text || 'Analiza.' });
      parts.push({ inlineData: { mimeType: fileData.mimeType, data: fileData.data } });
    }
  } else {
    parts.push({ text: text });
  }
  hist.push({ role: 'user', parts: parts });

  var modelos = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
  var idx = 0;
  function next() {
    if (idx >= modelos.length) return cb(new Error('No pude conectar. Intenta en unos segundos.'));
    var modelo = modelos[idx++];
    fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildPrompt(agentId) }] },
        contents: hist,
        generationConfig: {
          maxOutputTokens: cfg.maxTokens,
          temperature: cfg.temperature
        }
      })
    })
    .then(function(r) { return r.text(); })
    .then(function(raw) {
      var json; try { json = JSON.parse(raw); } catch(e) { return next(); }
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
// General (free) + Sabio, Datos, Lógico — standard Gemini
['general', 'sabio', 'saber', 'codigo'].forEach(function(agente) {
  app.post('/api/' + agente, auth, checkPlan, function(req, res) {
    llamarGemini(req.body.history || [], req.body.text || '', agente, req.body.file || null,
      function(err, reply) {
        if (err) return res.status(500).json({ error: err.message });
        if (!req.isPro) incrementUsage(req.user.email);
        res.json({
          reply: reply,
          plan: req.user.plan,
          todayMsgs: (req.msgCount || 0) + 1,
          freeLimit: parseInt(process.env.FREE_LIMIT || '25')
        });
      }
    );
  });
});

// Creativo — Gemini + smart image detection via Pollinations
app.post('/api/creativo', auth, checkPlan, function(req, res) {
  var text = req.body.text || '';

  // If user is asking for an image, generate it automatically
  if (isImageRequest(text)) {
    var seed = Math.floor(Math.random() * 999999);
    // Enhance prompt for better image quality
    var imgPrompt = text + ', high quality, detailed, professional, 4k';
    var imageUrl = 'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(imgPrompt) +
      '?width=768&height=768&seed=' + seed + '&nologo=true&enhance=true';
    if (!req.isPro) incrementUsage(req.user.email);
    return res.json({
      reply: '🎨 ¡Aquí está tu imagen! La generé con IA a partir de tu descripción.\n\n_Tip: Si quieres otra versión, pídela de nuevo o agrega más detalles._',
      imageUrl: imageUrl,
      plan: req.user.plan,
      todayMsgs: (req.msgCount || 0) + 1,
      freeLimit: parseInt(process.env.FREE_LIMIT || '25')
    });
  }

  // Otherwise respond creatively with Gemini
  llamarGemini(req.body.history || [], text, 'creativo', req.body.file || null,
    function(err, reply) {
      if (err) return res.status(500).json({ error: err.message });
      if (!req.isPro) incrementUsage(req.user.email);
      res.json({
        reply: reply,
        plan: req.user.plan,
        todayMsgs: (req.msgCount || 0) + 1,
        freeLimit: parseInt(process.env.FREE_LIMIT || '25')
      });
    }
  );
});

app.post('/api/imagen', auth, function(req, res) {
  var prompt = (req.body.prompt || '').slice(0, 400);
  if (!prompt) return res.status(400).json({ error: 'Describe la imagen.' });
  res.json({ imageUrl: 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=768&height=768&seed=' + Math.floor(Math.random()*999999) + '&nologo=true' });
});


// ─── CONVERSATIONS (cloud storage) ───
app.get('/api/conversations', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ conversations: [] });
  mongoDB.collection('conversations')
    .find({ userId: req.user.id })
    .sort({ updatedAt: -1 })
    .limit(20)
    .toArray(function(err, docs) {
      res.json({ conversations: docs || [] });
    });
});

app.post('/api/conversations', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ ok: false });
  var conv = req.body;
  if (!conv.id) return res.status(400).json({ error: 'ID requerido.' });
  mongoDB.collection('conversations').updateOne(
    { id: conv.id, userId: req.user.id },
    { $set: {
        id: conv.id,
        userId: req.user.id,
        title: (conv.title || 'Conversacion').slice(0, 60),
        hist: (conv.hist || []).slice(-30),
        agent: conv.agent || 'sabio',
        updatedAt: new Date().toISOString()
      }
    },
    { upsert: true },
    function(err) { res.json({ ok: !err }); }
  );
});

app.delete('/api/conversations/:id', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ ok: false });
  mongoDB.collection('conversations').deleteOne(
    { id: req.params.id, userId: req.user.id },
    function(err) { res.json({ ok: !err }); }
  );
});

// ─── DISCOUNT CODES ───
app.post('/admin/codes', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });
  if (!useMongo || !mongoDB) return res.status(503).json({ error: 'MongoDB requerido.' });
  var code = (req.body.code || '').toUpperCase().trim();
  var days = parseInt(req.body.days || '30');
  var maxUses = parseInt(req.body.maxUses || '100');
  if (!code) return res.status(400).json({ error: 'Codigo requerido.' });
  mongoDB.collection('codes').updateOne(
    { code: code },
    { $set: { code, days, maxUses, uses: 0, active: true, createdAt: new Date().toISOString() } },
    { upsert: true },
    function(err) { res.json({ ok: !err, code, days, maxUses }); }
  );
});

app.post('/auth/applyCode', auth, function(req, res) {
  var code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Ingresa un codigo.' });
  if (!useMongo || !mongoDB) return res.status(503).json({ error: 'Servicio no disponible.' });
  mongoDB.collection('codes').findOne({ code: code, active: true }, function(err, doc) {
    if (!doc) return res.status(404).json({ error: 'Codigo invalido o expirado.' });
    if (doc.uses >= doc.maxUses) return res.status(400).json({ error: 'Codigo agotado.' });
    // Apply to user
    getUser(req.user.email, function(err2, user) {
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
      var base = (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > new Date())
        ? new Date(user.planExpiry) : new Date();
      var expiry = new Date(base.getTime() + doc.days * 24 * 60 * 60 * 1000);
      saveUser(req.user.email, { plan: 'pro', planExpiry: expiry.toISOString() }, function() {
        mongoDB.collection('codes').updateOne({ code }, { $inc: { uses: 1 } }, function() {});
        res.json({ ok: true, days: doc.days, expiresAt: expiry.toISOString() });
      });
    });
  });
});

app.get('/admin/codes', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });
  if (!useMongo || !mongoDB) return res.json({ codes: [] });
  mongoDB.collection('codes').find({}).toArray(function(err, docs) {
    res.json({ codes: docs || [] });
  });
});

// ─── ADMIN STATS ───
app.get('/admin/stats', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });
  if (!useMongo || !mongoDB) return res.json({ totalMsgs: 0, todayMsgs: 0, activeUsers: 0 });
  var today = new Date().toISOString().slice(0, 10);
  var promises = [
    new Promise(function(r) { mongoDB.collection('usage').aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }]).toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); }); }),
    new Promise(function(r) { mongoDB.collection('usage').aggregate([{ $match: { date: today } }, { $group: { _id: null, total: { $sum: '$count' } } }]).toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); }); }),
    new Promise(function(r) { mongoDB.collection('users').countDocuments({}, function(e, n) { r(n || 0); }); }),
    new Promise(function(r) { mongoDB.collection('usage').distinct('email', { date: today }, function(e, d) { r(d ? d.length : 0); }); })
  ];
  Promise.all(promises).then(function(results) {
    res.json({ totalMsgs: results[0], todayMsgs: results[1], totalUsers: results[2], todayActiveUsers: results[3] });
  }).catch(function() { res.json({ totalMsgs: 0, todayMsgs: 0, totalUsers: 0, todayActiveUsers: 0 }); });
});

// ─── ROUTES ───
app.get('/landing', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'landing.html')); });
app.get('/admin',   function(req, res) { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('*',        function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, function() {
  var ok = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  IA-NEXO v12');
  console.log('  Puerto : ' + PORT);
  console.log('  Gemini : ' + (ok ? 'OK' : 'FALTA GEMINI_KEY'));
  console.log('  DB     : ' + (process.env.MONGO_URI ? 'MongoDB' : 'Archivo local'));
  console.log('  Admin  : /admin (key: ' + (process.env.ADMIN_KEY || 'nexo-admin-2025') + ')');
  console.log('');
});

// ─── CLOUD CONVERSATIONS ───
app.post('/chats/save', auth, function(req, res) {
  var chat = req.body.chat;
  if (!chat || !chat.id) return res.status(400).json({ error: 'Chat invalido.' });
  chat.email = req.user.email;
  chat.updatedAt = new Date().toISOString();
  if (useMongo && mongoDB) {
    mongoDB.collection('chats').updateOne(
      { id: chat.id, email: req.user.email },
      { $set: chat },
      { upsert: true },
      function(err) { res.json({ ok: !err }); }
    );
  } else {
    res.json({ ok: true }); // fallback: client stores locally
  }
});

app.get('/chats/list', auth, function(req, res) {
  if (useMongo && mongoDB) {
    mongoDB.collection('chats')
      .find({ email: req.user.email }, { projection: { _id: 0, password: 0 } })
      .sort({ updatedAt: -1 }).limit(20).toArray(function(err, docs) {
        res.json({ chats: docs || [] });
      });
  } else {
    res.json({ chats: [] });
  }
});

app.delete('/chats/:id', auth, function(req, res) {
  if (useMongo && mongoDB) {
    mongoDB.collection('chats').deleteOne({ id: req.params.id, email: req.user.email },
      function(err) { res.json({ ok: !err }); });
  } else { res.json({ ok: true }); }
});

// ─── DISCOUNT CODES ───
app.post('/admin/discount/create', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });
  var code = {
    code: (req.body.code || '').toUpperCase().trim(),
    pct: parseInt(req.body.pct || '50'),
    days: parseInt(req.body.days || '30'),
    maxUses: parseInt(req.body.maxUses || '100'),
    uses: 0,
    active: true,
    creado: new Date().toISOString()
  };
  if (!code.code) return res.status(400).json({ error: 'Codigo requerido.' });
  if (useMongo && mongoDB) {
    mongoDB.collection('discounts').updateOne({ code: code.code }, { $set: code }, { upsert: true },
      function() { res.json({ ok: true, code: code }); });
  } else { res.json({ ok: true, code: code }); }
});

app.post('/discount/apply', auth, function(req, res) {
  var code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Ingresa un codigo.' });
  if (useMongo && mongoDB) {
    mongoDB.collection('discounts').findOne({ code: code, active: true }, function(err, dc) {
      if (!dc) return res.status(404).json({ error: 'Codigo invalido o expirado.' });
      if (dc.uses >= dc.maxUses) return res.status(400).json({ error: 'Codigo agotado.' });
      getUser(req.user.email, function(err2, user) {
        var base = (user && user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > new Date())
          ? new Date(user.planExpiry) : new Date();
        var daysGranted = Math.round(dc.days * (dc.pct / 100) + dc.days * (1 - dc.pct / 100));
        var expiry = new Date(base.getTime() + daysGranted * 24 * 60 * 60 * 1000);
        saveUser(req.user.email, { plan: 'pro', planExpiry: expiry.toISOString() }, function() {
          mongoDB.collection('discounts').updateOne({ code: code }, { $inc: { uses: 1 } }, function() {});
          res.json({ ok: true, daysGranted: daysGranted, expiry: expiry.toISOString(), pct: dc.pct });
        });
      });
    });
  } else {
    res.status(503).json({ error: 'Funcion no disponible sin MongoDB.' });
  }
});

// ─── ADMIN STATS ───
app.get('/admin/stats', function(req, res) {
  var adminKey = req.headers['x-admin-key'] || '';
  if (adminKey !== (process.env.ADMIN_KEY || 'nexo-admin-2025'))
    return res.status(403).json({ error: 'No autorizado.' });
  if (!useMongo || !mongoDB) return res.json({ error: 'Solo disponible con MongoDB.' });
  var now = new Date();
  var today = now.toISOString().slice(0, 10);
  var week  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Promise.all([
    mongoDB.collection('users').countDocuments(),
    mongoDB.collection('users').countDocuments({ plan: 'pro', planExpiry: { $gt: now.toISOString() } }),
    mongoDB.collection('usage').aggregate([
      { $match: { date: today } },
      { $group: { _id: null, total: { $sum: '$count' } } }
    ]).toArray(),
    mongoDB.collection('usage').aggregate([
      { $match: { date: { $gte: week } } },
      { $group: { _id: '$date', total: { $sum: '$count' } } },
      { $sort: { _id: 1 } }
    ]).toArray(),
    mongoDB.collection('users').countDocuments({
      creado: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() }
    })
  ]).then(function(results) {
    res.json({
      totalUsers:   results[0],
      proUsers:     results[1],
      msgsToday:    results[2][0] ? results[2][0].total : 0,
      weeklyMsgs:   results[3],
      newUsersWeek: results[4],
      revenue: (results[1] * 4.99).toFixed(2)
    });
  }).catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ─── NEW USER NOTIFICATION (ntfy.sh) ───
function notifyNewUser(nombre, email) {
  var channel = process.env.NTFY_CHANNEL;
  if (!channel) return;
  fetch('https://ntfy.sh/' + channel, {
    method: 'POST',
    headers: { 'Title': 'Nuevo usuario en IA-NEXO', 'Priority': 'high', 'Tags': 'tada' },
    body: nombre + ' (' + email + ') se registro ahora mismo!'
  }).catch(function() {});
}
