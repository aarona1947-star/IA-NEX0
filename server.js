require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Prompt base del sistema
const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial avanzado. Responde SIEMPRE en español, de forma clara, precisa y útil. Puedes ayudar con programación, ciencias, creatividad, matemáticas, idiomas y cualquier otro tema.';

// Construye el array de mensajes con historial
function msgs(history, text) {
  return [
    { role: 'system', content: SISTEMA },
    ...(history || []).slice(-14),
    { role: 'user', content: text }
  ];
}

// ══════════════════════════════════════════════
//  Llamada genérica a OpenRouter
//  Prueba modelos en orden hasta que uno funcione
// ══════════════════════════════════════════════
async function llamarOpenRouter(history, text, modelos) {
  const key = process.env.OPENROUTER_KEY || '';

  if (!key || key.includes('pon-tu-clave')) {
    throw new Error('Necesitas agregar tu OPENROUTER_KEY. Obtenla gratis en openrouter.ai/keys y agrégala en Railway → Variables.');
  }

  let ultimoError = 'Sin respuesta';

  for (const modelo of modelos) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer':  'https://ia-nexo.up.railway.app',
          'X-Title':       'IA-NEXO'
        },
        body: JSON.stringify({
          model:       modelo,
          messages:    msgs(history, text),
          max_tokens:  1500,
          temperature: 0.7
        })
      });

      const json = await res.json();

      // Si hay error de cuota o modelo no disponible, prueba el siguiente
      if (res.status === 429 || res.status === 503 || json.error) {
        ultimoError = json.error?.message || `HTTP ${res.status}`;
        console.log(`[skip] ${modelo}: ${ultimoError}`);
        continue;
      }

      const respuesta = json.choices?.[0]?.message?.content;
      if (!respuesta) {
        ultimoError = 'Respuesta vacía';
        continue;
      }

      console.log(`[OK] ${modelo}`);
      return respuesta;

    } catch (e) {
      ultimoError = e.message;
      console.log(`[error] ${modelo}: ${e.message}`);
      continue;
    }
  }

  throw new Error(`Todos los modelos fallaron. Último error: ${ultimoError}`);
}

// ══════════════════════════════════════════════
//  Llamada genérica a APIs tipo OpenAI
//  (ChatGPT, DeepSeek, Mistral, Grok)
// ══════════════════════════════════════════════
async function llamarAPI(url, key, modelo, history, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model:      modelo,
      messages:   msgs(history, text),
      max_tokens: 1500
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.choices[0].message.content;
}

// ══════════════════════════════════════════════
//  RUTAS DE LA API
// ══════════════════════════════════════════════

// ── LLAMA (gratis via OpenRouter) ──
app.post('/api/llama', async (req, res) => {
  try {
    const reply = await llamarOpenRouter(req.body.history, req.body.text, [
      'meta-llama/llama-3.2-3b-instruct:free',
      'meta-llama/llama-3.1-8b-instruct:free',
      'meta-llama/llama-3.2-1b-instruct:free'
    ]);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: '🦙 Llama: ' + e.message });
  }
});

// ── MISTRAL (gratis via OpenRouter) ──
app.post('/api/mistral-free', async (req, res) => {
  try {
    const reply = await llamarOpenRouter(req.body.history, req.body.text, [
      'mistralai/mistral-7b-instruct:free',
      'mistralai/mistral-7b-instruct-v0.1:free'
    ]);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: '🌊 Mistral: ' + e.message });
  }
});

// ── GEMMA (gratis via OpenRouter) ──
app.post('/api/gemma', async (req, res) => {
  try {
    const reply = await llamarOpenRouter(req.body.history, req.body.text, [
      'google/gemma-2-9b-it:free',
      'google/gemma-2-9b-it'
    ]);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: '💎 Gemma: ' + e.message });
  }
});

// ── QWEN (gratis via OpenRouter) ──
app.post('/api/qwen', async (req, res) => {
  try {
    const reply = await llamarOpenRouter(req.body.history, req.body.text, [
      'qwen/qwen-2-7b-instruct:free',
      'qwen/qwen2.5-7b-instruct:free'
    ]);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: '🌸 Qwen: ' + e.message });
  }
});

// ── CHATGPT (requiere clave de pago) ──
app.post('/api/chatgpt', async (req, res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({ error: 'ChatGPT necesita tu OPENAI_KEY en Railway Variables → platform.openai.com' });
  try {
    const reply = await llamarAPI('https://api.openai.com/v1/chat/completions', key, 'gpt-4o', req.body.history, req.body.text);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'ChatGPT: ' + e.message });
  }
});

// ── DEEPSEEK (requiere clave de pago) ──
app.post('/api/deepseek', async (req, res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({ error: 'DeepSeek necesita tu DEEPSEEK_KEY en Railway Variables → platform.deepseek.com' });
  try {
    const reply = await llamarAPI('https://api.deepseek.com/chat/completions', key, 'deepseek-chat', req.body.history, req.body.text);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'DeepSeek: ' + e.message });
  }
});

// ── GROK (requiere clave de pago) ──
app.post('/api/grok', async (req, res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({ error: 'Grok necesita tu GROK_KEY en Railway Variables → console.x.ai' });
  try {
    const reply = await llamarAPI('https://api.x.ai/v1/chat/completions', key, 'grok-2-latest', req.body.history, req.body.text);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'Grok: ' + e.message });
  }
});

// ── STATUS — qué modelos están listos ──
app.get('/api/status', (req, res) => {
  const or = !!(process.env.OPENROUTER_KEY && !process.env.OPENROUTER_KEY.includes('pon-tu-clave'));
  res.json({
    llama:    or,
    mistral:  or,
    gemma:    or,
    qwen:     or,
    chatgpt:  !!process.env.OPENAI_KEY,
    deepseek: !!process.env.DEEPSEEK_KEY,
    grok:     !!process.env.GROK_KEY
  });
});

// Ruta principal
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  const or = process.env.OPENROUTER_KEY && !process.env.OPENROUTER_KEY.includes('pon-tu-clave');
  console.log('');
  console.log('  ┌─────────────────────────────┐');
  console.log('  │     🧠  IA-NEXO  v2.0       │');
  console.log('  │  http://localhost:' + PORT + '       │');
  console.log('  └─────────────────────────────┘');
  console.log('');
  console.log('  Modelos gratuitos (OpenRouter):');
  console.log('    Llama 3   ' + (or ? '✅' : '❌  Falta OPENROUTER_KEY'));
  console.log('    Mistral   ' + (or ? '✅' : '❌  Falta OPENROUTER_KEY'));
  console.log('    Gemma 2   ' + (or ? '✅' : '❌  Falta OPENROUTER_KEY'));
  console.log('    Qwen 2.5  ' + (or ? '✅' : '❌  Falta OPENROUTER_KEY'));
  console.log('');
  console.log('  Modelos de pago (opcionales):');
  console.log('    ChatGPT   ' + (process.env.OPENAI_KEY   ? '✅' : '➖  sin clave'));
  console.log('    DeepSeek  ' + (process.env.DEEPSEEK_KEY ? '✅' : '➖  sin clave'));
  console.log('    Grok      ' + (process.env.GROK_KEY     ? '✅' : '➖  sin clave'));
  console.log('');
});