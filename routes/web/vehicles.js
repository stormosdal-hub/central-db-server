'use strict';
// Kjøreverk (docs/PLAN.md §4.7): registrer, endre, nøkler, slå av, slett. Og taggene deres, til velgerne.
const admin = require('../../lib/admin');
const { listRuleSets, setVehicleRuleSet } = require('../../lib/rules');
const { tagList } = require('../../lib/catalog');

const code = { type: 'string', minLength: 1, maxLength: 32 };
const vehicleFields = {
  name: { type: 'string', maxLength: 100 },
  notes: { type: 'string', maxLength: 2000 },
  silentAfter: { type: 'integer', minimum: 60, maximum: 7776000 },
  ruleSet: { type: 'string', minLength: 1, maxLength: 40 },
};

module.exports = async function vehicles(app, { db, config, log, need, who }) {
  app.get('/vehicles', async () => ({ vehicles: await admin.vehiclesWithStats(db), ruleSets: (await listRuleSets(db)).map(r => r.name), port: config.port }));

  app.get('/vehicles/:code', async (req, reply) => {
    const v = await admin.getVehicle(db, req.params.code);
    if (!v) return reply.code(404).send({ error: `no vehicle named ${req.params.code}` });
    v.gaps = (await db.query('SELECT id, from_ts, to_ts, tags, reason, reported_at FROM gap WHERE vehicle_id = $1 ORDER BY from_ts DESC LIMIT 50', [v.id])).rows;
    return v;
  });

  // taggene i katalogen, til velgerne på Finn data, Trend og Eksport: ?vehicles=kv01,kv02&q=tekst
  app.get('/tags', async req => ({ tags: await tagList(db, { vehicles: req.query.vehicles, q: req.query.q, limit: req.query.limit }) }));

  // registrer et kjøreverk, og lag nøkkelen med en gang hvis makeKey er satt
  app.post('/vehicles', {
    preHandler: need('admin'),
    schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: Object.assign({ code, makeKey: { type: 'boolean' } }, vehicleFields) } },
  }, async (req, reply) => {
    const b = req.body;
    await admin.addVehicle(db, { code: b.code, name: b.name, ruleSet: b.ruleSet, silentAfter: b.silentAfter, notes: b.notes, who: who(req) });
    const out = { code: b.code };
    if (b.makeKey) Object.assign(out, await admin.makeKey(db, b.code, who(req)));
    log.info(`${who(req)} added ${b.code}${b.makeKey ? ' with a key' : ''}`);
    return reply.code(201).send(out);
  });

  // endre et kjøreverk: navn, notater, grensen for stille og av/på krever admin; regelsettet krever rules
  app.patch('/vehicles/:code', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: Object.assign({ active: { type: 'boolean' } }, vehicleFields) } },
  }, async (req, reply) => {
    const b = req.body, c = req.params.code;
    const adminFields = ['name', 'notes', 'silentAfter', 'active'].filter(k => b[k] !== undefined);
    const denied = await need(adminFields.length ? 'admin' : 'rules')(req, reply);
    if (denied) return denied;
    if (!(await admin.getVehicle(db, c))) return reply.code(404).send({ error: `no vehicle named ${c}` });
    if (b.name !== undefined || b.notes !== undefined || b.silentAfter !== undefined) {
      await admin.updateVehicle(db, c, { name: b.name, notes: b.notes, silentAfter: b.silentAfter }, who(req));
    }
    if (b.active !== undefined) await admin.setActive(db, c, b.active, who(req));
    if (b.ruleSet !== undefined) await setVehicleRuleSet(db, c, b.ruleSet, who(req));
    return admin.getVehicle(db, c);
  });

  // en ny nøkkel; den gamle slutter å virke med en gang. Nøkkelen vises bare i dette svaret.
  app.post('/vehicles/:code/key', { preHandler: need('admin') }, async req => {
    const r = await admin.makeKey(db, req.params.code, who(req));
    log.info(`${who(req)} made a new key for ${req.params.code}`);
    return r;
  });

  app.delete('/vehicles/:code/key', { preHandler: need('admin') }, async req => {
    await admin.revokeKey(db, req.params.code, who(req));
    log.info(`${who(req)} revoked the key for ${req.params.code}`);
    return { ok: true };
  });

  // bare et kjøreverk som aldri har lagret data; ellers slås det av
  app.delete('/vehicles/:code', { preHandler: need('admin') }, async req => {
    await admin.deleteVehicle(db, req.params.code, who(req));
    log.info(`${who(req)} deleted ${req.params.code}`);
    return { ok: true };
  });
};
