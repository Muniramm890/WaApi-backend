'use strict';
const cfg = require('../config');
const log = require('./logger');
let transport;
function getTransport() {
  if (transport !== undefined) return transport;
  transport = null;
  if (cfg.mail.url) {
    try { transport = require('nodemailer').createTransport(cfg.mail.url); }
    catch { log.warn('SMTP_URL set but nodemailer is not installed; emails are only logged'); }
  }
  return transport;
}
async function send({ to, subject, text }) {
  const t = getTransport();
  if (!t) { log.info('email not sent (no SMTP configured)', { to, subject, text }); return false; }
  try { await t.sendMail({ from: cfg.mail.from, to, subject, text }); return true; }
  catch (e) { log.error('email send failed', e); return false; }
}
module.exports = { send };
