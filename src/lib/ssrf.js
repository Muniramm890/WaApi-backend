'use strict';
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const cfg = require('../config');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(l)) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
  }
  return false;
}

// DNS lookup that refuses private/internal addresses at connect time (defeats DNS rebinding).
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => (cfg.prod ? !isPrivateIp(a.address) : true));
    if (!ok.length) return cb(new Error('Destination resolves to a private or reserved address'));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function validateWebhookUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'Invalid URL'; }
  if (raw.length > 500) return 'URL too long';
  if (!['http:', 'https:'].includes(u.protocol)) return 'Only http(s) URLs are allowed';
  if (cfg.prod && u.protocol !== 'https:') return 'Webhook URL must use https';
  if (u.username || u.password) return 'Credentials in URL are not allowed';
  if (cfg.prod && net.isIP(u.hostname) && isPrivateIp(u.hostname)) return 'Private addresses are not allowed';
  if (cfg.prod && /^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return 'Internal hostnames are not allowed';
  return null;
}

function postJson(url, bodyStr, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), 'User-Agent': 'WA-Platform-Webhooks/1.0', ...headers },
      lookup: guardedLookup, timeout: timeoutMs,
    }, (res) => {
      let data = ''; res.on('data', (c) => { if (data.length < 2000) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end(bodyStr);
  });
}
module.exports = { validateWebhookUrl, postJson, isPrivateIp };
