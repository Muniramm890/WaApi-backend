'use strict';
const cfg = require('../config');
// Normalise to WhatsApp "wa_id": digits only, with country code, 8-15 digits.
function normalizeWaId(input) {
  if (input === undefined || input === null) return null;
  let d = String(input).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = cfg.defaultCountryCode + d;
  else if (d.length === 11 && d.startsWith('0')) d = cfg.defaultCountryCode + d.slice(1);
  if (d.length < 8 || d.length > 15) return null;
  return d;
}
module.exports = { normalizeWaId };
