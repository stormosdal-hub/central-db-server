'use strict';
/*
 * routes/web.js - det web-siden spør serveren om (docs/PLAN.md §4): innloggingen her, og én modul per side
 * i routes/web/, med sin egen mappe i web/pages/. En ny side er en ny fil i hver.
 *
 * Innloggingen (lib/session.js): å se krever ingen innlogging, med mindre web.loginToView er satt i
 * oppsettet. Å endre noe krever innlogging med riktig rolle: admin for kjøreverk og nøkler, rules for
 * reglene og hvilket regelsett et kjøreverk bruker. Alt som endrer noe, logges i audit_log som web:<bruker>.
 */

const admin = require('../lib/admin');
const { audit } = require('../lib/audit');
const { COOKIE, can, readCookie, cookieHeader, createSession, sessionUser, destroySession, createLimiter } = require('../lib/session');

const OPEN = new Set(['/api/web/me', '/api/web/login', '/api/web/logout']);   // også uten innlogging når web.loginToView er på
const PAGES = ['overview', 'vehicles', 'find', 'series', 'export', 'events', 'rules'];

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
      if (['POST', 'PATCH', 'PUT'].includes(req.method) && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
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

  // deny(req, reply, role): true når forespørselen ikke har rollen, og svaret (401/403) er sendt. Synkron og
  // med true/false med vilje: reply har en then-metode, så en async-funksjon som returnerer reply, gir
  // undefined når den awaites, og da ville en avvist forespørsel gått videre.
  const deny = (req, reply, role) => {
    if (!req.user) { reply.code(401).send({ error: 'log in first', login: true }); return true; }
    if (!can(req.user, role)) { reply.code(403).send({ error: `this needs the role ${role}; ${req.user.name} has the role ${req.user.role}` }); return true; }
    return false;
  };
  // preHandler: innlogget med minst denne rollen
  const need = role => async (req, reply) => { if (deny(req, reply, role)) return reply; };
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

  // ---------------------------------------------------------------- sidene
  for (const page of PAGES) await app.register(require(`./web/${page}`), { db, config, log, need, deny, who });
};
