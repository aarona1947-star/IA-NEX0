'use strict';

var express = require('express');
var router  = express.Router();

var db     = require('../db');
var { adminAuth } = require('../middleware/auth');

// Aplicar autenticación de admin a todas las rutas de este router
router.use(adminAuth);

// ─── POST /admin/activate ───
router.post('/activate', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var days  = parseInt(req.body.days || '30');
  if (!email) return res.status(400).json({ error: 'Email requerido.' });

  db.getUser(email, function(err, user) {
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    var base = (user.plan === 'pro' && user.planExpiry && new Date(user.planExpiry) > new Date())
      ? new Date(user.planExpiry) : new Date();
    var expiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    db.saveUser(email, { plan: 'pro', planExpiry: expiry.toISOString() }, function() {
      res.json({ ok: true, email, plan: 'pro', expiresAt: expiry.toISOString(), days });
    });
  });
});

// ─── GET /admin/users ───
router.get('/users', function(req, res) {
  if (db.isMongoActive()) {
    db.getMongo().collection('users')
      .find({}, { projection: { password: 0 } })
      .toArray(function(err, users) {
        var now = new Date();
        var result = (users || []).map(function(u) {
          return {
            nombre:      u.nombre,
            email:       u.email,
            plan:        u.plan === 'pro' && u.planExpiry && new Date(u.planExpiry) > now ? 'pro' : 'free',
            planExpiry:  u.planExpiry,
            trialExpiry: u.trialExpiry,
            refCode:     u.refCode,
            refCount:    u.refCount || 0,
            creado:      u.creado
          };
        });
        res.json({ total: result.length, users: result });
      });
  } else {
    var fs   = require('fs');
    var path = require('path');
    try {
      var users  = JSON.parse(fs.readFileSync(path.join(__dirname, '../../users.json'), 'utf8'));
      var result = Object.values(users).map(function(u) {
        return { nombre: u.nombre, email: u.email, plan: u.plan, creado: u.creado };
      });
      res.json({ total: result.length, users: result });
    } catch(e) { res.json({ total: 0, users: [] }); }
  }
});

// ─── GET /admin/stats ───
router.get('/stats', function(req, res) {
  if (!db.isMongoActive())
    return res.json({ totalMsgs: 0, todayMsgs: 0, todayActiveUsers: 0, totalUsers: 0 });

  var mongo = db.getMongo();
  var now   = new Date();
  var today = now.toISOString().slice(0, 10);
  var week  = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  Promise.all([
    new Promise(function(r) {
      mongo.collection('usage').aggregate([{ $group: { _id: null, total: { $sum: '$count' } } }])
        .toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); });
    }),
    new Promise(function(r) {
      mongo.collection('usage').aggregate([
        { $match: { date: today } },
        { $group: { _id: null, total: { $sum: '$count' } } }
      ]).toArray(function(e, d) { r(d && d[0] ? d[0].total : 0); });
    }),
    new Promise(function(r) {
      mongo.collection('users').countDocuments({}, function(e, n) { r(n || 0); });
    }),
    new Promise(function(r) {
      mongo.collection('usage').distinct('email', { date: today }, function(e, d) { r(d ? d.length : 0); });
    }),
    new Promise(function(r) {
      mongo.collection('users').countDocuments({ plan: 'pro', planExpiry: { $gt: now.toISOString() } },
        function(e, n) { r(n || 0); });
    }),
    new Promise(function(r) {
      mongo.collection('usage').aggregate([
        { $match: { date: { $gte: week } } },
        { $group: { _id: '$date', total: { $sum: '$count' } } },
        { $sort: { _id: 1 } }
      ]).toArray(function(e, d) { r(d || []); });
    })
  ]).then(function(results) {
    res.json({
      totalMsgs:       results[0],
      todayMsgs:       results[1],
      totalUsers:      results[2],
      todayActiveUsers: results[3],
      proUsers:        results[4],
      weeklyMsgs:      results[5],
      revenue:         (results[4] * 4.99).toFixed(2)
    });
  }).catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ─── POST /admin/codes ───
router.post('/codes', function(req, res) {
  if (!db.isMongoActive()) return res.status(503).json({ error: 'MongoDB requerido.' });
  var code    = (req.body.code || '').toUpperCase().trim();
  var days    = parseInt(req.body.days    || '30');
  var maxUses = parseInt(req.body.maxUses || '100');
  if (!code) return res.status(400).json({ error: 'Codigo requerido.' });

  db.getMongo().collection('codes').updateOne(
    { code },
    { $set: { code, days, maxUses, uses: 0, active: true, createdAt: new Date().toISOString() } },
    { upsert: true },
    function(err) { res.json({ ok: !err, code, days, maxUses }); }
  );
});

// ─── GET /admin/codes ───
router.get('/codes', function(req, res) {
  if (!db.isMongoActive()) return res.json({ codes: [] });
  db.getMongo().collection('codes').find({}).toArray(function(err, docs) {
    res.json({ codes: docs || [] });
  });
});

module.exports = router;
