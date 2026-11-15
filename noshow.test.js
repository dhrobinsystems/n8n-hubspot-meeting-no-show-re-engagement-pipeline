// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { isPlaceholder, loadNoShowConfig, readBooleanEnv, validateNoShowConfig } from '../src/core/config.js';
import { extractEvents, filterDuplicateEvents, validateIntake, verifyCalendlySignature } from '../src/core/intake.js';
import { buildStageIndex, buildTaskRequest, enforceSandbox, parseCalendlyInvitee, parseWriteResponse } from '../src/core/hubspot.js';
import { decideDeals, filterNoShows, localHour, normalizeSmsNumber, renderTemplate, routeChannels } from '../src/core/noshow.js';
import { buildFailureAlert, buildTwilioMessageRequest, planContactStamps, planDealUpdates, planSmsSends, planTasks, redactSecrets } from '../src/core/actions.js';
import { createDemoRecords, createDemoWebhookBodies, createMockCalendly, createMockHubSpot, createMockTwilio, DEMO_NOW, DEMO_PIPELINES, DEMO_STAGE_MAP } from '../src/core/mocks.js';
import { demoEvents, processEvents, runDemo, runPipeline, createHttpClient } from '../src/core/pipeline.js';
import { parseDotEnv } from '../src/index.js';

const NOW = Date.parse(DEMO_NOW);
const SECRET = 'test-shared-secret-long-enough-value';
const hmacHex = (secret, text) => createHmac('sha256', secret).update(text, 'utf8').digest('hex');
const STAGES = buildStageIndex(DEMO_PIPELINES);
const LIVE_SMS = {
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'example-account-sid',
  TWILIO_AUTH_TOKEN: 'example-auth-token',
  TWILIO_FROM_NUMBER: '+15555550100',
  SMS_SANDBOX_RECIPIENT: '+15555550199',
  REBOOKING_URL: 'https://example.com/book-again',
};
const HUBSPOT_ENV = {
  HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token',
  WEBHOOK_SECRET: SECRET,
  PIPELINE_NOW: DEMO_NOW,
  NO_SHOW_DEAL_STAGE_MAP: JSON.stringify(DEMO_STAGE_MAP),
  CALENDLY_API_TOKEN: 'test-calendly-token',
  ...LIVE_SMS,
};
const SANDBOX_ACCOUNT = { portalId: 12345678, accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' };
const contact = (properties) => ({ id: '1', properties: { email: 'person@example.com', firstname: 'Pat', ...properties } });

function services(options = {}) {
  const records = createDemoRecords();
  return {
    records,
    hubspot: createMockHubSpot({ records, account: SANDBOX_ACCOUNT, ...options.hubspot }),
    calendly: createMockCalendly({ records }),
    twilio: createMockTwilio(options.twilio),
  };
}

/* ---------- configuration ---------- */

test('placeholders and boolean switches fail safe', () => {
  for (const value of ['YOUR_HUBSPOT_PRIVATE_APP_TOKEN', 'YOUR_CALENDAR_WEBHOOK_SECRET', '', null, 'changeme']) {
    assert.equal(isPlaceholder(value), true, String(value));
  }
  assert.equal(readBooleanEnv('flase', true), true);
  assert.equal(readBooleanEnv('off', true), false);
});

test('an empty environment is demo mode, dry run and sandbox, with no SMS or errors', () => {
  const config = loadNoShowConfig({});
  assert.equal(config.mode, 'demo');
  assert.equal(config.dryRun, true);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.sms.provider, 'none');
  assert.deepEqual(validateNoShowConfig(config).errors, []);
});

test('live mode needs a real token; HubSpot mode needs a webhook secret or Calendly key', () => {
  assert.match(validateNoShowConfig(loadNoShowConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' })).errors.join('\n'), /needs a real HUBSPOT_PRIVATE_APP_TOKEN/);
  assert.match(validateNoShowConfig(loadNoShowConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token' })).errors.join('\n'), /Set WEBHOOK_SECRET/);
  assert.deepEqual(validateNoShowConfig(loadNoShowConfig(HUBSPOT_ENV)).errors, []);
});

test('Twilio, sequence, URL, time zone, hours and stage map settings are validated', () => {
  const errors = validateNoShowConfig(loadNoShowConfig({
    SMS_PROVIDER: 'twilio',
    EMAIL_PROVIDER: 'hubspot_sequence',
    SMS_TIMEZONE: 'Mars/Base',
    SMS_ALLOWED_HOURS: '20-9',
    NO_SHOW_DEAL_STAGE_MAP: '[1,2]',
    REBOOKING_URL: 'http://example.com',
    CHANNEL_PRIORITY: 'sms,pigeon',
    SMS_SANDBOX_RECIPIENT: '555',
  })).errors.join('\n');
  for (const pattern of [
    /needs TWILIO_ACCOUNT_SID/,
    /needs TWILIO_FROM_NUMBER/,
    /numeric HUBSPOT_SEQUENCE_ID/,
    /not a valid IANA time zone/,
    /SMS_ALLOWED_HOURS/,
    /NO_SHOW_DEAL_STAGE_MAP must be JSON/,
    /REBOOKING_URL must use https/,
    /unknown channels: pigeon/,
    /SMS_SANDBOX_RECIPIENT must be an E.164/,
  ]) {
    assert.match(errors, pattern);
  }
  assert.deepEqual(loadNoShowConfig({ NO_SHOW_DEAL_STAGE_MAP: '{"default":"YOUR_NO_SHOW_DEAL_STAGE_ID"}' }).deals.stageMap, {}, 'placeholder stage IDs are ignored');
});

/* ---------- intake ---------- */

test('HubSpot workflow calls need the shared secret; responses never echo it', () => {
  const config = loadNoShowConfig(HUBSPOT_ENV);
  assert.equal(validateIntake({ headers: { 'x-webhook-secret': 'wrong' }, body: { objectId: 301 } }, config, [], {}, NOW, hmacHex).statusCode, 401);
  const ok = validateIntake({ headers: { 'X-Webhook-Secret': SECRET }, body: { objectId: 301 } }, config, [], {}, NOW, hmacHex);
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.events[0].eventKey, 'hubspot:meeting:301');
  assert.ok(!