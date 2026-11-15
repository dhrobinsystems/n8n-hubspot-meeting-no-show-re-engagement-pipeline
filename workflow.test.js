// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LICENSE_LINE, NODE, serializeWorkflow, WORKFLOW_PATH } from '../scripts/build-workflow.js';
import { runWorkflow } from './n8n-simulator.js';
import { createDemoRecords, createDemoWebhookBodies, createMockCalendly, createMockHubSpot, createMockTwilio, DEMO_NOW, DEMO_STAGE_MAP } from '../src/core/mocks.js';
import { loadNoShowConfig } from '../src/core/config.js';
import { extractEvents } from '../src/core/intake.js';
import { processEvents, runDemo } from '../src/core/pipeline.js';

const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const SECRET = 'test-shared-secret-long-enough-value';
const SIGNING_KEY = 'test-calendly-signing-key';
const ENV = {
  HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', WEBHOOK_SECRET: SECRET, CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING_KEY, CALENDLY_API_TOKEN: 'test-calendly-token',
  PIPELINE_NOW: DEMO_NOW, NO_SHOW_DEAL_STAGE_MAP: JSON.stringify(DEMO_STAGE_MAP),
  SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'test-sid', TWILIO_AUTH_TOKEN: 'test-twilio-token', TWILIO_FROM_NUMBER: '+15555550100', SMS_SANDBOX_RECIPIENT: '+15555550199',
  REBOOKING_URL: 'https://example.com/book-again', ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
};
const WRITE_ENV = { ...ENV, DRY_RUN: 'false' };
const ACCOUNT = { portalId: 12345678, accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' };
const TWILIO_BASIC = `Basic ${Buffer.from('test-sid:test-twilio-token').toString('base64')}`;

function services(options = {}) {
  const records = createDemoRecords();
  const hubspot = createMockHubSpot({ records, account: ACCOUNT, ...options.hubspot });
  const calendly = createMockCalendly({ records });
  const twilio = createMockTwilio(options.twilio);
  const posted = [];
  const http = async (request) => {
    if (request.url.startsWith('https://api.hubapi.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-hubspot-token');
      return hubspot.request(request);
    }
    if (request.url.startsWith('https://api.calendly.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-calendly-token');
      return calendly.request(request);
    }
    if (request.url.startsWith('https://api.twilio.com/')) {
      assert.equal(request.headers.Authorization, TWILIO_BASIC);
      assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
      return twilio.request({ ...request, form: request.body });
    }
    posted.push(request);
    return { status: 200, body: { ok: true } };
  };
  return { records, hubspot, calendly, twilio, posted, http };
}

function signedCalendly(body) {
  const raw = JSON.stringify(body);
  const t = String(Math.floor(Date.parse(DEMO_NOW) / 1000));
  return { 'Calendly-Webhook-Signature': `t=${t},v1=${createHmac('sha256', SIGNING_KEY).update(`${t}.${raw}`).digest('hex')}` };
}

const webhook = (body, headers) => ({ startNode: NODE.webhook, triggerItems: [{ json: { headers: headers || { 'x-webhook-secret': SECRET }, params: {}, query: {}, body } }] });

async function sendAll(env, svc, staticData = {}) {
  const runs = [];
  for (const body of createDemoWebhookBodies()) {
    const headers = body.event ? signedCalendly(body) : undefined;
    runs.push(await runWorkflow(workflow, { env, http: svc.http, staticData, ...webhook(body, headers) }));
  }
  return runs;
}

test('workflow.json is exactly what the build script produces', () => {
  assert.equal(readFileSync(WORKFLOW_PATH, 'utf8'), serializeWorkflow());
});

test('structure: the five required stages exist, inactive, valid connections, everything reachable', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const name of [NODE.webhook, NODE.filter, NODE.dealUpdate, NODE.router, NODE.twilio, NODE.task]) assert.ok(names.has(name), name);
  for (const [source, { main }] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source));
    for (const branch of main) for (const connection of branch) assert.ok(names.has(connection.node), connection.node);
  }
  const reachable = new Set();
  const visit = (name) => { if (reachable.has(name)) return; reachable.add(name); for (const branch of (workflow.connections[name] || { main: [] }).main) for (const c of branch) visit(c.node); };
  [NODE.webhook, NODE.manual, NODE.errorTrigger].forEach(visit);
  assert.deepEqual(workflow.nodes.map((node) => node.name).filter((name) => !reachable.has(name)), [NODE.note]);
});

test('no credentials, no hardcoded URLs, license line in every Code node', () => {
  const text = JSON.stringify(workflow);
  assert.ok(!/pat-(?:na|eu)\d-/.test(text));
  assert.ok(!/\bAC[0-9a-f]{32}\b/.test(text));
  assert.ok(!/hooks\.slack\.com\/services\/T/.test(text));
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.ok(!/https?:\/\//.test(node.parameters.url), `${node.name} has no hardcoded URL`);
      const header = node.parameters.headerParameters && node.parameters.headerParameters.parameters[0];
      if (header) assert.match(header.value, /\$env\./, node.name);
      assert.equal(node.credentials, undefined);
    }
    if (node.type === 'n8n-nodes-base.code') assert.ok(node.parameters.jsCode.startsWith(`// ${LICENSE_LINE}`), node.name);
  }
});

test('manual run in demo mode matches the Node.js demo without any HTTP', async () => {
  const run = await runWorkflow(workflow, { env: {}, http: async () => { throw new Error('demo must not call HTTP'); } });
  const mirror = await runDemo({ config: loadNoShowConfig({}) });
  const summary = run.output(NODE.finalize)[0];
  assert.deepEqual(summary.cases, mirror.report);
  assert.equal(summary.totals.noShows, 5);
  assert.equal(summary.totals.smsSent, 0);
});

test('every demo webhook through n8n (HubSpot + signed Calendly) ends in the same state as the mirror', async () => {
  const n8n = services();
  const runs = await sendAll(WRITE_ENV, n8n);
  assert.deepEqual(runs.map((run) => run.responses[0].statusCode), [202, 202, 202, 202, 202, 202, 202, 200]);

  const mirror = services();
  const events = createDemoWebhookBodies().flatMap((body) => extractEvents(body, 50).events).filter((event) => event.action !== 'no_show_removed');
  await processEvents({ config: loadNoShowConfig(WRITE_ENV), events, hubspotHttp: mirror.hubspot.request, calendlyHttp: mirror.calendly.request, twilioHttp: mirror.twilio.request, now: Date.parse(DEMO_NOW) });

  assert.deepEqual(n8n.records.deals, mirror.records.deals);
  assert.deepEqual(n8n.records.contacts, mirror.records.contacts);
  assert.deepEqual(n8n.hubspot.tasks.map((task) => task.properties.hs_task_subject), mirror.hubspot.tasks.map((task) => task.properties.hs_task_subject));
  assert.deepEqual(n8n.twilio.messages.map(({ sid, url, ...rest }) => rest), mirror.twilio.messages.map(({ sid, url, ...rest }) => rest));
  assert.equal(n8n.twilio.messages[0].url, 'https://api.twilio.com/2010-04-01/Accounts/test-sid/Messages.json');
  assert.equal(n8n.records.deals[401].dealstage, 'meeting_no_show');
});

test('DRY_RUN never reaches a write node', async () => {
  const n8n = services();
  const runs = await sendAll(ENV, n8n);
  const writes = [NODE.dealUpdate, NODE.twilio, NODE.enroll, NODE.stamp, NODE.task];
  for (const run of runs) for (const node of writes) assert.ok(!run.executed.includes(node), node);
  assert.equal(n8n.hubspot.calls.filter((call) => call.method !== 'GET').length, 0);
  assert.equal(n8n.twilio.messages.length, 0);
});

test('a completed meeting stops at the status filter', async () => {
  const run = await runWorkflow(workflow, { env: WRITE_ENV, http: services().http, ...webhook({ objectId: 303 }) });
  assert.ok(!run.executed.includes(NODE.decide));
  assert.deepEqual(run.output(NODE.finalize)[0].skipReasons, { outcome_completed: 1 });
});

test('replays are de-duplicated; bad secrets and signatures get 401; misconfiguration fails the execution', async () => {
  const staticData = {};
  const svc = services();
  await runWorkflow(workflow, { env: ENV, http: svc.http, staticData, ...webhook({ objectId: 301 }) });
  const replay = await runWorkflow(workflow, { env: ENV, http: svc.http, staticData, ...webhook({ objectId: 301 }) });
  assert.equal(replay.responses[0].body.duplicates, 1);
  assert.equal((await runWorkflow(workflow, { env: ENV, http: svc.http, ...webhook({ objectId: 301 }, { 'x-webhook-secret': 'wrong' }) })).responses[0].statusCode, 401);
  const calendlyBody = createDemoWebhookBodies()[5];
  assert.equal((await runWorkflow(workflow, { env: ENV, http: svc.http, ...webhook(calendlyBody, { 'Calendly-Webhook-Signature': 't=1,v1=00' }) })).responses[0].statusCode, 401);
  await assert.rejects(runWorkflow(workflow, { env: { ...ENV, SMS_TIMEZONE: 'Mars/Base' }, http: svc.http, ...webhook({ objectId: 301 }) }), /Configuration invalid/);
});

test('sandbox refusal stops before any meeting is read', async () => {
  const svc = services({ hubspot: { account: { portalId: 1, accountType: 'STANDARD' } } });
  await assert.rejects(runWorkflow(workflow, { env: ENV, http: svc.http, ...webhook({ objectId: 301 }) }), /SANDBOX_MODE=true, but the connected portal/);
  assert.deepEqual(svc.hubspot.calls.map((call) => call.path), ['/account-info/v3/details']);
});

test('a failing SMS still creates the task, then fails the execution for the error branch', async () => {
  const svc = services({ twilio: { fail: true } });
  await assert.rejects(runWorkflow(workflow, { env: WRITE_ENV, http: svc.http, ...webhook({ objectId: 301 }) }), /1 write\(s\) failed/);
  assert.equal(svc.hubspot.tasks.length, 1);
  assert.equal(svc.records.deals[401].dealstage, 'meeting_no_show');
});

test('the error branch posts a redacted alert', async () => {
  const svc = services();
  const failure = { execution: { id: '9', lastNodeExecuted: NODE.twilio, error: { message: 'Twilio 401 for test-twilio-token sending to +1 555 555 0111' } }, workflow: { name: workflow.name } };
  const run = await runWorkflow(workflow, { env: ENV, http: svc.http, startNode: NODE.errorTrigger, triggerItems: [{ json: failure }] });
  assert.ok(run.executed.includes(NODE.sendFailure));
  const text = JSON.stringify(svc.posted[0].body);
  assert.equal(svc.posted[0].url, 'https://alerts.example.com/hook');
  for (const fragment of ['test-twilio-token', '555 0111']) assert.ok(!text.includes(fragment), fragment);
});
