require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SISTEMA = 'Eres IA-NEXO, un asistente de inteligencia artificial avanzado. Responde SIEMPRE en español, de forma clara, precisa y útil.';

async function llamarGemini(history, text) {
  const key = (process.env.GEMINI_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) throw new Error('Agrega tu GEMINI_KEY en .env — gratis en aistudio.google.com');
  const historial = (history || []).slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const modelos = ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.0-flash-lite','gemini-1.5-flash'];
  for (const modelo of modelos) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`, {
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
      if (json.error) { console.log(`[skip] ${modelo}: ${json.error.message}`); continue; }
      const reply = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!reply) continue;
      console.log(`✅ Gemini: ${modelo}`);
      return reply;
    } catch (e) {
      console.log(`[err] ${modelo}: ${e.message}`);
    }
  }
  throw new Error('Gemini: todos los modelos fallaron. Verifica tu clave en aistudio.google.com');
}

async function llamarHF(history, text, modelos) {
  const key = (process.env.HF_KEY || '').trim();
  if (!key || key.startsWith('PEGA_')) throw new Error('Agrega tu HF_KEY en .env — token gratis en huggingface.co/settings/tokens');
  const errores = [];
  for (const modelo of modelos) {
    try {
      const r = await fetch(`https://api-inference.huggingface.co/models/${modelo}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelo,
          messages: [{ role:'system', content:SISTEMA }, ...(history||[]).slice(-10), { role:'user', content:text }],
          max_tokens: 800, temperature: 0.7, stream: false
        })
      });
      const raw = await r.text();
      let json;
      try { json = JSON.parse(raw); } catch { errores.push(`${modelo.split('/')[1]}: no válido`); continue; }
      if (json.error) { errores.push(`${modelo.split('/')[1]}: ${(typeof json.error==='string'?json.error:json.error.message||'error').slice(0,50)}`); continue; }
      const reply = json.choices?.[0]?.message?.content?.trim();
      if (!reply) { errores.push(`${modelo.split('/')[1]}: vacío`); continue; }
      console.log(`✅ HF: ${modelo}`);
      return reply;
    } catch (e) {
      errores.push(`${modelo.split('/')[1]}: ${e.message.slice(0,40)}`);
    }
  }
  throw new Error(errores.slice(0,3).join(' | ') || 'Sin respuesta');
}

const HF = {
  zephyr:  ['HuggingFaceH4/zephyr-7b-beta','HuggingFaceH4/zephyr-7b-alpha'],
  mistral: ['mistralai/Mistral-7B-Instruct-v0.3','mistralai/Mistral-7B-Instruct-v0.2'],
  qwen:    ['Qwen/Qwen2.5-7B-Instruct','Qwen/Qwen2.5-3B-Instruct'],
  phi:     ['microsoft/Phi-3-mini-4k-instruct','microsoft/Phi-3.5-mini-instruct'],
};

app.post('/api/gemini',       async (req,res) => { try { res.json({reply: await llamarGemini(req.body.history, req.body.text)}); } catch(e) { res.status(500).json({error:'🔴 '+e.message}); }});
app.post('/api/llama',        async (req,res) => { try { res.json({reply: await llamarHF(req.body.history, req.body.text, HF.zephyr)}); } catch(e) { res.status(500).json({error:'🦙 '+e.message}); }});
app.post('/api/mistral-free', async (req,res) => { try { res.json({reply: await llamarHF(req.body.history, req.body.text, HF.mistral)}); } catch(e) { res.status(500).json({error:'🌊 '+e.message}); }});
app.post('/api/gemma',        async (req,res) => { try { res.json({reply: await llamarHF(req.body.history, req.body.text, HF.qwen)}); } catch(e) { res.status(500).json({error:'🌸 '+e.message}); }});
app.post('/api/qwen',         async (req,res) => { try { res.json({reply: await llamarHF(req.body.history, req.body.text, HF.phi)}); } catch(e) { res.status(500).json({error:'💎 '+e.message}); }});

app.post('/api/chatgpt', async (req,res) => {
  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(400).json({error:'Agrega OPENAI_KEY en .env'});
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'gpt-4o',messages:[{role:'system',content:SISTEMA},...(req.body.history||[]).slice(-12),{role:'user',content:req.body.text}],max_tokens:1500})});
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message||r.status);
    res.json({reply:json.choices[0].message.content});
  } catch(e) { res.status(500).json({error:'ChatGPT: '+e.message}); }
});

app.post('/api/deepseek', async (req,res) => {
  const key = process.env.DEEPSEEK_KEY;
  if (!key) return res.status(400).json({error:'Agrega DEEPSEEK_KEY en .env'});
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'system',content:SISTEMA},...(req.body.history||[]).slice(-12),{role:'user',content:req.body.text}],max_tokens:1500})});
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message||r.status);
    res.json({reply:json.choices[0].message.content});
  } catch(e) { res.status(500).json({error:'DeepSeek: '+e.message}); }
});

app.post('/api/grok', async (req,res) => {
  const key = process.env.GROK_KEY;
  if (!key) return res.status(400).json({error:'Agrega GROK_KEY en .env'});
  try {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'grok-2-latest',messages:[{role:'system',content:SISTEMA},...(req.body.history||[]).slice(-12),{role:'user',content:req.body.text}],max_tokens:1500})});
    const json = await r.json();
    if (!r.ok) throw new Error(json.error?.message||r.status);
    res.json({reply:json.choices[0].message.content});
  } catch(e) { res.status(500).json({error:'Grok: '+e.message}); }
});

// ══ IMÁGENES — solo genera la URL, el navegador carga la imagen directo ══
app.post('/api/imagen', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Falta el prompt' });
  const promptLimpio = encodeURIComponent(prompt.slice(0, 400));
  const seed = Math.floor(Math.random() * 999999);
  const imageUrl = `https://image.pollinations.ai/prompt/${promptLimpio}?width=768&height=768&seed=${seed}&nologo=true&nofeed=true`;
  res.json({ imageUrl });
});

app.get('/api/status', (req,res) => {
  const hf = !!(process.env.HF_KEY && !process.env.HF_KEY.startsWith('PEGA_'));
  const gemini = !!(process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_'));
  res.json({gemini, llama:hf, mistral:hf, gemma:hf, qwen:hf, chatgpt:!!process.env.OPENAI_KEY, deepseek:!!process.env.DEEPSEEK_KEY, grok:!!process.env.GROK_KEY});
});

app.get('/api/test', async (req,res) => {
  const results = {};
  try { results.gemini = await llamarGemini([], 'Di: hola'); } catch(e) { results.gemini_error = e.message; }
  res.json(results);
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  const hf = process.env.HF_KEY && !process.env.HF_KEY.startsWith('PEGA_');
  const gemini = process.env.GEMINI_KEY && !process.env.GEMINI_KEY.startsWith('PEGA_');
  console.log('\n  ┌──────────────────────────────┐');
  console.log('  │     🧠  IA-NEXO  v4.1        │');
  console.log(`  │  http://localhost:${PORT}        │`);
  console.log('  └──────────────────────────────┘\n');
  console.log(`  Gemini:      ${gemini?'✅':'❌  Agrega GEMINI_KEY en .env'}`);
  console.log(`  HuggingFace: ${hf?'✅':'❌  Agrega HF_KEY en .env'}`);
  console.log(`  Imágenes:    ✅ Pollinations AI (gratis)\n`);
});