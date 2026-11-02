'use strict';
/*
 * Kjøreverk-database (docs/PLAN.md §4.8): visningene, der hver er widgeter på et lerret som i HMI-en.
 *   GET    /dashboards          alle visningene: id, navn, fanene (id og navn), antall widgeter, hvem og når
 *   GET    /dashboards/:id      én visning med oppsettet (config)
 *   POST   /dashboards          ny visning
 *   PUT    /dashboards/:id      lagre. version er den som ble hentet; har noen andre lagret siden, svares 409
 *                               med hvem og når, og web-siden spør før den lagrer over
 *   DELETE /dashboards/:id      slett
 * Å se krever det samme som resten av web-siden. Å lagre og slette krever innlogging, med hvilken som helst
 * rolle: en visning endrer ingenting i kjøreverkene eller dataene. Alt står i audit_log.
 *
 * Og dataene widgetene trenger, utover /series (tall og av/på) og /events:
 *   GET  /catalog?vehicle=kv_52  taggene til ett kjøreverk med siste verdi, til velgeren av tagger
 *   POST /latest                 siste verdi for en liste med kjøreverk og tagger
 *   POST /text                   tekstverdiene i et tidsrom, med verdien som gjaldt ved from først
 */
const { audit } = require('../../lib/audit');
const { vehicleByCode } = require('../../lib/auth');
const { findTags, timeRange } = require('../../lib/catalog');

const MAX_CONFIG = 1000000;   // tegn i oppsettet som JSON: rikelig for flere hundre widgeter
const name = { type: 'string', minLength: 1, maxLength: 80 };
const config = { type: 'object', properties: { tabs: { type: 'array', maxItems: 100 }, widgets: { type: 'array', maxItems: 500 } } };
const id = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^\\d{1,9}$' } } };
const item = { type: 'object', required: ['vehicle', 'tag'], properties: { vehicle: { type: 'string', maxLength: 32 }, tag: { type: 'string', maxLength: 200 } } };
const COLUMNS = `id, name, version, created_by, created_at, updated_by, updated_at`;

function check(body) {
  const n = String(body.name).trim();
  if (!n) return 'the view needs a name';
  if (body.config && JSON.stringify(body.config).length > MAX_CONFIG) return `the view is larger than ${MAX_CONFIG} characters as JSON; split it in two`;
  return null;
}
const taken = (e, n) => (e.code === '23505' ? `there is a view named ${n} already` : null);

module.exports = async function dashboards(app, { db, config: cfg, need, who }) {
  // oppsettet har fanene i tabs, hver med sine widgets; visninger lagret før fanene har widgets rett i oppsettet
  app.get('/dashboards', async () => {
    const r = await db.query(`SELECT ${COLUMNS},
        CASE WHEN jsonb_typeof(config->'tabs') = 'array'
          THEN (SELECT coalesce(sum(jsonb_array_length(t->'widgets')), 0) FROM jsonb_array_elements(config->'tabs') t WHERE jsonb_typeof(t->'widgets') = 'array')
          ELSE coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(config->'widgets') = 'array' THEN config->'widgets' END), 0)
        END::int AS widgets,
        CASE WHEN jsonb_typeof(config->'tabs') = 'array'
          THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t->>'id', 'name', t->>'name') ORDER BY i), '[]') FROM jsonb_array_elements(config->'tabs') WITH ORDINALITY AS x(t, i) WHERE jsonb_typeof(t) = 'object')
          ELSE '[]'
        END AS tabs
      FROM dashboard ORDER BY lower(name)`);
    return { dashboards: r.rows };
  });

  app.get('/dashboards/:id', { schema: { params: id } }, async (req, reply) => {
    const r = await db.query(`SELECT ${COLUMNS}, config FROM dashboard WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return reply.code(404).send({ error: `no view with id ${req.params.id}` });
    return r.rows[0];
  });

  app.post('/dashboards', {
    preHandler: need('view'),
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name, config } } },
  }, async (req, reply) => {
    const err = check(req.body);
    if (err) return reply.code(400).send({ error: err });
    const n = req.body.name.trim();
    try {
      const r = await db.query(`INSERT INTO dashboard (name, config, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING ${COLUMNS}`,
        [n, JSON.stringify(req.body.config || {}), who(req)]);
      await audit(db, who(req), 'dashboard.create', n, { id: r.rows[0].id });
      return reply.code(201).send(r.rows[0]);
    } catch (e) {
      if (taken(e, n)) return reply.code(409).send({ error: taken(e, n) });
      throw e;
    }
  });

  app.put('/dashboards/:id', {
    preHandler: need('view'),
    schema: {
      params: id,
      body: { type: 'object', required: ['name', 'config', 'version'], additionalProperties: false, properties: { name, config, version: { type: 'integer', minimum: 1 } } },
    },
  }, async (req, reply) => {
    const err = check(req.body);
    if (err) return reply.code(400).send({ error: err });
    const n = req.body.name.trim(), dashId = Number(req.params.id);
    let r;
    try {
      r = await db.query(`UPDATE dashboard SET name = $2, config = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE id = $1 AND version = $5 RETURNING ${COLUMNS}`, [dashId, n, JSON.stringify(req.body.config), who(req), req.body.version]);
    } catch (e) {
      if (taken(e, n)) return reply.code(409).send({ error: taken(e, n) });
      throw e;
    }
    if (!r.rowCount) {
      const now = (await db.query(`SELECT ${COLUMNS} FROM dashboard WHERE id = $1`, [dashId])).rows[0];
      if (!now) return reply.code(404).send({ error: `no view with id ${dashId}; it has been deleted` });
      return reply.code(409).send({ error: `${now.updated_by || 'someone'} has saved this view since you opened it`, conflict: true, current: now });
    }
    await audit(db, who(req), 'dashboard.save', n, { id: dashId, version: r.rows[0].version });
    return r.rows[0];
  });

  app.delete('/dashboards/:id', { preHandler: need('view'), schema: { params: id } }, async (req, reply) => {
    const r = await db.query('DELETE FROM dashboard WHERE id = $1 RETURNING name', [Number(req.params.id)]);
    if (!r.rowCount) return reply.code(404).send({ error: `no view with id ${req.params.id}` });
    await audit(db, who(req), 'dashboard.delete', r.rows[0].name, { id: Number(req.params.id) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- dataene
  app.get('/catalog', {
    schema: { querystring: { type: 'object', required: ['vehicle'], properties: { vehicle: { type: 'string', minLength: 1, maxLength: 32 } } } },
  }, async (req, reply) => {
    if (!(await vehicleByCode(db, req.query.vehicle))) return reply.code(404).send({ error: `no vehicle named ${req.query.vehicle}` });
    const { rows, truncated } = await findTags(db, { vehicles: [req.query.vehicle], limit: 10000 });
    return {
      vehicle: req.query.vehicle, truncated,
      tags: rows.map(r => ({ tag: r.tag, dataType: r.data_type, unit: r.unit, label: r.label, description: r.description, ts: r.last_ts, value: r.last_value, text: r.last_text })),
    };
  });

  app.post('/latest', {
    schema: { body: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', maxItems: 2000, items: item } } } },
  }, async req => {
    const items = req.body.items;
    if (!items.length) return { values: [] };
    const r = await db.query(`SELECT q.code AS vehicle, q.tag, vt.data_type, vt.unit, vt.label,
        (extract(epoch FROM vt.last_ts) * 1000)::bigint AS ts, vt.last_value AS value, vt.last_text AS text
      FROM unnest($1::text[], $2::text[]) AS q(code, tag)
      JOIN vehicle v ON v.code = q.code JOIN tag t ON t.name = q.tag JOIN vehicle_tag vt ON vt.vehicle_id = v.id AND vt.tag_id = t.id`,
    [items.map(i => i.vehicle), items.map(i => i.tag)]);
    return { values: r.rows.map(x => ({ vehicle: x.vehicle, tag: x.tag, dataType: x.data_type, unit: x.unit, label: x.label, ts: x.ts, value: x.value, text: x.text })) };
  });

  app.post('/text', {
    schema: {
      body: {
        type: 'object', required: ['series', 'from', 'to'], additionalProperties: false,
        properties: { series: { type: 'array', minItems: 1, maxItems: 50, items: item }, from: { type: 'number' }, to: { type: 'number' }, limit: { type: 'integer', minimum: 10, maximum: 5000 } },
      },
    },
  }, async (req, reply) => {
    const { from, to } = timeRange(req.body, cfg.history.maxDays);
    const limit = req.body.limit || 2000;
    const out = [];
    for (const s of req.body.series) {
      const v = await vehicleByCode(db, s.vehicle);
      if (!v) return reply.code(404).send({ error: `no vehicle named ${s.vehicle}` });
      const t = (await db.query('SELECT id FROM tag WHERE name = $1', [s.tag])).rows[0];
      if (!t) { out.push({ vehicle: s.vehicle, tag: s.tag, points: [], missing: true }); continue; }
      const args = [v.id, t.id, from, to];
      const first = await db.query(`SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, value FROM sample_text
        WHERE vehicle_id = $1 AND tag_id = $2 AND ts <= to_timestamp($3 / 1000.0) ORDER BY ts DESC LIMIT 1`, args.slice(0, 3));
      const rest = await db.query(`SELECT (extract(epoch FROM ts) * 1000)::bigint AS t, value FROM sample_text
        WHERE vehicle_id = $1 AND tag_id = $2 AND ts > to_timestamp($3 / 1000.0) AND ts <= to_timestamp($4 / 1000.0) ORDER BY ts LIMIT $5`, args.concat([limit + 1]));
      const truncated = rest.rows.length > limit;
      if (truncated) rest.rows.length = limit;
      const points = (first.rowCount ? [[from, first.rows[0].value]] : []).concat(rest.rows.map(x => [x.t, x.value]));
      out.push({ vehicle: s.vehicle, tag: s.tag, points, truncated });
    }
    return { from, to, series: out };
  });
};
