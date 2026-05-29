'use strict';

var express = require('express');
var router  = express.Router();

var config  = require('../config');
var db      = require('../db');
var { auth, checkPlan } = require('../middleware/auth');
var agents  = require('../agents');

// ─── RESPUESTA HELPER ───
function sendReply(req, res, reply, imageUrl) {
  if (!req.isPro) db.incrementUsage(req.user.email);
  var payload = {
    reply:     reply,
    plan:      req.user.plan,
    todayMsgs: (req.msgCount || 0) + 1,
    freeLimit: config.FREE_LIMIT
  };
  if (imageUrl) payload.imageUrl = imageUrl;
  res.json(payload);
}

// ─── AGENTES ESTÁNDAR: general, sabio, saber, codigo ───
['general', 'sabio', 'saber', 'codigo'].forEach(function(agente) {
  router.post('/' + agente, auth, checkPlan, function(req, res) {
    agents.llamarGemini(
      req.body.history || [],
      req.body.text    || '',
      agente,
      req.body.file    || null,
      function(err, reply) {
        if (err) return res.status(500).json({ error: err.message });
        sendReply(req, res, reply);
      }
    );
  });
});

// ─── CREATIVO — detección de imagen automática ───
router.post('/creativo', auth, checkPlan, function(req, res) {
  var text = req.body.text || '';

  if (agents.isImageRequest(text)) {
    var seed     = Math.floor(Math.random() * 999999);
    var imgPrompt = text + ', high quality, detailed, professional, 4k';
    var imageUrl  = 'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(imgPrompt) +
      '?width=768&height=768&seed=' + seed + '&nologo=true&enhance=true';

    return sendReply(
      req, res,
      '🎨 ¡Aquí está tu imagen! La generé con IA a partir de tu descripción.\n\n_Tip: Si quieres otra versión, pídela de nuevo o agrega más detalles._',
      imageUrl
    );
  }

  agents.llamarGemini(
    req.body.history || [],
    text,
    'creativo',
    req.body.file || null,
    function(err, reply) {
      if (err) return res.status(500).json({ error: err.message });
      sendReply(req, res, reply);
    }
  );
});

// ─── GENERACIÓN DE IMAGEN DIRECTA ───
router.post('/imagen', auth, function(req, res) {
  var prompt = (req.body.prompt || '').slice(0, 400);
  if (!prompt) return res.status(400).json({ error: 'Describe la imagen.' });
  res.json({
    imageUrl: 'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(prompt) +
      '?width=768&height=768&seed=' + Math.floor(Math.random() * 999999) + '&nologo=true'
  });
});

// ─── CONVERSACIONES EN LA NUBE ───
router.get('/conversations', auth, function(req, res) {
  if (!db.isMongoActive()) return res.json({ conversations: [] });
  db.getMongo().collection('conversations')
    .find({ userId: req.user.id })
    .sort({ updatedAt: -1 })
    .limit(20)
    .toArray(function(err, docs) { res.json({ conversations: docs || [] }); });
});

router.post('/conversations', auth, function(req, res) {
  if (!db.isMongoActive()) return res.json({ ok: false });
  var conv = req.body;
  if (!conv.id) return res.status(400).json({ error: 'ID requerido.' });
  db.getMongo().collection('conversations').updateOne(
    { id: conv.id, userId: req.user.id },
    { $set: {
        id:        conv.id,
        userId:    req.user.id,
        title:     (conv.title || 'Conversacion').slice(0, 60),
        hist:      (conv.hist  || []).slice(-30),
        agent:     conv.agent  || 'general',
        updatedAt: new Date().toISOString()
    }},
    { upsert: true },
    function(err) { res.json({ ok: !err }); }
  );
});

router.delete('/conversations/:id', auth, function(req, res) {
  if (!db.isMongoActive()) return res.json({ ok: false });
  db.getMongo().collection('conversations').deleteOne(
    { id: req.params.id, userId: req.user.id },
    function(err) { res.json({ ok: !err }); }
  );
});

// ─── CHATS (historial en nube) ───
router.post('/chats/save', auth, function(req, res) {
  var chat = req.body.chat;
  if (!chat || !chat.id) return res.status(400).json({ error: 'Chat invalido.' });
  if (!db.isMongoActive()) return res.json({ ok: true });

  chat.email     = req.user.email;
  chat.updatedAt = new Date().toISOString();

  db.getMongo().collection('chats').updateOne(
    { id: chat.id, email: req.user.email },
    { $set: chat },
    { upsert: true },
    function(err) { res.json({ ok: !err }); }
  );
});

router.get('/chats/list', auth, function(req, res) {
  if (!db.isMongoActive()) return res.json({ chats: [] });
  db.getMongo().collection('chats')
    .find({ email: req.user.email }, { projection: { _id: 0, password: 0 } })
    .sort({ updatedAt: -1 })
    .limit(20)
    .toArray(function(err, docs) { res.json({ chats: docs || [] }); });
});

router.delete('/chats/:id', auth, function(req, res) {
  if (!db.isMongoActive()) return res.json({ ok: true });
  db.getMongo().collection('chats').deleteOne(
    { id: req.params.id, email: req.user.email },
    function(err) { res.json({ ok: !err }); }
  );
});

module.exports = router;
