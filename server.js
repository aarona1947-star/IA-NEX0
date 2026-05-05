require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial avanzado. Responde SIEMPRE en español, de forma clara, precisa y útil.';

// ════════════════════════════════════════════════
// GEMINI — Google AI Studio (GRATIS sin tarjeta)
// Clave en: aistudio.google.com > Get API Key
// ════════════════════════════════════════════════
async function llamarGemini(history, text) {
  const key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) {
    throw new Error('Agrega tu GEMINI_KEY en el archivo .env — gratis en aistudio.google.com');
  }

  const historial = (history || []).slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  // Intentar modelos Gemini en orden
const modelos = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
  ];

  for (const modelo of modelos) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SISTEMA }] },
          contents: [...historial, { role: 'user', parts: [{ text }] }],
          generationConfig: { maxOutputTokens: 1200, temperature: 0.7 }
        })
      });

      const raw = await r.text();
      let json;
      try { json = JSON.parse(raw); } catch { continue; }

      if (json.error) {
        console.log(`[Gemini skip] ${modelo}: ${json.error.message}`);
        continue;
      }

      const reply = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!reply) continue;

      console.log(`✅ Gemini: ${modelo}`);
      return reply;
    } catch (e) {
      console.log(`[Gemini err] ${modelo}: ${e.message}`);
    }
  }
  throw new Error('Gemini: todos los modelos fallaron. Verifica tu clave en aistudio.google.com');
}

// ════════════════════════════════════════════════
// HUGGINGFACE — 100% gratis (token en huggingface.co/settings/tokens)
// Usa modelos abiertos (no gated)
// ════════════════════════════════════════════════
async function llamarHF(history, text, modelos) {
  const key = (process.env.HF_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) {
    throw new Error('Agrega tu HF_KEY en el archivo .env — token gratis en huggingface.co/settings/tokens');
  }

  const historial = (history || []).slice(-10);
  const errores = [];

  for (const modelo of modelos) {
    try {
      // Intentar con el endpoint de chat completions (más moderno)
      const url = `https://api-inference.huggingface.co/models/${modelo}/v1/chat/completions`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: 'system', content: SISTEMA },
            ...historial,
            { role: 'user', content: text }
          ],
          max_tokens: 800,
          temperature: 0.7,
          stream: false
        })
      });

      // Leer respuesta como texto primero para evitar errores de JSON
      const raw = await r.text();
      let json;
      try { json = JSON.parse(raw); } catch {
        errores.push(`${modelo.split('/')[1]}: respuesta no válida`);
        continue;
      }

      if (json.error) {
        const msg = typeof json.error === 'string' ? json.error : json.error.message || 'error';
        // Si el modelo está cargando, saltar
        if (msg.includes('loading') || msg.includes('Load')) {
          errores.push(`${modelo.split('/')[1]}: cargando...`);
        } else {
          errores.push(`${modelo.split('/')[1]}: ${msg.slice(0, 50)}`);
        }
        continue;
      }

      const reply = json.choices?.[0]?.message?.content?.trim();
      if (!reply) { errores.push(`${modelo.split('/')[1]}: vacío`); continue; }

      console.log(`✅ HuggingFace: ${modelo}`);
      return reply;
    } catch (e) {
      errores.push(`${modelo.split('/')[1]}: ${e.message.slice(0, 40)}`);
    }
  }

  throw new Error(errores.slice(0, 3).join(' | ') || 'Sin respuesta de HuggingFace');
}

// Modelos de HuggingFace que NO requieren aceptar licencia
const HF_MODELOS = {
  zephyr:  ['HuggingFaceH4/zephyr-7b-beta', 'HuggingFaceH4/zephyr-7b-alpha'],
  mistral: ['mistralai/Mistral-7B-Instruct-v0.3', 'mistralai/Mistral-7B-Instruct-v0.2'],
  qwen:    ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-3B-Instruct', 'Qwen/Qwen2-7B-Instruct'],
  phi:     ['microsoft/Phi-3-mini-4k-instruct', 'microsoft/Phi-3.5-mini-instruct'],
};

// ════════════════════════════════════════════════
// RUTAS DE LA API
// ════════════════════════════════════════════════

// Gemini — Google (gratis con clave de aistudio)
app.post('/api/gemini', async (req, res) => {
  try {
    const reply = await llamarGemini(req.body.history, req.body.text);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: '🔴 ' + e.message }); }
});

// Zephyr — HuggingFace (gratis con token)
app.post('/api/llama', async (req, res) => {
  try {
    const reply = await llamarHF(req.body.history, req.body.text, HF_MODELOS.zephyr);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: '🦙 ' + e.message }); }
});

// Mistral — HuggingFace (gratis con token)
app.post('/api/mistral-free', async (req, res) => {
  try {
    const reply = await llamarHF(req.body.history, req.body.text, HF_MODELOS.mistral);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: '🌊 ' + e.message }); }
});

// Qwen — HuggingFace (gratis con token)
app.post('/api/gemma', async (req, res) => {
  try {
    const reply = await llamarHF(req.body.history, req.body.text, HF_MODELOS.qwen);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: '🌸 ' + e.message }); }
});

// Phi — HuggingFace (gratis con token)
app.post('/api/qwen', async (req, res) => {
  try {
    const reply = await llamarHF(req.body.history, req.body.text, HF_MODELOS.phi);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: '💎 ' + e.message }); }
});

// ChatGPT — requiere clave de pago
app.post('/api/chatgpt', async (req, res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({ error: 'ChatGPT necesita OPENAI_KEY en .env → platform.openai.com' });
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role:'system', content:SISTEMA }, ...(req.body.history||[]).slice(-12), { role:'user', content:req.body.text }], max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'ChatGPT: ' + e.message }); }
});

// DeepSeek — requiere clave de pago
app.post('/api/deepseek', async (req, res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({ error: 'DeepSeek necesita DEEPSEEK_KEY en .env → platform.deepseek.com' });
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role:'system', content:SISTEMA }, ...(req.body.history||[]).slice(-12), { role:'user', content:req.body.text }], max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'DeepSeek: ' + e.message }); }
});

// Grok — requiere clave de pago
app.post('/api/grok', async (req, res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({ error: 'Grok necesita GROK_KEY en .env → console.x.ai' });
  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'grok-2-latest', messages: [{ role:'system', content:SISTEMA }, ...(req.body.history||[]).slice(-12), { role:'user', content:req.body.text }], max_tokens: 1500 })
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message || r.status);
    res.json({ reply: json.choices[0].message.content });
  } catch (e) { res.status(500).json({ error: 'Grok: ' + e.message }); }
});

// Status
app.get('/api/status', (req, res) => {
  const hf     = !!(process.env.HF_KEY     && !process.env.HF_KEY.startsWith('PEGA_'));
  const gemini = !!(process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_'));
  res.json({
    gemini,
    llama:    hf,
    mistral:  hf,
    gemma:    hf,
    qwen:     hf,
    chatgpt:  !!process.env.OPENAI_KEY,
    deepseek: !!process.env.DEEPSEEK_KEY,
    grok:     !!process.env.GROK_KEY,
  });
});

// Test
app.get('/api/test', async (req, res) => {
  const results = {};
  // Test Gemini
  try {
    results.gemini = await llamarGemini([], 'Di: hola');
  } catch (e) { results.gemini_error = e.message; }
  // Test HF
  try {
    results.hf = await llamarHF([], 'Di: hola', HF_MODELOS.zephyr);
  } catch (e) { results.hf_error = e.message; }
  res.json(results);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  const hf     = process.env.HF_KEY     && !process.env.HF_KEY.startsWith('PEGA_');
  const gemini = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  ┌──────────────────────────────┐');
  console.log('  │     🧠  IA-NEXO  v4.0        │');
  console.log(`  │  http://localhost:${PORT}        │`);
  console.log('  └──────────────────────────────┘\n');
  console.log(`  Gemini (Google):    ${gemini ? '✅' : '❌  Agrega GEMINI_KEY en .env'}`);
  console.log(`  HuggingFace:        ${hf     ? '✅' : '❌  Agrega HF_KEY en .env'}`);
  if (!gemini && !hf) {
    console.log('\n  ⚠️  Sin claves configuradas.');
    console.log('  Abre .env y agrega tus claves.\n');
  }
});
