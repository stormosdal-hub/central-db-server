'use strict';
/*
 * routes/web.js - det web-siden spør serveren om (docs/PLAN.md §4). Hver side får sin del her.
 *
 * Innloggingen (lib/session.js): å se krever ingen innlogging, med mindre web.loginToView er satt i
 * oppsettet. Å endre noe krever innlogging med riktig rolle: admin for kjøreverk og nøkler, rules for
 * hvilket regelsett et kjøreverk bruker. Alt som endrer noe, logges i audit_log som web:<bruker>.
 */

const admin = require('../lib/admin');
const { listRuleSets, setVehicleRuleSet } = require('../lib/rules');
const { audit } = require('../lib/audit');
const { COOKIE, can, readCookie, cookieHeader, createSession, sessionUser, destroySession, createLimiter } = require('../lib/session');
const { VERSION } = require('../lib/app');

const OPEN = new Set(['/api/web/me', '/api/web/login', '/api/web/logout']);   // også uten innlogging når web.loginToView er på

const code = { type: 'string', minLength: 1, maxLength: 32 };
const vehicleFields = {
  name: { type: 'string', maxLength: 100 },
  notes: { type: 'string', maxLength: 2000 },
  silentAfter: { type: 'integer', minimum: 60, maximum: 7776000 },
  ruleSet: { type: 'string', minLength: 1, maxLength: 40 },
};

module.exports = async function web(app, { db, config, log }) {
  const days = config.web.sessionDays || 14;
  const limiter = createLimiter(5, 10 * 60000);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (req, reply) => {
    // alt som endrer noe: som JSON, fra serverens egen side
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch (e) { /* ugyldig */ }
        if (host !== req.headers.host) { reply.code(403).send({ error: 'changes must come from this server\'s own web page' }); return reply; }
      }
      if ((req.method === 'POST' || req.method === 'PATCH') && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        reply.code(415).send({ error: 'send JSON, with Content-Type: application/json' });
        return reply;
      }
    }
    const token = readCookie(req, COOKIE);
    if (token) { req.sessionToken = token; req.user = await sessionUser(db, token, days); }
    if (config.web.loginToView && !req.user && !OPEN.has(req.url.split('?')[0])) {
      reply.code(401).send({ error: 'log in to see this page', login: true });
      return reply;
    }
  });

  // preHandler: innlogget med minst denne rollen
  const need = role => async (req, reply) => {
    if (!req.user) { reply.code(401).send({ error: 'log in first', login: true }); return reply; }
    if (!can(req.user, role)) { reply.code(403).send({ error: `this needs the role ${role}; ${req.user.name} has the role ${req.user.role}` }); return reply; }
  };
  const who = req => `web:${req.user.name}`;

  // ---------------------------------------------------------------- innloggingen
  app.get('/me', async req => {
    const n = (await db.query('SELECT count(*) AS n FROM app_user WHERE NOT disabled')).rows[0].n;
    return { user: req.user, hasUsers: n > 0, loginToView: !!config.web.loginToView };
  });

  app.post('/login', {
    schema: { body: { type: 'object', required: ['name', 'password'], properties: { name: { type: 'string', maxLength: 40 }, password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const wait = limiter.waitSeconds(req.ip);
    if (wait) { reply.header('Retry-After', String(wait)); return reply.code(429).send({ error: `too many failed attempts; try again in ${Math.ceil(wait / 60)} min`, retryAfter: wait }); }
    const user = await admin.verifyUser(db, req.body.name, req.body.password);
    if (!user) {
      limiter.fail(req.ip);
      log.warn(`failed login as ${JSON.stringify(req.body.name)} from ${req.ip}`);
      return reply.code(401).send({ error: 'wrong name or password' });
    }
    limiter.ok(req.ip);
    const token = await createSession(db, user.id, req.ip, days);
    await audit(db, `web:${user.name}`, 'user.login', user.name, { ip: req.ip });
    reply.header('Set-Cookie', cookieHeader(token, days * 86400));
    return { user };
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(db, req.sessionToken);
    reply.header('Set-Cookie', cookieHeader('', 0));
    return { ok: true };
  });

  // ---------------------------------------------------------------- oversikten
  async function vehiclesWithStats() {
    const vehicles = await admin.listVehicles(db);
    const stats = (await db.query(`SELECT v.id,
        (SELECT coalesce(sum(n + nnull), 0) FROM sample_1h h WHERE h.vehicle_id = v.id AND h.bucket >= now() - interval '24 hours') AS points_24h,
        (SELECT count(*) FROM gap g WHERE g.vehicle_id = v.id AND g.reported_at >= now() - interval '24 hours') AS gaps_24h,
        (SELECT count(*) FROM vehicle_tag vt WHERE vt.vehicle_id = v.id) AS tags,
        (SELECT count(*) FROM event e WHERE e.vehicle_id = v.id AND e.ts >= now() - interval '24 hours' AND e.severity = 'alarm') AS alarms_24h
      FROM vehicle v`)).rows;
    const byId = new Map(stats.map(s => [s.id, s]));
    const now = Date.now();
    for (const v of vehicles) {
      const s = byId.get(v.id) || {};
      v.points_24h = Number(s.points_24h || 0);
      v.gaps_24h = Number(s.gaps_24h || 0);
      v.tags = Number(s.tags || 0);
      v.alarms_24h = Number(s.alarms_24h || 0);
      v.sending = v.last_batch_at !== null && now - v.last_batch_at < 90000;
      v.silent = v.last_batch_at === null ? true : now - v.last_batch_at > v.silent_after_s * 1000;
    }
    return vehicles;
  }

  app.get('/overview', async () => {
    const vehicles = await vehiclesWithStats();
    const size = (await db.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes;
    const dirty = (await db.query('SELECT count(*) AS n FROM rollup_dirty')).rows[0].n;
    return { time: Date.now(), version: VERSION, timescale: db.timescale, dbBytes: Number(size), rollupPending: Number(dirty), vehicles };
  });

  // ---------------------------------------------------------------- kjøreverkene (docs/PLAN.md §4.7)
  app.get('/vehicles', async () => ({ vehicles: await vehiclesWithStats(), ruleSets: (await listRuleSets(db)).map(r => r.name), port: config.port }));

  app.get('/vehicles/:code', async (req, reply) => {
    const v = await admin.getVehicle(db, req.params.code);
    if (!v) return reply.code(404).send({ error: `no vehicle named ${req.params.code}` });
    v.gaps = (await db.query('SELECT id, from_ts, to_ts, tags, reason, reported_at FROM gap WHERE vehicle_id = $1 ORDER BY from_ts DESC LIMIT 50', [v.id])).rows;
    return v;
  });

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

  app.get('/rulesets', async () => listRuleSets(db));

  app.get('/config', async () => ({ history: config.history, ingest: config.ingest, retention: config.retention }));
};
