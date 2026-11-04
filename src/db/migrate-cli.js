'use strict';
const db = require('./index');
const { migrate } = require('./migrate');
const { seed } = require('./seed');
(async () => {
  await db.connect(); await migrate(); await seed(); await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
