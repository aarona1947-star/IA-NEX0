'use strict';

var jwt    = require('jsonwebtoken');
var config = require('../config');
var db     = require('../db');

// ─── JWT AUTH ───
function auth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Inicia sesion para continuar.' });
  try {
    req.user = jwt.verify(token, config.SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Sesion expirada.' });
  }
}

// ─── PLAN + DAILY LIMIT CHECK ───
function checkPlan(req, res, next) {
  db.getUser(req.user.email, function(err, user) {
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado.' });

    var now     = new Date();
    var isPro   = user.plan === 'pro'   && user.planExpiry  && new Date(user.planExpiry)  > now;
    var isTrial = user.trialExpiry && new Date(user.trialExpiry) > now;

    req.isPro         = isPro || isTrial;
    req.user.plan     = isPro ? 'pro' : (isTrial ? 'trial' : 'free');

    if (req.isPro) return next();

    // Plan free: verificar límite diario
    db.getTodayUsage(req.user.email, function(count) {
      if (count >= config.FREE_LIMIT) {
        return res.status(429).json({
          error:        'Llegaste al limite de ' + config.FREE_LIMIT + ' mensajes hoy.',
          limitReached: true,
          plan:         'free',
          count:        count,
          limit:        config.FREE_LIMIT
        });
      }
      req.msgCount = count;
      next();
    });
  });
}

// ─── ADMIN KEY CHECK ───
function adminAuth(req, res, next) {
  var key = req.headers['x-admin-key'] || '';
  if (key !== config.ADMIN_KEY)
    return res.status(403).json({ error: 'No autorizado.' });
  next();
}

module.exports = { auth, checkPlan, adminAuth };
