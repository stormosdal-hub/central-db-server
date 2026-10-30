'use strict';
/*
 * Trend og tidslinje (docs/PLAN.md §4.3): punktene til flere kjøreverk og tagger i samme graf.
 * Bruker lib/history.js, den samme som svarer HMI-ene i kjøreverkene: rådata eller sammendrag etter
 * mengden, første punkt ved from, tynning med minste og største, null i hull.
 */
const { history } = require('../../lib/history');
const { vehicleByCode } = require('../../lib/auth');
const { timeRange } = require('../../lib/catalog');

const MAX_SERIES = 24;

module.exports = async function seriesRoutes(app, { db, config }) {
  app.post('/series', {
    schema: {
      body: {
        type: 'object', required: ['series', 'from', 'to'], additionalProperties: false,
        properties: {
          series: { type: 'array', minItems: 1, maxItems: MAX_SERIES, items: { type: 'object', required: ['vehicle', 'tag'], properties: { vehicle: { type: 'string', maxLength: 32 }, tag: { type: 'string', maxLength: 200 } } } },
          from: { type: 'number' }, to: { type: 'number' },
          points: { type: 'integer', minimum: 50, maximum: 5000 },
        },
      },
    },
  }, async (req, reply) => {
    const t0 = Date.now();
    const { from, to } = timeRange(req.body, config.history.maxDays);
    const points = req.body.points || 1000;
    const byVehicle = new Map();
    for (const s of req.body.series) {
      if (!byVehicle.has(s.vehicle)) byVehicle.set(s.vehicle, []);
      if (!byVehicle.get(s.vehicle).includes(s.tag)) byVehicle.get(s.vehicle).push(s.tag);
    }
    const out = [];
    for (const [code, tags] of byVehicle) {
      const v = await vehicleByCode(db, code);
      if (!v) return reply.code(404).send({ error: `no vehicle named ${code}` });
      const info = new Map((await db.query(`SELECT t.name, vt.data_type, vt.unit, vt.label FROM vehicle_tag vt JOIN tag t ON t.id = vt.tag_id
        WHERE vt.vehicle_id = $1 AND t.name = ANY($2::text[])`, [v.id, tags])).rows.map(r => [r.name, r]));
      // history() tar høyst maxTags om gangen
      const max = config.history.maxTags || 8;
      for (let i = 0; i < tags.length; i += max) {
        const part = tags.slice(i, i + max);
        const r = await history(db, v, { tags: part, from, to, points }, config.history);
        for (const tag of part) {
          const t = info.get(tag) || {};
          out.push({ vehicle: code, tag, label: t.label || '', unit: t.unit || '', dataType: t.data_type || null,
            points: r.series[tag] || [], source: r.sources[tag] || null, missing: !info.has(tag), text: t.data_type === 'string' });
        }
      }
    }
    // i den rekkefølgen de ble bedt om
    const order = req.body.series.map(s => `${s.vehicle}|${s.tag}`);
    out.sort((a, b) => order.indexOf(`${a.vehicle}|${a.tag}`) - order.indexOf(`${b.vehicle}|${b.tag}`));
    return { from, to, series: out, ms: Date.now() - t0 };
  });
};
