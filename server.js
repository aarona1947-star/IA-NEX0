require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial avanzado. Responde SIEMPRE en español, de forma clara, precisa y útil. Puedes ayudar con cualquier tema.';

function msgs(history, text) {
  return [{ role:'system', content:SISTEMA }, ...(history||[]).slice(-14), { role:'user', content:text }];
}

// Llamada a OpenRouter con fallback de modelos
async function openrouter(history, text, modelos) {
  const key = process.env.OPENROUTER_KEY || '';
  if (!key || key.includes('pon-tu-clave') || key.length < 20) {
    throw new Error('Necesitas agregar OPENROUTER_KEY en Railway → Variables. Obtenla gratis en openrouter.ai/keys');
  }
  for (const modelo of modelos) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer':  'https://ia-nex0-production.up.railway.app',
          'X-Title':       'IA-NEXO'
        },
        body: JSON.stringify({ model:modelo, messages:msgs(history,text), max_tokens:1500, temperature:0.7 })
      });
      const json = await r.json();
      if (json.error || r.status===429 || r.status===503) {
        console.log(`[skip] ${modelo}: ${json.error?.message||r.status}`); continue;
      }
      const reply = json.choices?.[0]?.message?.content;
      if (!reply) { console.log(`[skip] ${modelo}: respuesta vacía`); continue; }
      console.log(`[OK] ${modelo}`);
      return reply;
    } catch(e) { console.log(`[err] ${modelo}: ${e.message}`); continue; }
  }
  throw new Error('No se pudo obtener respuesta. Verifica tu OPENROUTER_KEY en Railway Variables.');
}

// Llamada directa a APIs de pago (OpenAI-compatible)
async function apiPago(url, key, modelo, history, text) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` },
    body: JSON.stringify({ model:modelo, messages:msgs(history,text), max_tokens:1500 })
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error?.message || `HTTP ${r.status}`);
  return json.choices[0].message.content;
}

// ══════════════════════════════════════
// LLAMA — Meta (gratis)
// ══════════════════════════════════════
app.post('/api/llama', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'meta-llama/llama-3.2-3b-instruct:free',
      'meta-llama/llama-3.1-8b-instruct:free',
      'meta-llama/llama-3.2-1b-instruct:free',
      'nousresearch/hermes-3-llama-3.1-405b:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🦙 ' + e.message }); }
});

// ══════════════════════════════════════
// MISTRAL — (gratis)
// ══════════════════════════════════════
app.post('/api/mistral-free', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'mistralai/mistral-7b-instruct:free',
      'mistralai/mistral-7b-instruct-v0.3:free',
      'mistralai/mistral-7b-instruct-v0.1:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🌊 ' + e.message }); }
});

// ══════════════════════════════════════
// GEMMA — Google (gratis)
// ══════════════════════════════════════
app.post('/api/gemma', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'google/gemma-2-9b-it:free',
      'google/gemma-2-9b-it',
      'google/gemma-7b-it:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '💎 ' + e.message }); }
});

// ══════════════════════════════════════
// QWEN — Alibaba (gratis)
// ══════════════════════════════════════
app.post('/api/qwen', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'qwen/qwen-2-7b-instruct:free',
      'qwen/qwen2.5-7b-instruct:free',
      'qwen/qwen-2-72b-instruct:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🌸 ' + e.message }); }
});

// ══════════════════════════════════════
// CHATGPT — OpenAI (pago)
// ══════════════════════════════════════
app.post('/api/chatgpt', async (req,res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega OPENAI_KEY en Railway Variables → platform.openai.com' });
  try {
    const reply = await apiPago('https://api.openai.com/v1/chat/completions', key, 'gpt-4o', req.body.history, req.body.text);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: 'ChatGPT: ' + e.message }); }
});

// ══════════════════════════════════════
// DEEPSEEK — (pago)
// ══════════════════════════════════════
app.post('/api/deepseek', async (req,res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega DEEPSEEK_KEY en Railway Variables → platform.deepseek.com' });
  try {
    const reply = await apiPago('https://api.deepseek.com/chat/completions', key, 'deepseek-chat', req.body.history, req.body.text);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: 'DeepSeek: ' + e.message }); }
});

// ══════════════════════════════════════
// GROK — xAI (pago)
// ══════════════════════════════════════
app.post('/api/grok', async (req,res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega GROK_KEY en Railway Variables → console.x.ai' });
  try {
    const reply = await apiPago('https://api.x.ai/v1/chat/completions', key, 'grok-2-latest', req.body.history, req.body.text);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: 'Grok: ' + e.message }); }
});

// ══════════════════════════════════════
// STATUS
// ══════════════════════════════════════
app.get('/api/status', (req,res) => {
  const or = !!(process.env.OPENROUTER_KEY && process.env.OPENROUTER_KEY.length > 20 && !process.env.OPENROUTER_KEY.includes('pon-tu-clave'));
  res.json({
    llama: or, mistral: or, gemma: or, qwen: or,
    chatgpt:  !!process.env.OPENAI_KEY,
    deepseek: !!process.env.DEEPSEEK_KEY,
    grok:     !!process.env.GROK_KEY
  });
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  const or = process.env.OPENROUTER_KEY && !process.env.OPENROUTER_KEY.includes('pon-tu-clave');
  console.log(`\n  🧠 IA-NEXO corriendo en puerto ${PORT}`);
  console.log(`  OpenRouter: ${or ? '✅ OK' : '❌ Falta OPENROUTER_KEY en Variables'}\n`);
});