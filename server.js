require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nexo-secret-2025';

// Base de datos simple en archivo JSON
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch { return {}; }
}

function saveUsers(users) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2)); }
  catch(e) { console.error('Error guardando:', e.message); }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware JWT
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Debes iniciar sesion para usar IA-NEXO.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sesion expirada. Inicia sesion de nuevo.' }); }
}

// REGISTRO
app.post('/auth/register', async (req, res) => {
  const { nombre, email, password } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
  if (!email.includes('@'))
    return res.status(400).json({ error: 'Email invalido.' });

  const users = loadUsers();
  const key = email.toLowerCase().trim();
  if (users[key]) return res.status(400).json({ error: 'Ya existe una cuenta con ese email.' });

  const hash = await bcrypt.hash(password, 10);
  const id = 'u' + Date.now();
  users[key] = { id, nombre: nombre.trim(), email: key, password: hash, creado: new Date().toISOString() };
  saveUsers(users);

  const token = jwt.sign({ id, nombre: nombre.trim(), email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nombre: nombre.trim(), email: key });
});

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contrasena requeridos.' });

  const users = loadUsers();
  const key = email.toLowerCase().trim();
  const user = users[key];
  if (!user) return res.status(401).json({ error: 'No existe cuenta con ese email.' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Contrasena incorrecta.' });

  const token = jwt.sign({ id: user.id, nombre: user.nombre, email: key }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, nombre: user.nombre, email: key });
});

// VERIFICAR TOKEN
app.get('/auth/me', auth, (req, res) => {
  res.json({ nombre: req.user.nombre, email: req.user.email });
});

// PROMPTS
const PROMPTS = {
  info:   'Eres NEXO-SABER, especialista en informacion e investigacion. Responde SIEMPRE en espanol con datos precisos y bien estructurados.',
  code:   'Eres NEXO-CODIGO, experto en programacion y matematicas. Responde SIEMPRE en espanol. Usa bloques de codigo. Explica cada paso.',
  create: 'Eres NEXO-CREATIVO, asistente creativo especializado en arte y expresion. Responde SIEMPRE en espanol. Se expresivo e imaginativo.',
  sage:   'Eres NEXO-SABIO, especialista en analisis profundo y filosofia. Responde SIEMPRE en espanol. Analiza con profundidad y matices.',
};

// GEMINI
async function gemini(history, text, prompt) {
  const key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) throw new Error('GEMINI_KEY no configurada.');
  const hist = (history || []).slice(-14).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }]
  }));
  const modelos = ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.0-flash-lite','gemini-1.5-flash'];
  for (const m of modelos) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent?key='+key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: prompt }] },
          contents: [...hist, { role: 'user', parts: [{ text }] }],
          generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
        })
      });
      const raw = await r.text();
      let json; try { json = JSON.parse(raw); } catch { continue; }
      if (json.error) { console.log('[skip]', m, json.error.message); continue; }
      const reply = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!reply) continue;
      return reply;
    } catch(e) { console.log('[err]', m, e.message); }
  }
  throw new Error('Gemini no disponible. Intenta de nuevo.');
}

// RUTAS IA — protegidas
app.post('/api/info',   auth, async(req,res) => { try{res.json({reply:await gemini(req.body.history,req.body.text,PROMPTS.info)});}   catch(e){res.status(500).json({error:'NEXO-SABER: '+e.message});} });
app.post('/api/code',   auth, async(req,res) => { try{res.json({reply:await gemini(req.body.history,req.body.text,PROMPTS.code)});}   catch(e){res.status(500).json({error:'NEXO-CODIGO: '+e.message});} });
app.post('/api/create', auth, async(req,res) => { try{res.json({reply:await gemini(req.body.history,req.body.text,PROMPTS.create)}); }catch(e){res.status(500).json({error:'NEXO-CREATIVO: '+e.message});} });
app.post('/api/sage',   auth, async(req,res) => { try{res.json({reply:await gemini(req.body.history,req.body.text,PROMPTS.sage)});}   catch(e){res.status(500).json({error:'NEXO-SABIO: '+e.message});} });

// IMAGEN
app.post('/api/imagen', auth, (req,res) => {
  const {prompt} = req.body;
  if (!prompt) return res.status(400).json({error:'Falta el prompt'});
  const p = encodeURIComponent(prompt.slice(0,400));
  const seed = Math.floor(Math.random()*999999);
  res.json({imageUrl:'https://image.pollinations.ai/prompt/'+p+'?width=768&height=768&seed='+seed+'&nologo=true&nofeed=true'});
});

// STATUS
app.get('/api/status', auth, (req,res) => {
  const gemini = !!(process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_'));
  res.json({gemini, usuario: req.user.nombre});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  const g = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  IA-NEXO v5.0 en puerto '+PORT);
  console.log('  Gemini:  '+(g?'OK':'Falta GEMINI_KEY'));
  console.log('  Auth:    JWT + bcrypt activo');
  console.log('  DB:      '+DB_PATH+'\n');
});
