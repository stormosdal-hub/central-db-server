'use strict';
/*
 * Eksport (docs/PLAN.md §4.4): GET /export?… laster ned en CSV- eller zip-fil, strømmet. GET /export/estimate
 * med de samme valgene sier omtrent hvor mange rader det blir. Høyst web.maxExports eksporter samtidig.
 */
const { Readable } = require('stream');
const { buildExport, estimate } = require('../../lib/export');
const { timeRange, codeList } = require('../../lib/catalog');
const { validZone } = require('../../lib/csv');
const { bad } = require('../../lib/errors');

const query = {
  type: 'object', required: ['from', 'to'],
  properties: {
    kind: { type: 'string', enum: ['values', 'events', 'gaps'] },
    vehicles: { type: 'string', maxLength: 10000 },
    tags: { type: 'string', maxLength: 2000 },
    label: { type: 'string', maxLength: 200 },
    from: { type: 'string' }, to: { type: 'string' },
    format: { type: 'string', enum: ['long', 'wide'] },
    resolution: { type: 'string', enum: ['raw', '1m', '1h'] },
    style: { type: 'string', enum: ['no', 'intl'] },
    files: { type: 'string', enum: ['one', 'zip'] },
    tz: { type: 'string', maxLength: 64 },
    fill: { type: 'string', enum: ['0', '1', 'true', 'false'] },
  },
};

function options(q, config) {
  const { from, to } = timeRange(q, config.history.maxDays);
  const tz = q.tz || 'UTC';
  if (!validZone(tz)) throw bad(`unknown time zone ${tz}`);
  return { kind: q.kind || 'values', vehicles: codeList(q.vehicles), tags: q.tags || '', label: q.label || '', from, to,
    format: q.format || 'long', resolution: q.resolution || 'raw', style: q.style || 'no', files: q.files || 'one', tz, fill: q.fill === '1' || q.fill === 'true' };
}

module.exports = async function exportRoutes(app, { db, config, log }) {
  let running = 0;

  app.get('/export/estimate', { schema: { querystring: query } }, async req => estimate(db, options(req.query, config)));

  app.get('/export', { schema: { querystring: query } }, async (req, reply) => {
    const o = options(req.query, config);
    if (running >= (config.web.maxExports || 2)) {
      reply.header('Retry-After', '30');
      return reply.code(503).send({ error: 'other exports are running; try again in a minute', retryAfter: 30 });
    }
    const x = await buildExport(db, o, log);
    running++;
    let done = false;
    const finish = () => { if (!done) { done = true; running--; } };
    const stream = Readable.from(x.chunks, { objectMode: false });
    stream.on('close', finish);
    stream.on('error', finish);
    log.info(`export ${o.kind} ${o.format} ${o.resolution} ${o.files} for ${req.user ? req.user.name : req.ip}: ${new Date(o.from).toISOString()} – ${new Date(o.to).toISOString()}`);
    reply.header('Content-Type', x.type);
    reply.header('Content-Disposition', `attachment; filename="${x.filename}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(stream);
  });
};
