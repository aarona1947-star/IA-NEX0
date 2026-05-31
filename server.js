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
var ADMIN_KEY  = process.env.ADMIN_KEY || 'nexo-admin-2025';
var FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '25');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  BASE DE DATOS (MongoDB con fallback a JSON)
// ═══════════════════════════════════════════
var useMongo = false;
var mongoDB  = null;
var DB_FILE  = path.join(__dirname, 'users.json');

if (process.env.MONGO_URI) {
  try {
    var MongoClient = require('mongodb').MongoClient;
    MongoClient.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
      .then(function(client) {
        mongoDB  = client.db('nexo');
        useMongo = true;
        console.log('  MongoDB: Conectado');
        mongoDB.collection('users').createIndex({ email: 1 }, { unique: true }).catch(function(){});
        mongoDB.collection('usage').createIndex({ email: 1, date: 1 }).catch(function(){});
      })
      .catch(function(e) { console.log('  MongoDB error:', e.message); });
  } catch(e) { console.log('  MongoDB no instalado'); }
}

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

function getTodayUsage(email, cb) {
  var today = new Date().toISOString().slice(0, 10);
  if (useMongo && mongoDB) {
    mongoDB.collection('usage').findOne({ email: email, date: today }, function(err, doc) {
      cb(doc ? doc.count : 0);
    });
  } else {
    try {
      var usage = JSON.parse(fs.readFileSync(path.join(__dirname, 'usage.json'), 'utf8'));
      cb(usage[email + '_' + today] || 0);
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

function genRefCode(nombre) {
  var base = (nombre || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  return base + Math.random().toString(36).slice(2, 6);
}

// ═══════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════
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

function checkPlan(req, res, next) {
  getUser(req.user.email, function(err, user) {
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado.' });
    var now = new Date();
    var isPro = user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > now;
    var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
    req.isPro = isPro || isTrial;
    req.user.plan = isPro ? 'pro' : (isTrial ? 'trial' : 'free');
    req.userDoc = user;
    if (req.isPro) return next();
    getTodayUsage(req.user.email, function(count) {
      if (count >= FREE_LIMIT) {
        return res.status(429).json({
          error: 'Llegaste al limite de ' + FREE_LIMIT + ' mensajes hoy.',
          limitReached: true, plan: 'free', count: count, limit: FREE_LIMIT
        });
      }
      req.msgCount = count;
      next();
    });
  });
}

function adminAuth(req, res, next) {
  if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY)
    return res.status(403).json({ error: 'No autorizado.' });
  next();
}

// ═══════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════
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
      var trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      var myRefCode   = genRefCode(nombre);
      var userData = {
        id: 'u' + Date.now(), nombre: nombre, email: email, password: hash,
        plan: 'free', planExpiry: null, trialExpiry: trialExpiry.toISOString(),
        refCode: myRefCode, refCount: 0, creado: new Date().toISOString(),
        contexto: ''  // contexto personalizado del usuario/empresa
      };
      saveUser(email, userData, function(saveErr) {
        if (saveErr) return res.status(500).json({ error: 'Error al guardar. Intenta de nuevo.' });
        notifyNewUser(nombre, email);
        console.log('[NUEVO USUARIO]', nombre, '<' + email + '>');
        if (refCode && useMongo && mongoDB) {
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
        var token = jwt.sign({ id: userData.id, nombre: nombre, email: email }, SECRET, { expiresIn: '30d' });
        res.json({ token: token, nombre: nombre, email: email, plan: 'trial', trialDays: 7, refCode: myRefCode });
      });
    });
  });
});

app.post('/auth/login', function(req, res) {
  var b = req.body || {};
  var email = (b.email || '').trim().toLowerCase();
  var pw    = b.password || '';
  if (!email || !pw) return res.status(400).json({ error: 'Email y contrasena requeridos.' });
  getUser(email, function(err, user) {
    if (!user) return res.status(401).json({ error: 'No existe cuenta con ese email.' });
    bcrypt.compare(pw, user.password, function(err, ok) {
      if (!ok) return res.status(401).json({ error: 'Contrasena incorrecta.' });
      var now = new Date();
      var isPro   = user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > now;
      var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
      var planLabel = isPro ? 'pro' : (isTrial ? 'trial' : 'free');
      var token = jwt.sign({ id: user.id, nombre: user.nombre, email: email }, SECRET, { expiresIn: '30d' });
      res.json({
        token: token, nombre: user.nombre, email: email, plan: planLabel,
        refCode: user.refCode || '', planExpiry: user.planExpiry || null,
        trialExpiry: user.trialExpiry || null, contexto: user.contexto || ''
      });
    });
  });
});

app.get('/auth/me', auth, function(req, res) {
  getUser(req.user.email, function(err, user) {
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    var now = new Date();
    var isPro   = user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > now;
    var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;
    getTodayUsage(req.user.email, function(count) {
      res.json({
        nombre: user.nombre, email: user.email,
        plan: isPro ? 'pro' : (isTrial ? 'trial' : 'free'),
        planExpiry: user.planExpiry || null, trialExpiry: user.trialExpiry || null,
        refCode: user.refCode || '', refCount: user.refCount || 0,
        todayMsgs: count, freeLimit: FREE_LIMIT, contexto: user.contexto || ''
      });
    });
  });
});

app.get('/auth/usage', auth, function(req, res) {
  getTodayUsage(req.user.email, function(count) {
    res.json({ today: count, limit: FREE_LIMIT });
  });
});

// Guardar contexto personalizado (perfil de empresa / preferencias)
app.post('/auth/contexto', auth, function(req, res) {
  var contexto = (req.body.contexto || '').slice(0, 2000);
  saveUser(req.user.email, { contexto: contexto }, function(err) {
    res.json({ ok: !err, contexto: contexto });
  });
});

// ─── PERFIL DE EMPRESA ───
app.post('/auth/perfil', auth, function(req, res) {
  var b = req.body || {};
  var perfil = {
    empresa:   (b.empresa   || '').slice(0, 120),
    rubro:     (b.rubro     || '').slice(0, 120),
    tono:      (b.tono      || '').slice(0, 60),
    detalles:  (b.detalles  || '').slice(0, 1500)
  };
  // Construir el contexto que la IA usará a partir del perfil
  var ctxParts = [];
  if (perfil.empresa)  ctxParts.push('Empresa/negocio: ' + perfil.empresa);
  if (perfil.rubro)    ctxParts.push('Rubro: ' + perfil.rubro);
  if (perfil.tono)     ctxParts.push('Tono preferido de respuestas: ' + perfil.tono);
  if (perfil.detalles) ctxParts.push('Detalles importantes: ' + perfil.detalles);
  var contexto = ctxParts.join('. ');
  saveUser(req.user.email, { perfil: perfil, contexto: contexto }, function(err) {
    res.json({ ok: !err, perfil: perfil });
  });
});

app.get('/auth/perfil', auth, function(req, res) {
  getUser(req.user.email, function(err, user) {
    res.json({ perfil: (user && user.perfil) || {}, memoria: (user && user.memoria) || [] });
  });
});

// ─── MEMORIA ADAPTATIVA (la IA aprende del usuario) ───
// Guarda hechos clave que la IA detecta sobre el usuario para recordarlos siempre
app.post('/auth/memoria', auth, function(req, res) {
  var nuevoHecho = (req.body.hecho || '').slice(0, 200);
  if (!nuevoHecho) return res.json({ ok: false });
  getUser(req.user.email, function(err, user) {
    var memoria = (user && user.memoria) || [];
    // Evitar duplicados y limitar a 30 hechos
    if (memoria.indexOf(nuevoHecho) === -1) {
      memoria.push(nuevoHecho);
      if (memoria.length > 30) memoria = memoria.slice(-30);
    }
    saveUser(req.user.email, { memoria: memoria }, function(e) {
      res.json({ ok: !e, memoria: memoria });
    });
  });
});

app.delete('/auth/memoria', auth, function(req, res) {
  saveUser(req.user.email, { memoria: [] }, function(err) {
    res.json({ ok: !err });
  });
});

app.post('/auth/applyCode', auth, function(req, res) {
  var code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'Ingresa un codigo.' });
  if (!useMongo || !mongoDB) return res.status(503).json({ error: 'Servicio no disponible.' });
  mongoDB.collection('codes').findOne({ code: code, active: true }, function(err, doc) {
    if (!doc) return res.status(404).json({ error: 'Codigo invalido o expirado.' });
    if (doc.uses >= doc.maxUses) return res.status(400).json({ error: 'Codigo agotado.' });
    getUser(req.user.email, function(err2, user) {
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
      var base = (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > new Date())
        ? new Date(user.planExpiry) : new Date();
      var expiry = new Date(base.getTime() + doc.days * 24 * 60 * 60 * 1000);
      saveUser(req.user.email, { plan: 'pro', planExpiry: expiry.toISOString() }, function() {
        mongoDB.collection('codes').updateOne({ code: code }, { $inc: { uses: 1 } }, function() {});
        res.json({ ok: true, days: doc.days, expiresAt: expiry.toISOString() });
      });
    });
  });
});

// ═══════════════════════════════════════════
//  AGENTES — PROMPTS MEJORADOS
// ═══════════════════════════════════════════
var AGENTES = {
  general: {
    temperature: 0.7, maxTokens: 3000, search: true,
    prompt: `Eres NEXO GENERAL — el asistente de IA más útil, claro y completo en español.

IDENTIDAD: Eres como un amigo experto que sabe de todo: tecnología, cultura, historia, ciencia, negocios, arte, matemáticas, idiomas, consejos de vida.

LO QUE HACES:
• Respondes cualquier pregunta con claridad y precisión
• Ayudas a redactar textos, emails, mensajes, documentos
• Explicas conceptos complejos de forma sencilla
• Das consejos prácticos sobre situaciones cotidianas y de negocio
• Ayudas con tareas, estudios, trabajo, planificación

CÓMO RESPONDES:
- Directo al punto desde la primera oración
- Ejemplos concretos cuando el tema es complejo
- Preguntas simples: respuesta corta y clara
- Preguntas complejas: estructura con puntos o párrafos cortos
- Tono amigable y profesional, nunca robótico

Si la pregunta requiere datos actuales (precios, noticias, eventos recientes), usa la información de búsqueda web disponible.`
  },
  sabio: {
    temperature: 0.82, maxTokens: 3500, search: false,
    prompt: `Eres NEXO SABIO — el consejero de vida más profundo y sabio que existe.

IDENTIDAD: Combinas el conocimiento de Marco Aurelio, Carl Jung, Sócrates, Epicteto, Viktor Frankl y los mejores psicólogos modernos. Hablas como un amigo cercano muy inteligente, nunca como libro de texto.

ESPECIALIDAD:
• Filosofía práctica y estoicismo aplicado a la vida real
• Psicología: traumas, relaciones, autoestima, ansiedad, propósito
• Toma de decisiones difíciles bajo presión
• Crecimiento personal: hábitos, disciplina, motivación real
• Relaciones, conflictos, comunicación
• Preguntas existenciales y dilemas éticos

CÓMO RESPONDES:
1. PRIMERO validas lo que siente la persona. Una oración cálida y real.
2. LUEGO ofreces una perspectiva que cambia cómo ve el problema.
3. Usas UNA historia o analogía que haga "clic".
4. Terminas con 1-2 preguntas reflexivas o pasos accionables.

VOZ: Cálido pero honesto. Profundo pero accesible. Nunca "coach de Instagram". Sabiduría real.`
  },
  saber: {
    temperature: 0.25, maxTokens: 4096, search: true,
    prompt: `Eres NEXO DATOS — el analista de información más preciso y riguroso del mundo.

IDENTIDAD: Combinas periodista de The Economist, analista de datos y enciclopedia viviente. Transformas datos complejos en información clara y accionable.

ESPECIALIDAD:
• Datos, estadísticas y cifras exactas (países, población, economía, ciencia)
• Historia: fechas, eventos, causas, consecuencias
• Geografía, política, geopolítica
• Ciencia: biología, física, química, medicina, tecnología
• Economía: indicadores, mercados, tendencias, comparaciones
• Análisis empresarial: métricas, KPIs, proyecciones financieras

CÓMO RESPONDES:
• DATOS: Contexto → Dato principal en negrita → Datos de apoyo → Fuente o período
• COMPARACIONES: Tabla markdown clara
• HISTORIA: Cronología → causa → desarrollo → consecuencia → impacto hoy
• Preguntas simples: el dato exacto en la primera línea

REGLAS DE ORO:
• Indica si un dato es estimado, proyectado o exacto
• Números específicos: "3.2 millones", nunca "varios millones"
• NUNCA inventas datos. Si no estás seguro, lo dices claramente.
• Para datos actuales (precios, cotizaciones, noticias) usa la búsqueda web disponible.`
  },
  codigo: {
    temperature: 0.18, maxTokens: 4096, search: true,
    prompt: `Eres NEXO LÓGICO — el ingeniero de software senior más experto y práctico.

IDENTIDAD: 20 años resolviendo problemas reales. Estilo directo, sin jerga innecesaria. Cada respuesta es código que FUNCIONA.

ESPECIALIDAD:
• Python, JavaScript/TypeScript, HTML/CSS, SQL, Java, C++, Bash
• Algoritmos, estructuras de datos, arquitectura de software
• Debugging: encuentras el error exacto y explicas por qué
• Matemáticas: álgebra, estadística, cálculo
• Excel/Sheets: fórmulas avanzadas, tablas dinámicas
• Automatización de procesos empresariales

CÓMO RESPONDES:
1. Si piden código → código COMPLETO y LISTO PARA USAR, sin "..." ni "resto del código"
2. Comentarios en español en cada sección importante
3. Para errores: el bug exacto en UNA oración, luego el código corregido
4. Para matemáticas: paso a paso con resultado en negrita
5. Al final: 1-2 líneas de cómo ejecutarlo

FORMATO: Bloques de código con el lenguaje especificado. NUNCA código incompleto.`
  },
  creativo: {
    temperature: 0.95, maxTokens: 2500, search: false,
    prompt: `Eres NEXO CREATIVO — el director creativo más talentoso del mundo hispanohablante.

IDENTIDAD: Mezclas copywriter de Cannes, la imaginación de García Márquez, diseño de Dieter Rams y estrategia de CMO de Silicon Valley. Tu trabajo siempre sorprende y tiene alma.

ESPECIALIDAD:
• Escritura creativa: cuentos, poemas, canciones, guiones, discursos
• Estrategia de marca: nombres, slogans, identidad, posicionamiento
• Contenido para redes: posts virales, guiones de Reels/TikTok
• Ideas de negocio: concepto + nombre + propuesta de valor
• Marketing: campañas, anuncios, emails, landings
• Poesía y letras con ritmo real

CÓMO RESPONDES:
1. SIEMPRE entregas el resultado directamente — no describes, HACES
2. Tu primer verso/oración engancha y tiene carácter propio
3. Para marcas: NOMBRE + SLOGAN + concepto en 2 líneas
4. Usas metáforas inesperadas, rompes lo predecible
5. Para poemas/canciones: el ritmo se SIENTE al leer en voz alta

VOZ: Apasionada, original, con personalidad. Nunca genérica. Solo el resultado, directo.`
  }
};

function buildPrompt(agentId, userCtx, userMem) {
  var cfg = AGENTES[agentId] || AGENTES.general;
  var base = cfg.prompt + '\n\nREGLAS ABSOLUTAS:\n' +
    '- Responde SIEMPRE en español, sin excepción\n' +
    '- NUNCA digas "no puedo", "como modelo de lenguaje", "no tengo opinión"\n' +
    '- NUNCA menciones que eres una IA salvo que te lo pregunten directamente\n' +
    '- Sé directo: la respuesta real en las primeras líneas\n' +
    '- PROPORCIONALIDAD (importante): ajusta el largo de tu respuesta al tamaño de la pregunta. ' +
    'Pregunta simple o saludo = respuesta de 1-3 oraciones. Pregunta media = un párrafo. ' +
    'Solo despliega respuestas largas con listas/secciones cuando el usuario pide algo complejo, ' +
    'un tutorial, un análisis o explícitamente más detalle. NUNCA sueltes "páginas de texto" para algo sencillo.\n' +
    '- Habla natural, como una persona experta y cercana. Evita relleno y frases de cortesía innecesarias.\n' +
    '- En temas empresariales o financieros: máxima precisión, nunca inventes cifras, distingue dato de estimación.';
  if (userCtx && userCtx.trim()) {
    base += '\n\nCONTEXTO DEL USUARIO (tenlo en cuenta siempre, adáptate a él/ella):\n' + userCtx.trim();
  }
  if (userMem && userMem.length) {
    base += '\n\nLO QUE SABES DE ESTE USUARIO (de conversaciones anteriores, úsalo para personalizar):\n- ' +
      userMem.join('\n- ');
  }
  return base;
}

function getAgentConfig(agentId) { return AGENTES[agentId] || AGENTES.general; }

// ═══════════════════════════════════════════
//  GEMINI con BÚSQUEDA WEB + MULTI-ARCHIVO
// ═══════════════════════════════════════════
function llamarGemini(history, text, agentId, files, userCtx, userMem, cb) {
  var key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_'))
    return cb(new Error('Falta configurar GEMINI_KEY.'));

  var cfg = getAgentConfig(agentId);
  var hist = (history || []).slice(-12).map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });

  // Construir parts del mensaje actual (texto + múltiples archivos)
  var parts = [];
  var textoMsg = text || 'Analiza.';

  // Soporte multi-archivo: files puede ser array o un solo objeto
  var fileList = [];
  if (Array.isArray(files)) fileList = files;
  else if (files && files.data) fileList = [files];

  // Archivos de texto: incrustar contenido
  var textFiles = '';
  var binFiles = [];
  fileList.forEach(function(f) {
    if (!f || !f.data) return;
    var isText = f.mimeType && f.mimeType.startsWith('text/');
    if (isText && f.textContent) {
      textFiles += '\n\nArchivo "' + (f.fileName || 'archivo') + '":\n' + f.textContent.slice(0, 8000);
    } else {
      binFiles.push(f);
    }
  });

  parts.push({ text: textoMsg + textFiles });
  binFiles.forEach(function(f) {
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  });

  hist.push({ role: 'user', parts: parts });

  // Configuración con búsqueda web si el agente lo permite
  var bodyConfig = {
    system_instruction: { parts: [{ text: buildPrompt(agentId, userCtx, userMem) }] },
    contents: hist,
    generationConfig: { maxOutputTokens: cfg.maxTokens, temperature: cfg.temperature }
  };
  // Activar Google Search para agentes que lo necesitan (solo si no hay archivos)
  if (cfg.search && binFiles.length === 0) {
    bodyConfig.tools = [{ google_search: {} }];
  }

  var modelos = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  var idx = 0;
  function next() {
    if (idx >= modelos.length) return cb(new Error('No pude conectar. Intenta en unos segundos.'));
    var modelo = modelos[idx++];
    fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyConfig)
    })
    .then(function(r) { return r.text(); })
    .then(function(raw) {
      var json; try { json = JSON.parse(raw); } catch(e) { return next(); }
      if (json.error) {
        // Si falla por la herramienta de búsqueda, reintentar sin ella
        if (bodyConfig.tools) { delete bodyConfig.tools; idx--; return next(); }
        return next();
      }
      var reply = json.candidates && json.candidates[0] && json.candidates[0].content
        && json.candidates[0].content.parts && json.candidates[0].content.parts
          .map(function(p){ return p.text || ''; }).join('').trim();
      if (!reply) return next();
      cb(null, reply);
    })
    .catch(function() { next(); });
  }
  next();
}

// ═══════════════════════════════════════════
//  DETECCIÓN DE IMAGEN
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  CHAT ROUTES
// ═══════════════════════════════════════════
function respond(req, res, reply, imageUrl) {
  if (!req.isPro) incrementUsage(req.user.email);
  var payload = {
    reply: reply, plan: req.user.plan,
    todayMsgs: (req.msgCount || 0) + 1, freeLimit: FREE_LIMIT
  };
  if (imageUrl) payload.imageUrl = imageUrl;
  res.json(payload);
}

['general', 'sabio', 'saber', 'codigo'].forEach(function(agente) {
  app.post('/api/' + agente, auth, checkPlan, function(req, res) {
    var userCtx = (req.userDoc && req.userDoc.contexto) || '';
    var userMem = (req.userDoc && req.userDoc.memoria) || [];
    // Soporta req.body.files (array) o req.body.file (single, retrocompat)
    var files = req.body.files || req.body.file || null;
    llamarGemini(req.body.history || [], req.body.text || '', agente, files, userCtx, userMem,
      function(err, reply) {
        if (err) return res.status(500).json({ error: err.message });
        respond(req, res, reply);
      }
    );
  });
});

app.post('/api/creativo', auth, checkPlan, function(req, res) {
  var text = req.body.text || '';
  if (isImageRequest(text)) {
    var seed = Math.floor(Math.random() * 999999);
    var imgPrompt = text + ', high quality, detailed, professional, 4k';
    var imageUrl = 'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(imgPrompt) + '?width=768&height=768&seed=' + seed + '&nologo=true&enhance=true';
    return respond(req, res,
      '🎨 ¡Aquí está tu imagen! La generé con IA a partir de tu descripción.\n\n_Tip: pídela de nuevo o agrega más detalles para otra versión._',
      imageUrl);
  }
  var userCtx = (req.userDoc && req.userDoc.contexto) || '';
  var userMem = (req.userDoc && req.userDoc.memoria) || [];
  var files = req.body.files || req.body.file || null;
  llamarGemini(req.body.history || [], text, 'creativo', files, userCtx, userMem,
    function(err, reply) {
      if (err) return res.status(500).json({ error: err.message });
      respond(req, res, reply);
    }
  );
});

app.post('/api/imagen', auth, function(req, res) {
  var prompt = (req.body.prompt || '').slice(0, 400);
  if (!prompt) return res.status(400).json({ error: 'Describe la imagen.' });
  res.json({ imageUrl: 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
    '?width=768&height=768&seed=' + Math.floor(Math.random()*999999) + '&nologo=true' });
});

// ═══════════════════════════════════════════
//  CONVERSACIONES EN LA NUBE
// ═══════════════════════════════════════════
app.get('/api/conversations', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ conversations: [] });
  mongoDB.collection('conversations').find({ userId: req.user.id })
    .sort({ updatedAt: -1 }).limit(20).toArray(function(err, docs) {
      res.json({ conversations: docs || [] });
    });
});

app.post('/api/conversations', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ ok: false });
  var conv = req.body;
  if (!conv.id) return res.status(400).json({ error: 'ID requerido.' });
  mongoDB.collection('conversations').updateOne(
    { id: conv.id, userId: req.user.id },
    { $set: { id: conv.id, userId: req.user.id, title: (conv.title || 'Conversacion').slice(0, 60),
        hist: (conv.hist || []).slice(-30), agent: conv.agent || 'general', updatedAt: new Date().toISOString() } },
    { upsert: true },
    function(err) { res.json({ ok: !err }); }
  );
});

app.delete('/api/conversations/:id', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ ok: false });
  mongoDB.collection('conversations').deleteOne({ id: req.params.id, userId: req.user.id },
    function(err) { res.json({ ok: !err }); });
});

app.post('/chats/save', auth, function(req, res) {
  var chat = req.body.chat;
  if (!chat || !chat.id) return res.status(400).json({ error: 'Chat invalido.' });
  if (!useMongo || !mongoDB) return res.json({ ok: true });
  chat.email = req.user.email;
  chat.updatedAt = new Date().toISOString();
  mongoDB.collection('chats').updateOne({ id: chat.id, email: req.user.email },
    { $set: chat }, { upsert: true }, function(err) { res.json({ ok: !err }); });
});

app.get('/chats/list', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ chats: [] });
  mongoDB.collection('chats').find({ email: req.user.email }, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 }).limit(20).toArray(function(err, docs) {
      res.json({ chats: docs || [] });
    });
});

app.delete('/chats/:id', auth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ ok: true });
  mongoDB.collection('chats').deleteOne({ id: req.params.id, email: req.user.email },
    function(err) { res.json({ ok: !err }); });
});

// ═══════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════
app.post('/admin/activate', adminAuth, function(req, res) {
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

app.get('/admin/users', adminAuth, function(req, res) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').find({}, { projection: { password: 0 } }).toArray(function(err, users) {
      var now = new Date();
      var result = (users || []).map(function(u) {
        return { nombre: u.nombre, email: u.email,
          plan: u.plan === 'pro' && u.planExpiry && new Date(u.planExpiry) > now ? 'pro' : 'free',
          planExpiry: u.planExpiry, trialExpiry: u.trialExpiry,
          refCode: u.refCode, refCount: u.refCount || 0, creado: u.creado };
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

app.get('/admin/stats', adminAuth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ totalMsgs: 0, todayMsgs: 0, todayActiveUsers: 0, totalUsers: 0 });
  var today = new Date().toISOString().slice(0, 10);
  var now = new Date();
  Promise.all([
    new Promise(function(r) { mongoDB.collection('usage').aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }]).toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); }); }),
    new Promise(function(r) { mongoDB.collection('usage').aggregate([{ $match: { date: today } }, { $group: { _id: null, total: { $sum: '$count' } } }]).toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); }); }),
    new Promise(function(r) { mongoDB.collection('users').countDocuments({}, function(e, n) { r(n || 0); }); }),
    new Promise(function(r) { mongoDB.collection('usage').distinct('email', { date: today }, function(e, d) { r(d ? d.length : 0); }); }),
    new Promise(function(r) { mongoDB.collection('users').countDocuments({ plan: 'pro', planExpiry: { $gt: now.toISOString() } }, function(e, n) { r(n || 0); }); })
  ]).then(function(results) {
    res.json({ totalMsgs: results[0], todayMsgs: results[1], totalUsers: results[2],
      todayActiveUsers: results[3], proUsers: results[4], revenue: (results[4] * 4.99).toFixed(2) });
  }).catch(function() { res.json({ totalMsgs: 0, todayMsgs: 0, totalUsers: 0, todayActiveUsers: 0 }); });
});

app.post('/admin/codes', adminAuth, function(req, res) {
  if (!useMongo || !mongoDB) return res.status(503).json({ error: 'MongoDB requerido.' });
  var code = (req.body.code || '').toUpperCase().trim();
  var days = parseInt(req.body.days || '30');
  var maxUses = parseInt(req.body.maxUses || '100');
  if (!code) return res.status(400).json({ error: 'Codigo requerido.' });
  mongoDB.collection('codes').updateOne({ code: code },
    { $set: { code: code, days: days, maxUses: maxUses, uses: 0, active: true, createdAt: new Date().toISOString() } },
    { upsert: true }, function(err) { res.json({ ok: !err, code: code, days: days, maxUses: maxUses }); });
});

app.get('/admin/codes', adminAuth, function(req, res) {
  if (!useMongo || !mongoDB) return res.json({ codes: [] });
  mongoDB.collection('codes').find({}).toArray(function(err, docs) { res.json({ codes: docs || [] }); });
});

// ═══════════════════════════════════════════
//  NOTIFICACIONES
// ═══════════════════════════════════════════
function notifyNewUser(nombre, email) {
  var waBotKey = process.env.WA_BOT_KEY || '';
  if (waBotKey) {
    var waMsg = encodeURIComponent('IA-NEXO Nuevo usuario: ' + nombre + ' (' + email + ')');
    fetch('https://api.callmebot.com/whatsapp.php?phone=584243602967&text=' + waMsg + '&apikey=' + waBotKey).catch(function(){});
  }
  var channel = process.env.NTFY_CHANNEL;
  if (channel) {
    fetch('https://ntfy.sh/' + channel, {
      method: 'POST',
      headers: { 'Title': 'Nuevo usuario en IA-NEXO', 'Priority': 'high', 'Tags': 'tada' },
      body: nombre + ' (' + email + ') se registro ahora mismo!'
    }).catch(function(){});
  }
}

// ═══════════════════════════════════════════
//  PÁGINAS
// ═══════════════════════════════════════════
app.get('/landing', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'landing.html')); });
app.get('/admin', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/panel-admin', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('*', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ═══════════════════════════════════════════
//  ARRANQUE
// ═══════════════════════════════════════════
app.listen(PORT, function() {
  var ok = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  IA-NEXO v15 — Memoria adaptativa + Perfiles + Web Search');
  console.log('  Puerto : ' + PORT);
  console.log('  Gemini : ' + (ok ? 'OK' : 'FALTA GEMINI_KEY'));
  console.log('  DB     : ' + (process.env.MONGO_URI ? 'MongoDB' : 'Archivo local'));
  console.log('  Admin  : /panel-admin (key: ' + ADMIN_KEY + ')');
  console.log('');
});
