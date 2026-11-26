#!/usr/bin/env node
/**
 * Prayer Dome Radio — infrastructure preflight.
 *
 *   node scripts/radio-preflight.mjs
 *   node scripts/radio-preflight.mjs --json
 *   node scripts/radio-preflight.mjs --strict
 *
 * Checks names, not secrets. It cannot prove that TiDB, R2 or AzuraCast is
 * reachable; it only prevents a deployment from claiming those services are
 * configured when the required environment variables are absent.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readRadioConfig } = require('../server/radio/config.js');

const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const report = readRadioConfig(process.env);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Prayer Dome Radio — infrastructure preflight\n');
  for (const group of report.groups) {
    console.log(`${group.ready ? 'READY  ' : 'MISSING'}  ${group.label}`);
    if (group.missing.length) console.log(`         required: ${group.missing.join(', ')}`);
    for (const note of group.notes || []) console.log(`         note: ${note}`);
  }
  console.log('\n' + report.note);
  console.log(report.ready ? 'All required names are present.' : 'Radio is not ready for a 24/7 launch.');
}

process.exitCode = strict && !report.ready ? 1 : 0;
