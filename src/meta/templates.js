'use strict';
const { graph, graphAll } = require('./graph');
const { E } = require('../lib/errors');

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
const FIELDS = 'id,name,language,category,status,components,rejected_reason,quality_score,sub_category,parameter_format';

const list = (wabaId, token) => graphAll(`${wabaId}/message_templates`, { token, query: { fields: FIELDS } });
const get = (templateId, token) => graph('GET', templateId, { token, query: { fields: FIELDS } });
const create = (wabaId, token, body) => graph('POST', `${wabaId}/message_templates`, { token, body });
const edit = (templateId, token, body) => graph('POST', templateId, { token, body });
// delete by name removes all languages; pass hsm_id to delete one language only
const remove = (wabaId, token, name, hsmId) => graph('DELETE', `${wabaId}/message_templates`, { token, query: { name, hsm_id: hsmId } });

function validate(input) {
  const name = String(input.name || '');
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw E.bad('Template "name" must be lowercase letters, numbers and underscores');
  if (!CATEGORIES.includes(input.category)) throw E.bad(`"category" must be one of: ${CATEGORIES.join(', ')}`);
  if (!input.language || !/^[a-z]{2}(_[A-Z]{2})?$/.test(input.language)) throw E.bad('"language" must look like en or en_US');
  if (!Array.isArray(input.components) || !input.components.length) throw E.bad('"components" must be a non-empty array');
  const body = input.components.find((c) => String(c.type).toUpperCase() === 'BODY');
  if (input.category !== 'AUTHENTICATION' && (!body || !body.text)) throw E.bad('A BODY component with "text" is required');
  return { name, category: input.category, language: input.language, components: input.components, ...(input.parameter_format ? { parameter_format: input.parameter_format } : {}), ...(input.allow_category_change !== undefined ? { allow_category_change: !!input.allow_category_change } : {}) };
}
module.exports = { list, get, create, edit, remove, validate, CATEGORIES };
