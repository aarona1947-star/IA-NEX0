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

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getUsers(){try{return JSON.parse(fs.readFileSync(DB,'utf8'));}catch(e){return {};}}
function setUsers(u){try{fs.writeFileSync(DB,JSON.stringify(u,null,2));}catch(e){}}

function auth(req,res,next){
  var token=(req.headers.authorization||'').replace('Bearer ','');
  if(!token)return res.status(401).json({error:'Inicia sesion para continuar.'});
  try{req.user=jwt.verify(token,SECRET);next();}
  catch(e){res.status(401).json({error:'Sesion expirada.'});}
}

app.post('/auth/register',async function(req,res){
  var b=req.body||{};
  var nombre=(b.nombre||'').trim(),email=(b.email||'').trim().toLowerCase(),pw=b.password||'';
  if(!nombre||!email||!pw)return res.status(400).json({error:'Todos los campos son obligatorios.'});
  if(pw.length<6)return res.status(400).json({error:'Minimo 6 caracteres.'});
  if(!email.includes('@'))return res.status(400).json({error:'Email invalido.'});
  var users=getUsers();
  if(users[email])return res.status(400).json({error:'Ya existe una cuenta con ese email.'});
  var hash=await bcrypt.hash(pw,10);
  users[email]={id:'u'+Date.now(),nombre,email,password:hash,creado:new Date().toISOString()};
  setUsers(users);
  var token=jwt.sign({id:users[email].id,nombre,email},SECRET,{expiresIn:'30d'});
  res.json({token,nombre,email});
});

app.post('/auth/login',async function(req,res){
  var b=req.body||{};
  var email=(b.email||'').trim().toLowerCase(),pw=b.password||'';
  if(!email||!pw)return res.status(400).json({error:'Email y contrasena requeridos.'});
  var users=getUsers(),user=users[email];
  if(!user)return res.status(401).json({error:'No existe cuenta con ese email.'});
  var ok=await bcrypt.compare(pw,user.password);
  if(!ok)return res.status(401).json({error:'Contrasena incorrecta.'});
  var token=jwt.sign({id:user.id,nombre:user.nombre,email},SECRET,{expiresIn:'30d'});
  res.json({token,nombre:user.nombre,email});
});

app.get('/auth/me',auth,function(req,res){
  res.json({nombre:req.user.nombre,email:req.user.email});
});

// ══════════════════════════════════════════════════
//  EL PROMPT — lo que hace que todo funcione
// ══════════════════════════════════════════════════
var ESTILOS = {
  sabio:    'Eres sabio y reflexivo. Usas analogías cuando ayuda. Para temas filosóficos profundizas; para preguntas simples vas directo.',
  saber:    'Eres preciso y factual. Citas datos reales o estimaciones realistas. Organizas bien la información.',
  codigo:   'Eres técnico y directo. Para matemáticas das el resultado correcto (1+9=10, sin errores). Para código das fragmentos limpios y funcionales.',
  creativo: 'Eres imaginativo y expresivo. Escribes con metáforas, color y emoción.'
};

function buildPrompt(agentId) {
  var estilo = ESTILOS[agentId] || ESTILOS.sabio;
  return (
    'Eres un asistente de IA llamado IA-NEXO. ' + estilo + '\n\n' +
    'REGLAS ABSOLUTAS:\n' +
    '- Responde SIEMPRE en español\n' +
    '- Responde CUALQUIER pregunta: matemáticas, ciencia, historia, código, filosofía, cocina, viajes, deportes, noticias, arte — TODO\n' +
    '- NUNCA digas "no puedo", "no tengo acceso", "como IA no puedo opinar"\n' +
    '- NUNCA repitas la pregunta del usuario\n' +
    '- NUNCA empieces con "¡Claro!", "¡Por supuesto!", "¡Desde luego!"\n' +
    '- Para matemáticas: da el resultado exacto y correcto. 1+9=10. 15*8=120. Nunca cambies los números\n' +
    '- Para código: da el fragmento que funcione, nada más\n' +
    '- Para preguntas simples: respuesta corta y directa\n' +
    '- Para preguntas complejas: respuesta completa y bien estructurada\n' +
    '- Si hay archivo adjunto: analízalo de forma útil y directa\n' +
    '- Ajusta el largo a lo que la pregunta necesita: simple=corto, complejo=desarrollado\n' +
    '- Sé natural, como un amigo muy inteligente que sabe de todo'
  );
}

// ══════════════════════════════════════════════════
//  GEMINI — motor multimodal
// ══════════════════════════════════════════════════
function llamarGemini(history, text, agentId, fileData, cb) {
  var key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) {
    return cb(new Error('Falta configurar GEMINI_KEY en Railway Variables.'));
  }

  var prompt = buildPrompt(agentId);

  // Historial (sin archivos previos para no saturar)
  var hist = (history || []).slice(-10).map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });

  // Mensaje actual — con o sin archivo
  var parts = [];
  if (fileData && fileData.data) {
    var isTextFile = fileData.mimeType && (
      fileData.mimeType.startsWith('text/') ||
      fileData.mimeType === 'application/json' ||
      fileData.mimeType === 'application/javascript'
    );
    if (isTextFile && fileData.textContent) {
      parts.push({ text: (text || 'Analiza este archivo.') + '\n\nArchivo "' + fileData.fileName + '":\n' + fileData.textContent.slice(0, 8000) });
    } else {
      parts.push({ text: text || 'Analiza este archivo adjunto.' });
      parts.push({ inlineData: { mimeType: fileData.mimeType, data: fileData.data } });
    }
  } else {
    parts.push({ text: text });
  }
  hist.push({ role: 'user', parts: parts });

  // Modelos: preferir los más capaces para archivos
  var modelos = fileData
    ? ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash']
    : ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

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
      var json; try { json = JSON.parse(raw); } catch(e) { return next(); }
      if (json.error) { console.log('skip', modelo); return next(); }
      var reply =
        json.candidates &&
        json.candidates[0] &&
        json.candidates[0].content &&
        json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] &&
        json.candidates[0].content.parts[0].text;
      if (!reply) return next();
      console.log('OK', modelo);
      cb(null, reply.trim());
    })
    .catch(function() { next(); });
  }
  next();
}

// ══════════════════════════════════════════════════
//  RUTAS — 4 agentes, mismo motor, diferente estilo
// ══════════════════════════════════════════════════
['sabio', 'saber', 'codigo', 'creativo'].forEach(function(agente) {
  app.post('/api/' + agente, auth, function(req, res) {
    llamarGemini(
      req.body.history || [],
      req.body.text    || '',
      agente,
      req.body.file    || null,
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
  var seed = Math.floor(Math.random() * 999999);
  res.json({ imageUrl: 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=768&height=768&seed=' + seed + '&nologo=true&nofeed=true' });
});

// Landing page de ventas
app.get('/landing', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// La APP siempre en /  (ruta principal)
app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
  var ok = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  IA-NEXO v5.5');
  console.log('  Puerto : ' + PORT);
  console.log('  Gemini : ' + (ok ? 'OK' : 'Falta GEMINI_KEY'));
  console.log('  Modo   : Asistente general — responde todo\n');
});