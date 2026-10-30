'use strict';
/*
 * Regler (docs/PLAN.md §4.5): regelsettene, tillegget per kjøreverk, pauser, forhåndsvisning og historikk.
 * Alle kan se. Å endre krever rollen rules. Formatet står i docs/PROTOKOLL.md §7, og alt sjekkes med
 * lib/record-rules.js (kopien av hmi-core sin) før det lagres.
 */
const rules = require('../../lib/rules');
const { checkRecording } = require('../../lib/record-rules');
const { vehicleByCode } = require('../../lib/auth');
const { preview } = require('../../lib/preview');
const { HttpError } = require('../../lib/errors');

const recording = { type: ['object', 'null'] };
const target = {
  type: 'object', additionalProperties: false,
  properties: { set: { type: 'string', maxLength: 40 }, vehicle: { type: 'string', maxLength: 32 } },
};

module.exports = async function ruleRoutes(app, { db, log, need, who }) {
  app.get('/rulesets', async () => rules.listRuleSets(db));

  app.get('/rulesets/:name', async (req, reply) => {
    const rs = await rules.getRuleSet(db, req.params.name);
    if (!rs) return reply.code(404).send({ error: `no rule set named ${req.params.name}` });
    rs.vehicles = (await db.query('SELECT code FROM vehicle WHERE rule_set_id = $1 ORDER BY code', [rs.id])).rows.map(r => r.code);
    return rs;
  });

  app.put('/rulesets/:name', {
    preHandler: need('rules'),
    schema: { body: { type: 'object', required: ['recording'], additionalProperties: false, properties: { recording: { type: 'object' }, note: { type: 'string', maxLength: 300 } } } },
  }, async req => {
    const r = await rules.setRuleSet(db, req.params.name, req.body.recording, who(req), req.body.note || '');
    log.info(`${who(req)} saved the rule set ${req.params.name} as version ${r.version}`);
    return r;
  });

  app.delete('/rulesets/:name', { preHandler: need('rules') }, async req => {
    await rules.deleteRuleSet(db, req.params.name, who(req));
    return { ok: true };
  });

  // historikken: et regelsett (?set=navn) eller tillegget til et kjøreverk (?vehicle=kv07)
  app.get('/rules/history', async (req, reply) => {
    let where, val;
    if (req.query.vehicle) { where = 'h.vehicle_id = (SELECT id FROM vehicle WHERE code = $1)'; val = req.query.vehicle; }
    else { where = 'h.rule_set_id = (SELECT id FROM rule_set WHERE name = $1)'; val = req.query.set || 'default'; }
    const r = await db.query(`SELECT h.id, h.version, h.changed_at, h.changed_by, h.note, h.recording IS NULL AS removed,
        coalesce(jsonb_array_length(h.recording->'rules'), 0) AS rules, coalesce(jsonb_array_length(h.recording->'pauses'), 0) AS pauses
      FROM rule_history h WHERE ${where} ORDER BY h.id DESC LIMIT 100`, [val]);
    if (!r.rowCount && !(await db.query(req.query.vehicle ? 'SELECT 1 FROM vehicle WHERE code = $1' : 'SELECT 1 FROM rule_set WHERE name = $1', [val])).rowCount) {
      return reply.code(404).send({ error: `no ${req.query.vehicle ? 'vehicle' : 'rule set'} named ${val}` });
    }
    return { history: r.rows };
  });

  app.get('/rules/history/:id', async (req, reply) => {
    const r = await db.query('SELECT id, version, changed_at, changed_by, note, recording FROM rule_history WHERE id = $1', [Number(req.params.id) || 0]);
    if (!r.rowCount) return reply.code(404).send({ error: 'no such version' });
    return r.rows[0];
  });

  // tillegget for et kjøreverk, og det ferdige regelsettet det får
  app.get('/vehicles/:code/rules', async (req, reply) => {
    const v = await vehicleByCode(db, req.params.code);
    if (!v) return reply.code(404).send({ error: `no vehicle named ${req.params.code}` });
    const set = (await db.query('SELECT name FROM rule_set WHERE id = $1', [v.rule_set_id])).rows[0].name;
    const eff = await rules.effectiveFor(db, v);
    return { vehicle: v.code, ruleSet: set, extra: v.rule_extra, version: eff.version, effective: eff.recording };
  });

  app.put('/vehicles/:code/rules', {
    preHandler: need('rules'),
    schema: { body: { type: 'object', required: ['extra'], additionalProperties: false, properties: { extra: recording, note: { type: 'string', maxLength: 300 } } } },
  }, async req => {
    const extra = req.body.extra;
    const empty = extra && (!extra.rules || !extra.rules.length) && (!extra.pauses || !extra.pauses.length);
    const r = await rules.setVehicleExtra(db, req.params.code, empty ? null : extra, who(req), req.body.note || '');
    log.info(`${who(req)} ${empty || extra === null ? 'removed' : 'saved'} the extra rules for ${req.params.code}`);
    return r;
  });

  // sjekk et regelsett uten å lagre det: feilene, slik lagringen ville gitt dem
  app.post('/rules/check', { schema: { body: { type: 'object', required: ['recording'], properties: { recording: { type: 'object' } } } } }, async req => {
    const { recording: rec, errors } = checkRecording(req.body.recording);
    return { ok: !errors.length, errors, recording: rec };
  });

  // pauser: på et regelsett ({ set }) eller et kjøreverk ({ vehicle })
  app.post('/rules/pause', {
    preHandler: need('rules'),
    schema: {
      body: {
        type: 'object', required: ['target'], additionalProperties: false,
        properties: { target, tags: { type: 'string', maxLength: 500 }, minutes: { type: 'number', minimum: 1, maximum: 525600 }, until: { type: 'number' }, reason: { type: 'string', maxLength: 200 } },
      },
    },
  }, async req => {
    const b = req.body;
    if (!b.target.set && !b.target.vehicle) throw new HttpError(400, 'target is { set } or { vehicle }');
    const untilMs = Number.isFinite(b.until) ? b.until : Number.isFinite(b.minutes) ? Date.now() + b.minutes * 60000 : null;
    return rules.addPause(db, b.target, { tags: b.tags, untilMs, reason: b.reason }, who(req));
  });

  app.post('/rules/resume', {
    preHandler: need('rules'),
    schema: { body: { type: 'object', required: ['target', 'id'], additionalProperties: false, properties: { target, id: { type: 'string', maxLength: 40 } } } },
  }, async req => {
    if (!req.body.target.set && !req.body.target.vehicle) throw new HttpError(400, 'target is { set } or { vehicle }');
    return rules.resumePause(db, req.body.target, req.body.id, who(req));
  });

  // hva et regelsett ville lagret for et kjøreverk de siste timene
  app.post('/rules/preview', {
    schema: {
      body: {
        type: 'object', required: ['recording', 'vehicle'], additionalProperties: false,
        properties: { recording: { type: 'object' }, vehicle: { type: 'string', maxLength: 32 }, hours: { type: 'number', minimum: 1, maximum: 168 }, vars: { type: 'object' } },
      },
    },
  }, async (req, reply) => {
    const v = await vehicleByCode(db, req.body.vehicle);
    if (!v) return reply.code(404).send({ error: `no vehicle named ${req.body.vehicle}` });
    const t0 = Date.now();
    const r = await preview(db, v, req.body.recording, req.body.hours || 24, req.body.vars);
    r.ms = Date.now() - t0;
    return r;
  });
};
