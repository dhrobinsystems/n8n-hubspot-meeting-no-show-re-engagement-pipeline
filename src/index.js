#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Command-line runner (the Node.js mirror of workflow.json).
 *
 *   node src/index.js demo [--json]                    fictional records, mocks only, no network
 *   node src/index.js replay <payload.json> [--json]   replay saved webhook bodies through the configured environment
 *   node src/index.js meetings 123,456 [--json]        process HubSpot meetings by ID
 *
 * Variables come from the shell, then .env. De-duplication state and daily counters persist in data/state.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNoShowConfig, validateNoShowConfig } from './core/config.js';
import { extractEvents, filterDuplicateEvents } from './core/intake.js';
import { runPipeline } from './core/pipeline.js';

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function loadContext({ cwd = process.cwd(), baseEnv = process.env } = {}) {
  const dotEnvPath = resolve(cwd, '.env');
  const env = { ...(existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {}), ...baseEnv };
  return { env, config: loadNoShowConfig(env), statePath: resolve(cwd, 'data', 'state.json') };
}

function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function print(result, log) {
  for (const entry of result.report) {
    if (entry.status !== 'no_show') { log(`skipped  ${entry.eventKey}: ${entry.reason}`); continue; }
    const deals = entry.deals.map((deal) => (deal.action === 'update' ? `deal ${deal.dealId} → ${deal.to}` : `deal ${deal.dealId || '-'} kept (${deal.reason})`)).join(', ');
    log(`NO-SHOW  ${entry.contactName} [${entry.source}] channels: ${entry.channels.join('+') || 'none'} (${entry.reengagementStatus}) · ${deals} · task for ${entry.taskOwner || 'unassigned'}`);
    for (const note of entry.channelNotes) log(`         note: ${note}`);
  }
  const t = result.totals;
  log(`\n${t.noShows} no-show(s), ${t.skipped} skipped. Planned: ${t.dealsMoved} deal move(s), ${t.smsPlanned} SMS, ${t.emailPlanned} email, ${t.tasksPlanned} task(s).`);
  log(`Executed: ${t.dealsUpdated} deal update(s), ${t.smsSent} SMS, ${t.sequencesEnrolled} sequence enrolment(s), ${t.contactsStamped} contact stamp(s), ${t.tasksCreated} task(s), ${t.failures} failure(s).`);
}

export async function main(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  const [command = 'demo', target] = argv;
  try {
    const context = loadContext();
    const state = loadState(context.statePath);
    let config = context.config;
    let events = null;
    if (command === 'demo') {
      config = loadNoShowConfig({ ...context.env, HUBSPOT_PRIVATE_APP_TOKEN: '' }, { forceMode: 'demo' });
    } else if (command === 'replay') {
      if (!target) throw new Error('Usage: node src/index.js replay <payload.json>');
      const parsed = JSON.parse(readFileSync(resolve(target), 'utf8'));
      const bodies = Array.isArray(parsed) ? parsed : Array.isArray(parsed.bodies) ? parsed.bodies : [parsed];
      const extracted = bodies.flatMap((body) => extractEvents(body, config.webhook.maxEventsPerRequest).events).filter((event) => event.action !== 'no_show_removed');
      const { fresh, duplicates } = filterDuplicateEvents(extracted, state, Date.now(), config.webhook.dedupeDays);
      if (duplicates) errorLog(`${duplicates} event(s) already processed and skipped`);
      events = fresh;
    } else if (command === 'meetings') {
      events = String(target || '').split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)).flatMap((id) => extractEvents({ objectId: id }, 1).events);
      if (!events.length) throw new Error('Usage: node src/index.js meetings 123,456');
    } else {
      throw new Error(`Unknown command "${command}". Use demo, replay or meetings.`);
    }
    for (const warning of validateNoShowConfig(config).warnings) errorLog(`warning: ${warning}`);
    if (events && !events.length) { log('Nothing to process.'); return 0; }
    const result = await runPipeline({ config, events, state });
    if (config.mode !== 'demo') {
      mkdirSync(dirname(context.statePath), { recursive: true });
      writeFileSync(context.statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    if (argv.includes('--json')) log(JSON.stringify({ totals: result.totals, skipReasons: result.skipReasons, report: result.report }, null, 2));
    else print(result, log);
    return result.totals.failures ? 2 : 0;
  } catch (error) {
    errorLog(error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; });
}
