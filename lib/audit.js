'use strict';
// Hvem som gjorde hva: hver endring av kjøreverk, nøkler, regler og brukere (docs/PLAN.md §3.6).
async function audit(q, who, action, target, details) {
  await q.query('INSERT INTO audit_log (who, action, target, details) VALUES ($1, $2, $3, $4)',
    [String(who || ''), action, String(target || ''), details === undefined ? null : JSON.stringify(details)]);
}
module.exports = { audit };
