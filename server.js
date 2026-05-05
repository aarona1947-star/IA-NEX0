require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial. Responde SIEMPRE en español, de forma clara y útil.';

function msgs(history, text) {
  return [{ role:'system', content:SISTEMA }, ...(history||[]).slice(-14), { role:'user', content:text }];
}

// Llamada a OpenRouter
async function openrouter(history, text, modelos) {
  const key = (process.env.OPENROUTER_KEY || '').trim();
  if (!key || key.length < 20) {
    throw new Error('Falta OPENROUTER_KEY en Railway Variables');
  }

  let errores = [];

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
        body: JSON.stringify({
          model:       modelo,
          messages:    msgs(history, text),
          max_tokens:  1000,
          temperature: 0.7
        })
      });

      const json = await r.json();
      console.log(`[${modelo}] status:${r.status}`, JSON.stringify(json).slice(0,200));

      if (json.error) {
        errores.push(`${modelo}: ${json.error.message || json.error.code}`);
        continue;
      }

      const reply = json.choices?.[0]?.message?.content;
      if (!reply) { errores.push(`${modelo}: respuesta vacía`); continue; }

      console.log(`[OK] ${modelo}`);
      return reply;

    } catch(e) {
      errores.push(`${modelo}: ${e.message}`);
      continue;
    }
  }

  throw new Error('Errores: ' + errores.join(' | '));
}

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

// ══ TEST — muestra el error exacto de OpenRouter ══
app.get('/api/test', async (req, res) => {
  const key = (process.env.OPENROUTER_KEY || '').trim();
  if (!key) return res.json({ ok:false, error:'No hay OPENROUTER_KEY' });

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer':  'https://ia-nex0-production.up.railway.app',
        'X-Title':       'IA-NEXO'
      },
      body: JSON.stringify({
        model:    'meta-llama/llama-3.2-3b-instruct:free',
        messages: [{ role:'user', content:'Di "hola" en español.' }],
        max_tokens: 50
      })
    });
    const json = await r.json();
    res.json({ ok: r.ok, status: r.status, response: json });
  } catch(e) {
    res.json({ ok:false, error: e.message });
  }
});

// ══ LLAMA ══
app.post('/api/llama', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'meta-llama/llama-3.2-3b-instruct:free',
      'meta-llama/llama-3.1-8b-instruct:free',
      'meta-llama/llama-3.2-1b-instruct:free',
      'mistralai/mistral-7b-instruct:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🦙 ' + e.message }); }
});

// ══ MISTRAL ══
app.post('/api/mistral-free', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'mistralai/mistral-7b-instruct:free',
      'mistralai/mistral-7b-instruct-v0.1:free',
      'meta-llama/llama-3.2-3b-instruct:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🌊 ' + e.message }); }
});

// ══ GEMMA ══
app.post('/api/gemma', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'google/gemma-2-9b-it:free',
      'google/gemma-7b-it:free',
      'meta-llama/llama-3.2-3b-instruct:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '💎 ' + e.message }); }
});

// ══ QWEN ══
app.post('/api/qwen', async (req,res) => {
  try {
    const reply = await openrouter(req.body.history, req.body.text, [
      'qwen/qwen-2-7b-instruct:free',
      'qwen/qwen2.5-7b-instruct:free',
      'meta-llama/llama-3.2-3b-instruct:free'
    ]);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: '🌸 ' + e.message }); }
});

// ══ CHATGPT ══
app.post('/api/chatgpt', async (req,res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega OPENAI_KEY en Railway Variables' });
  try { res.json({ reply: await apiPago('https://api.openai.com/v1/chat/completions', key, 'gpt-4o', req.body.history, req.body.text) });
  } catch(e) { res.status(500).json({ error: 'ChatGPT: '+e.message }); }
});

// ══ DEEPSEEK ══
app.post('/api/deepseek', async (req,res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega DEEPSEEK_KEY en Railway Variables' });
  try { res.json({ reply: await apiPago('https://api.deepseek.com/chat/completions', key, 'deepseek-chat', req.body.history, req.body.text) });
  } catch(e) { res.status(500).json({ error: 'DeepSeek: '+e.message }); }
});

// ══ GROK ══
app.post('/api/grok', async (req,res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({ error: 'Agrega GROK_KEY en Railway Variables' });
  try { res.json({ reply: await apiPago('https://api.x.ai/v1/chat/completions', key, 'grok-2-latest', req.body.history, req.body.text) });
  } catch(e) { res.status(500).json({ error: 'Grok: '+e.message }); }
});

// ══ STATUS ══
app.get('/api/status', (req,res) => {
  const or = !!(process.env.OPENROUTER_KEY && process.env.OPENROUTER_KEY.length > 20);
  res.json({ llama:or, mistral:or, gemma:or, qwen:or,
    chatgpt:!!process.env.OPENAI_KEY, deepseek:!!process.env.DEEPSEEK_KEY, grok:!!process.env.GROK_KEY });
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n  🧠 IA-NEXO en puerto ${PORT}`);
  console.log(`  OpenRouter: ${process.env.OPENROUTER_KEY ? '✅' : '❌ Falta OPENROUTER_KEY'}\n`);
});