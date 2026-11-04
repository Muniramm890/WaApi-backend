'use strict';
const { graph } = require('./graph');
const { E } = require('../lib/errors');

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];
const TYPES = ['text', 'template', 'interactive', 'location', 'contacts', 'reaction', ...MEDIA_TYPES];

const preview = (s, n = 480) => (s === undefined || s === null ? null : String(s).slice(0, n));

// Validate + build the Cloud API payload. Returns { payload, preview, templateName?, templateLang? }.
function build(input, to) {
  const type = input.type || (input.template ? 'template' : input.text ? 'text' : MEDIA_TYPES.find((t) => input[t]));
  if (!TYPES.includes(type)) throw E.bad(`"type" must be one of: ${TYPES.join(', ')}`);
  const p = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type };
  if (input.context_wamid) p.context = { message_id: String(input.context_wamid) };
  let pv; let tplName; let tplLang;

  if (type === 'text') {
    const t = input.text;
    const body = typeof t === 'string' ? t : t && t.body;
    if (!body || typeof body !== 'string') throw E.bad('"text.body" is required');
    if (body.length > 4096) throw E.bad('Text body is limited to 4096 characters');
    p.text = { body, preview_url: !!(t && t.preview_url) }; pv = body;
  } else if (type === 'template') {
    const t = input.template || {};
    if (!t.name || typeof t.name !== 'string') throw E.bad('"template.name" is required');
    const lang = typeof t.language === 'string' ? t.language : t.language && t.language.code;
    if (!lang) throw E.bad('"template.language" (e.g. "en_US") is required');
    p.template = { name: t.name, language: { code: lang } };
    if (t.components !== undefined) { if (!Array.isArray(t.components)) throw E.bad('"template.components" must be an array'); p.template.components = t.components; }
    tplName = t.name; tplLang = lang; pv = `[template] ${t.name}`;
  } else if (MEDIA_TYPES.includes(type)) {
    const m = input[type];
    if (!m || (!m.id && !m.link)) throw E.bad(`"${type}" needs "id" (uploaded media) or "link" (public https URL)`);
    if (m.link && !/^https:\/\//i.test(m.link)) throw E.bad(`"${type}.link" must be an https URL`);
    p[type] = {}; for (const k of ['id', 'link', 'caption', 'filename']) if (m[k]) p[type][k] = String(m[k]);
    if (!['image', 'video', 'document'].includes(type)) delete p[type].caption;
    if (type !== 'document') delete p[type].filename;
    pv = `[${type}] ${m.caption || m.filename || ''}`.trim();
  } else if (type === 'location') {
    const l = input.location || {};
    if (typeof l.latitude !== 'number' || typeof l.longitude !== 'number') throw E.bad('"location.latitude" and "location.longitude" must be numbers');
    p.location = { latitude: l.latitude, longitude: l.longitude, name: l.name, address: l.address }; pv = `[location] ${l.name || ''}`.trim();
  } else if (type === 'contacts') {
    if (!Array.isArray(input.contacts) || !input.contacts.length) throw E.bad('"contacts" must be a non-empty array');
    p.contacts = input.contacts; pv = '[contacts]';
  } else if (type === 'reaction') {
    const r = input.reaction || {};
    if (!r.message_id) throw E.bad('"reaction.message_id" is required');
    p.reaction = { message_id: String(r.message_id), emoji: r.emoji || '' }; pv = `[reaction] ${r.emoji || ''}`;
  } else if (type === 'interactive') {
    const i = input.interactive;
    if (!i || !i.type || !i.body) throw E.bad('"interactive" needs "type" (button|list|cta_url|flow...) and "body"');
    p.interactive = i; pv = `[interactive] ${preview(i.body.text, 200) || ''}`;
  }
  return { type, payload: p, preview: preview(pv), templateName: tplName, templateLang: tplLang };
}

const sendRaw = (phoneNumberId, token, payload) => graph('POST', `${phoneNumberId}/messages`, { token, body: payload, retries: 0, timeout: 25000 });
const markRead = (phoneNumberId, token, wamid, typing = false) => graph('POST', `${phoneNumberId}/messages`, {
  token, body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid, ...(typing ? { typing_indicator: { type: 'text' } } : {}) },
});

// ---- media ----
async function uploadMedia(phoneNumberId, token, buffer, mime, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), filename || 'upload');
  return graph('POST', `${phoneNumberId}/media`, { token, form, timeout: 60000 });
}
const getMediaInfo = (mediaId, token) => graph('GET', mediaId, { token });
async function downloadMedia(mediaUrl, token) { return graph('GET', mediaUrl, { token, raw: true, timeout: 60000 }); }
const deleteMedia = (mediaId, token) => graph('DELETE', mediaId, { token });

module.exports = { build, sendRaw, markRead, uploadMedia, getMediaInfo, downloadMedia, deleteMedia, TYPES, MEDIA_TYPES };
