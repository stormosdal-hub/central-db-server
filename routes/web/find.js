'use strict';
// Finn data (docs/PLAN.md §4.2): hvilke kjøreverk har disse dataene, eller der betingelsen slo til
const { find } = require('../../lib/find');

module.exports = async function findRoutes(app, { db, config }) {
  app.post('/find', {
    schema: {
      body: {
        type: 'object', required: ['from', 'to'], additionalProperties: false,
        properties: {
          vehicles: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 500 },
          tags: { type: 'string', maxLength: 2000 },
          label: { type: 'string', maxLength: 200 },
          dataType: { type: 'string', enum: ['', 'boolean', 'number', 'string'] },
          unit: { type: 'string', maxLength: 40 },
          from: { type: 'number' }, to: { type: 'number' },
          condition: {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['has', 'on', 'above', 'below', 'changed', 'event'] }, value: { type: ['number', 'string'] }, text: { type: 'string', maxLength: 200 }, severity: { type: 'string' } },
          },
        },
      },
    },
  }, async req => {
    const t0 = Date.now();
    const r = await find(db, req.body, { maxDays: config.history.maxDays });
    r.ms = Date.now() - t0;
    return r;
  });
};
