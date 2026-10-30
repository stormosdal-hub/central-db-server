'use strict';
/*
 * lib/app.js - Fastify-appen: gzip inn og ut, feilsvar som { "error": "tekst" }, og rutene:
 *   /api/v1/*    recorderne i kjøreverkene (routes/v1.js, PROTOKOLL.md)
 *   /api/web/*   web-siden (routes/web.js)
 *   /            web-siden selv (mappen web/)
 */

const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const Fastify = require('fastify');
const { HttpError } = require('./errors');

const gzip = promisify(zlib.gzip);
const VERSION = require('../package.json').version;

async function buildApp({ config, db, log }) {
  const app = Fastify({
    loggerInstance: log.child({ mod: 'http' }),      // linjene per forespørsel kommer bare med log: debug (lib/log.js)
    bodyLimit: config.ingest.maxBatchBytes,           // største batch, pakket ut
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false, allowUnionTypes: true } },
    trustProxy: false,
  });

  // forespørsler pakket med gzip (PROTOKOLL.md §1). Content-Length gjelder det pakkede, så den tas bort;
  // Fastify teller da det utpakkede mot bodyLimit, og svarer 413 når det blir for mye.
  app.addHook('preParsing', async (req, reply, payload) => {
    const enc = String(req.headers['content-encoding'] || 'identity').toLowerCase();
    if (enc === 'identity') return payload;
    let unpack;
    if (enc === 'gzip' || enc === 'x-gzip') unpack = zlib.createGunzip();
    else if (enc === 'deflate') unpack = zlib.createInflate();
    else throw new HttpError(415, `unsupported Content-Encoding ${enc}: use gzip or none`);
    delete req.headers['content-length'];
    payload.on('error', e => unpack.destroy(e));
    return payload.pipe(unpack);
  });

  // svar pakket med gzip når klienten sa Accept-Encoding: gzip og svaret er stort nok til at det lønner seg
  app.addHook('onSend', async (req, reply, payload) => {
    if (payload == null || (typeof payload !== 'string' && !Buffer.isBuffer(payload))) return payload;
    if (Buffer.byteLength(payload) < 1024) return payload;
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return payload;
    if (reply.getHeader('content-encoding')) return payload;
    const z = await gzip(payload);
    reply.header('Content-Encoding', 'gzip');
    reply.header('Vary', 'Accept-Encoding');
    reply.removeHeader('content-length');
    return z;
  });

  // alle feil som { error }: 400 for en forespørsel som er feil, 413 for en for stor, 500 for våre egne
  app.setErrorHandler((err, req, reply) => {
    let status = err.statusCode || 500;
    let message = err.message || 'error';
    if (err.validation) { status = 400; message = `invalid request: ${err.message}`; }
    else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') { status = 413; message = `the request is larger than ${config.ingest.maxBatchBytes} bytes unpacked; send it in smaller batches`; }
    else if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) { status = 400; message = `the body is not valid JSON: ${err.message}`; }
    else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') { status = 415; message = 'send JSON, with Content-Type: application/json'; }
    else if (typeof err.code === 'string' && err.code.startsWith('Z_')) { status = 400; message = `the body is not valid gzip (${err.code})`; }
    if (status >= 500) req.log.error({ err, req }, 'request failed');
    const body = { error: message };
    if (err.errors) body.errors = err.errors;
    if (err.retryAfter) body.retryAfter = err.retryAfter;
    reply.code(status).send(body);
  });
  app.setNotFoundHandler((req, reply) => { reply.code(404).send({ error: `no such route: ${req.method} ${req.url}` }); });

  app.get('/api/health', async () => ({ ok: true, version: VERSION, time: Date.now(), timescale: db.timescale }));
  app.register(require('../routes/v1'), { prefix: '/api/v1', db, config, log: log.child({ mod: 'v1' }) });
  if (config.web.enabled !== false) {
    app.register(require('../routes/web'), { prefix: '/api/web', db, config, log: log.child({ mod: 'web' }) });
    app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'web'), prefix: '/', cacheControl: true, maxAge: 0 });
    // grafbiblioteket fra node_modules, så web-siden ikke trenger internett
    app.register(require('@fastify/static'), { root: path.dirname(require.resolve('uplot/dist/uPlot.iife.min.js')), prefix: '/vendor/', decorateReply: false, maxAge: 86400000 });
  }
  return app;
}

module.exports = buildApp;
module.exports.VERSION = VERSION;
