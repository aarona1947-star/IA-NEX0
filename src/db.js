'use strict';

var fs   = require('fs');
var path = require('path');

// ─── DB STATE ───
var useMongo = false;
var mongoDB  = null;
var DB_FILE  = path.join(__dirname, '..', 'users.json');

// ─── MONGO INIT ───
function initMongo(uri) {
  if (!uri) return;
  try {
    var MongoClient = require('mongodb').MongoClient;
    MongoClient.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
      .then(function(client) {
        mongoDB  = client.db('nexo');
        useMongo = true;
        console.log('  MongoDB: Conectado');
        mongoDB.collection('users').createIndex({ email: 1 }, { unique: true }).catch(function(){});
        mongoDB.collection('usage').createIndex({ email: 1, date: 1 }).catch(function(){});
      })
      .catch(function(e) { console.log('  MongoDB error:', e.message); });
  } catch(e) { console.log('  MongoDB no instalado'); }
}

// ─── USER HELPERS ───
function getUser(email, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').findOne({ email: email }, cb);
  } else {
    try {
      var users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      cb(null, users[email] || null);
    } catch(e) { cb(null, null); }
  }
}

function saveUser(email, data, cb) {
  if (useMongo && mongoDB) {
    mongoDB.collection('users').updateOne(
      { email: email },
      { $set: data },
      { upsert: true },
      cb
    );
  } else {
    try {
      var users = {};
      try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
      users[email] = Object.assign(users[email] || {}, data);
      fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
      cb(null);
    } catch(e) { cb(e); }
  }
}

// ─── USAGE HELPERS ───
function getTodayUsage(email, cb) {
  var today = new Date().toISOString().slice(0, 10);
  if (useMongo && mongoDB) {
    mongoDB.collection('usage').findOne({ email: email, date: today }, function(err, doc) {
      cb(doc ? doc.count : 0);
    });
  } else {
    try {
      var usage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'usage.json'), 'utf8'));
      cb(usage[email + '_' + today] || 0);
    } catch(e) { cb(0); }
  }
}

function incrementUsage(email, cb) {
  var today = new Date().toISOString().slice(0, 10);
  if (useMongo && mongoDB) {
    mongoDB.collection('usage').updateOne(
      { email: email, date: today },
      { $inc: { count: 1 } },
      { upsert: true },
      function() { if (cb) cb(); }
    );
  } else {
    try {
      var usageFile = path.join(__dirname, '..', 'usage.json');
      var usage = {};
      try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch(e) {}
      var key = email + '_' + today;
      usage[key] = (usage[key] || 0) + 1;
      fs.writeFileSync(usageFile, JSON.stringify(usage));
    } catch(e) {}
    if (cb) cb();
  }
}

// ─── GETTERS ───
function getMongo()    { return mongoDB; }
function isMongoActive() { return useMongo && !!mongoDB; }

module.exports = {
  initMongo,
  getUser,
  saveUser,
  getTodayUsage,
  incrementUsage,
  getMongo,
  isMongoActive,
};
