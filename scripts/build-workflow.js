#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Generates workflow.json from src/core/*.js. Each Code node receives the core modules it needs
 * (imports and `export` stripped) plus a short block of node logic; HTTP Request nodes execute the
 * requests those Code nodes plan. Secrets are only read from $env inside node expressions.
 *
 *   npm run build:workflow     regenerate
 *   npm run check:workflow     fail when workflow.json is out of date
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_PATH = join(ROOT, 'workflow.json');
export const WORKFLOW_NAME = 'n8n-hubspot-meeting-no-show-re-engagement-pipeline';
export const WEBHOOK_PATH = 'meeting-no-show';
export const LICENSE_LINE = 'DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.';

export const NODE = Object.freeze({
  webhook: 'Calendar Webhook Trigger',
  validate: 'Validate Intake',
  respond: 'Respond to Webhook',
  accepted: 'Intake Accepted?',
  raise: 'Raise If Misconfigured',
  manual: 'Manual Run',
  manualBatch: 'Build Manual Batch',
  route: 'Load Config & Route',
  isDemo: 'Demo Mode?',
  demo: 'Run Demo Pipeline',
  account: 'HubSpot: Get Account Details',
  enforce: 'Enforce Sandbox & Plan Reads',
  pipelines: 'HubSpot: Get Deal Pipelines',
  owners: 'HubSpot: List Owners',
  planCalendly: 'Plan Calendly Invitee Lookups',
  needCalendly: 'Calendly Lookups Needed?',
  calendly: 'Calendly: Get Invitee',
  tagCalendly: 'Tag Calendly Responses',
  planLookups: 'Plan Meeting & Contact Lookups',
  lookup: 'HubSpot: Read Meeting or Contact',
  tagLookups: 'Tag Lookup Responses',
  filter: 'HubSpot Meeting Status Filter (No-Show Check)',
  noShows: 'No-Shows Found?',
  needDetails: 'Detail Reads Needed?',
  details: 'HubSpot: Read Contact & Deals',
  tagDetails: 'Tag Detail Responses',
  decide: 'Decide Re-Engagement Plan',
  planDeals: 'Plan Deal Stage Updates',
  needDeals: 'Deal Updates Needed?',
  dealUpdate: 'HubSpot: Deal Stage Update',
  tagDeals: 'Tag Deal Update Results',
  router: 'Re-Engagement Email/SMS Router',
  needSms: 'SMS Route?',
  twilio: 'Twilio: Send Re-Engagement SMS',
  tagSms: 'Tag SMS Results',
  planSequences: 'Plan Email Sequence Enrollments',
  needSequences: 'Email Sequence Route?',
  enroll: 'HubSpot: Enroll in Email Sequence',
  tagSequences: 'Tag Sequence Results',
  planStamps: 'Plan Contact Re-Engagement Stamps',
  needStamps: 'Contact Stamps Needed?',
  stamp: 'HubSpot: Stamp Contact (Email Workflow Trigger)',
  tagStamps: 'Tag Stamp Results',
  planTasks: 'Plan Rep Follow-Up Tasks',
  needTasks: 'Rep Tasks Needed?',
  task: 'HubSpot: Rep Task Creation',
  tagTasks: 'Tag Task Results',
  finalize: 'Finalize Run',
  errorTrigger: 'On Workflow Error',
  buildFailure: 'Build Redacted Failure Alert',
  needFailure: 'Failure Alert Enabled?',
  sendFailure: 'Send Failure Alert',
  note: 'Read Me: Safety Defaults',
});

const MODULES = {
  config: 'src/core/config.js',
  intake: 'src/core/intake.js',
  hubspot: 'src/core/hubspot.js',
  noshow: 'src/core/noshow.js',
  actions: 'src/core/actions.js',
  mocks: 'src/core/mocks.js',
  pipeline: 'src/core/pipeline.js',
};
const ENGINE = ['config', 'hubspot', 'noshow', 'actions'];
const NOSHOW = ['config', 'hubspot', 'noshow'];
const WRITES = ['config', 'hubspot', 'actions'];
const ALL = Object.keys(MODULES);

export function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*\r?\n/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '')
    .replace(new RegExp(`^// ${LICENSE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`, 'm'), '');
}

function topLevelNames(source) {
  const names = [];
  const pattern = /^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm;
  let match;
  while ((match = pattern.exec(source))) names.push(match[1] || match[2]);
  return names;
}

const HELPERS = `
// ---- n8n node helpers ----
function nodeOutputs(name) {
  try {
    const reference = $(name);
    if (reference && reference.isExecuted === false) return [];
    return reference.all().map((item) => item.json);
  } catch (error) {
    return [];
  }
}
function firstOutput(name) {
  const outputs = nodeOutputs(name);
  return outputs.length ? outputs[0] : null;
}
function countPlanned(name) {
  return nodeOutputs(name).filter((json) => !json.skip).length;
}
function assertStageComplete(stage, expected, received) {
  if (expected !== received) throw new Error('No-show pipeline stopped: the ' + stage + ' stage planned ' + expected + ' request(s) but received ' + received + ' response(s).');
}
function runNow() {
  const route = firstOutput(${JSON.stringify(NODE.route)});
  const parsed = route ? Date.parse(route.now) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function planItems(stage, plans) {
  if (!plans.length) return [{ json: { stage, skip: true } }];
  return plans.map((plan) => ({ json: { stage, ...plan }, pairedItem: { item: 0 } }));
}
function currentCases() {
  const decided = firstOutput(${JSON.stringify(NODE.decide)});
  return decided ? decided.cases : [];
}
`;

export function embed(moduleKeys, logic) {
  const seen = new Map();
  const parts = [];
  for (const key of moduleKeys) {
    const source = stripModuleSyntax(readFileSync(join(ROOT, MODULES[key]), 'utf8'));
    for (const name of topLevelNames(source)) {
      if (seen.has(name)) throw new Error(`Top-level name "${name}" is declared in both ${seen.get(name)} and ${MODULES[key]}`);
      seen.set(name, MODULES[key]);
    }
    parts.push(`// ---- ${MODULES[key]} (embedded by scripts/build-workflow.js) ----\n${source.trim()}\n`);
  }
  for (const name of [...topLevelNames(HELPERS), ...topLevelNames(logic.trim())]) if (seen.has(name)) throw new Error(`"${name}" collides with ${seen.get(name)}`);
  return [`// ${LICENSE_LINE}`, '// Generated by scripts/build-workflow.js. Edit src/core and rebuild instead of editing here.', ...parts, HELPERS.trim(), '', '// ---- node logic ----', logic.trim(), ''].join('\n');
}

const N = (name) => JSON.stringify(NODE[name]);
const tagWith = (planNode, mapper) => `
return $input.all().map((item, index) => {
  const plan = $(${N(planNode)}).itemMatching(index).json;
  return { json: ${mapper}, pairedItem: { item: index } };
});`;

const LOGIC = {
  validate: `
const crypto = require('crypto');
const config = loadNoShowConfig($env);
const { errors } = validateNoShowConfig(config);
const item = $input.first().json;
const hmacHex = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('hex');
const result = validateIntake({ headers: item.headers || {}, body: item.body }, config, errors, $getWorkflowStaticData('global'), resolveNow(config), hmacHex);
return [{ json: { ...result, trigger: 'webhook' } }];`,
  raise: `
if ($input.first().json.configError) {
  const { errors } = validateNoShowConfig(loadNoShowConfig($env));
  throw new Error('Configuration invalid:\\n- ' + errors.join('\\n- '));
}
return [];`,
  manualBatch: `
const config = loadNoShowConfig($env);
const now = resolveNow(config);
if (config.mode === 'demo') return [{ json: { trigger: 'manual', events: [], requestId: 'manual-' + now.toString(36) } }];
if (!config.manualTestMeetingIds.length) throw new Error('Set MANUAL_TEST_MEETING_IDS (comma-separated sandbox meeting IDs) to run this workflow manually.');
const events = config.manualTestMeetingIds.flatMap((meetingId) => extractEvents({ objectId: meetingId }, 50).events);
return [{ json: { trigger: 'manual', events, requestId: 'manual-' + now.toString(36) } }];`,
  route: `
const config = loadNoShowConfig($env);
const { errors, warnings } = validateNoShowConfig(config);
if (errors.length) throw new Error('Configuration invalid:\\n- ' + errors.join('\\n- '));
const item = $input.first().json;
return [{ json: { mode: config.mode, trigger: item.trigger, requestId: item.requestId, events: item.events, now: new Date(resolveNow(config)).toISOString(), safety: describeSafety(config), warnings, request: buildAccountDetailsRequest(config) } }];`,
  demo: `
const config = loadNoShowConfig($env);
const route = $input.first().json;
const result = await runDemo({ config, events: route.trigger === 'manual' ? null : route.events, state: $getWorkflowStaticData('global') });
return [{ json: { source: 'demo', cases: result.cases, report: result.report, results: result.results, totals: result.totals, skipReasons: result.skipReasons } }];`,
  enforce: `
const config = loadNoShowConfig($env);
const gate = enforceSandbox($input.first().json, config);
if (!gate.ok) throw new Error(gate.reason);
return [{ json: { portal: { portalId: gate.portalId, uiDomain: gate.uiDomain }, pipelinesRequest: buildPipelinesRequest(config), ownersRequest: buildOwnersRequest(config) } }];`,
  planCalendly: `
const config = loadNoShowConfig($env);
return planItems('calendly', planCalendlyLookups(firstOutput(${N('route')}).events, config));`,
  tagCalendly: tagWith('planCalendly', '{ eventKey: plan.eventKey, ...parseCalendlyInvitee(item.json) }'),
  planLookups: `
const config = loadNoShowConfig($env);
const calendly = nodeOutputs(${N('tagCalendly')});
assertStageComplete('Calendly lookup', countPlanned(${N('planCalendly')}), calendly.length);
const events = applyCalendlyLookups(firstOutput(${N('route')}).events, calendly);
return planItems('lookups', planPrimaryLookups(events, config));`,
  tagLookups: tagWith('planLookups', '{ eventKey: plan.eventKey, kind: plan.kind, ...parseObjectResponse(item.json) }'),
  filter: `
const config = loadNoShowConfig($env);
const lookups = nodeOutputs(${N('tagLookups')});
assertStageComplete('meeting/contact lookup', countPlanned(${N('planLookups')}), lookups.length);
const events = applyCalendlyLookups(firstOutput(${N('route')}).events, nodeOutputs(${N('tagCalendly')}));
const filtered = filterNoShows(events, lookups, config);
const noShows = filtered.some((entry) => entry.status === 'no_show') ? 'yes' : 'no';
const plans = noShows === 'yes' ? planDetailReads(filtered, config) : [];
const meta = { filtered };
if (!plans.length) return [{ json: { stage: 'details', skip: true, noShows, meta } }];
return plans.map((plan) => ({ json: { stage: 'details', ...plan, noShows, meta }, pairedItem: { item: 0 } }));`,
  tagDetails: tagWith('filter', '{ kind: plan.kind, ...parseObjectResponse(item.json), id: plan.id }'),
  decide: `
const config = loadNoShowConfig($env);
const details = nodeOutputs(${N('tagDetails')});
assertStageComplete('detail read', countPlanned(${N('filter')}), details.length);
const stageIndex = buildStageIndex(firstOutput(${N('pipelines')}));
const owners = buildOwnerIndex(nodeOutputs(${N('owners')}));
const cases = buildCases(firstOutput(${N('filter')}).meta.filtered, details, stageIndex, owners, firstOutput(${N('enforce')}).portal, config, runNow());
return [{ json: { stage: 'decided', cases } }];`,
  planDeals: `
return planItems('deals', planDealUpdates(currentCases(), loadNoShowConfig($env)));`,
  tagDeals: tagWith('planDeals', 'parseWriteResponse(plan.key, item.json)'),
  router: `
return planItems('sms', planSmsSends(currentCases(), loadNoShowConfig($env)));`,
  tagSms: tagWith('router', 'parseWriteResponse(plan.key, item.json)'),
  planSequences: `
return planItems('sequences', planSequenceEnrollments(currentCases(), loadNoShowConfig($env)));`,
  tagSequences: tagWith('planSequences', 'parseWriteResponse(plan.key, item.json)'),
  planStamps: `
return planItems('stamps', planContactStamps(currentCases(), loadNoShowConfig($env)));`,
  tagStamps: tagWith('planStamps', 'parseWriteResponse(plan.key, item.json)'),
  planTasks: `
return planItems('tasks', planTasks(currentCases(), loadNoShowConfig($env)));`,
  tagTasks: tagWith('planTasks', 'parseWriteResponse(plan.key, item.json)'),
  finalize: `
const route = firstOutput(${N('route')});
const demo = firstOutput(${N('demo')});
let cases;
let results;
let totals;
let skipReasons;
if (demo) {
  ({ cases, results, totals, skipReasons } = demo);
} else {
  cases = currentCases();
  if (!cases.length) cases = (firstOutput(${N('filter')}) || { meta: { filtered: [] } }).meta.filtered;
  const stages = [['deals', ${N('planDeals')}, ${N('tagDeals')}], ['sms', ${N('router')}, ${N('tagSms')}], ['sequences', ${N('planSequences')}, ${N('tagSequences')}], ['stamps', ${N('planStamps')}, ${N('tagStamps')}], ['tasks', ${N('planTasks')}, ${N('tagTasks')}]];
  results = {};
  for (const [stage, planNode, tagNode] of stages) {
    results[stage] = nodeOutputs(tagNode);
    assertStageComplete(stage, countPlanned(planNode), results[stage].length);
  }
  const summary = summarizeCases(cases);
  skipReasons = summary.skipReasons;
  totals = buildRunTotals(summary.counters, results);
  recordDailyCounters($getWorkflowStaticData('global'), totals, runNow());
}
const failed = Object.entries(results).flatMap(([stage, list]) => list.filter((result) => !result.ok).map((result) => stage + ' ' + result.key + ': ' + result.error));
if (failed.length) throw new Error(failed.length + ' write(s) failed in request ' + route.requestId + ' (successful writes were kept): ' + failed.slice(0, 5).join(' | '));
return [{ json: { requestId: route.requestId, safety: route.safety, totals, skipReasons, cases: cases.map(caseReport) } }];`,
  buildFailure: `
const config = loadNoShowConfig($env);
const data = $input.first().json || {};
const execution = data.execution || {};
const message = buildFailureAlert({
  errorMessage: execution.error && execution.error.message,
  lastNode: execution.lastNodeExecuted,
  executionId: execution.id,
  workflowName: data.workflow && data.workflow.name,
  config,
  secrets: [config.hubspot.token, config.sms.authToken, config.sms.accountSid, config.calendly.apiToken, config.webhook.secret, config.webhook.calendlySigningKey],
});
return [{ json: { send: alertsEnabled(config) ? 'yes' : 'no', message } }];`,
};

function nodeId(name) {
  const hex = createHash('sha256').update(`${WORKFLOW_NAME}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function code(name, position, modules, logic, notes) {
  return { parameters: { mode: 'runOnceForAllItems', jsCode: embed(modules, logic) }, id: nodeId(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, ...(notes ? { notes, notesInFlow: false } : {}) };
}

function condition(name, position, leftValue, rightValue) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: nodeId(`${name}:condition`), leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    },
    id: nodeId(name), name, type: 'n8n-nodes-base.if', typeVersion: 2, position,
  };
}

const skipIf = (name, position) => condition(name, position, "={{ $json.skip ? 'skip' : 'run' }}", 'run');

function http(name, position, { method, url, auth, body, form, continueOnError = true, batching = false, pagination = null, retries = 3, notes }) {
  const parameters = { method, url, options: { timeout: 20000 } };
  if (auth) { parameters.sendHeaders = true; parameters.headerParameters = { parameters: [{ name: 'Authorization', value: auth }] }; }
  if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
  if (form) { parameters.sendBody = true; parameters.contentType = 'raw'; parameters.rawContentType = 'application/x-www-form-urlencoded'; parameters.body = form; }
  if (batching) parameters.options.batching = { batch: { batchSize: 5, batchInterval: 1000 } };
  if (pagination) parameters.options.pagination = pagination;
  return {
    parameters, id: nodeId(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    retryOnFail: true, maxTries: retries, waitBetweenTries: 2000,
    ...(continueOnError ? { onError: 'continueRegularOutput' } : {}),
    ...(notes ? { notes, notesInFlow: false } : {}),
  };
}

const HUBSPOT_AUTH = '=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}';
const CALENDLY_AUTH = '=Bearer {{ $env.CALENDLY_API_TOKEN }}';
const TWILIO_AUTH = "={{ 'Basic ' + ($env.TWILIO_ACCOUNT_SID + ':' + $env.TWILIO_AUTH_TOKEN).base64Encode() }}";
const OWNER_PAGINATION = {
  pagination: {
    paginationMode: 'updateAParameterInEachRequest',
    parameters: { parameters: [{ type: 'qs', name: 'after', value: "={{ $response.body.paging && $response.body.paging.next ? $response.body.paging.next.after : '' }}" }] },
    paginationCompleteWhen: 'other',
    completeExpression: '={{ !($response.body.paging && $response.body.paging.next && $response.body.paging.next.after) }}',
    limitPagesFetched: true,
    maxRequests: 10,
    requestInterval: 200,
  },
};

const STICKY = `## No-show re-engagement pipeline: safety defaults
- **Demo mode** while HUBSPOT_PRIVATE_APP_TOKEN is a placeholder: fictional records, mock HubSpot, Calendly and Twilio.
- **DRY_RUN=true**: decides everything, writes and sends nothing.
- **SANDBOX_MODE=true**: refuses production portals; SMS only to SMS_SANDBOX_RECIPIENT.
- SMS needs explicit consent, a usable number and the allowed hours. Email respects the opt-out property.
- Cooldown per contact, event de-duplication, redacted failure alerts.

${LICENSE_LINE}`;

export function buildWorkflow() {
  const x = (column) => column * 220;
  const nodes = [
    { parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} }, id: nodeId(NODE.webhook), name: NODE.webhook, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [x(0), 200], webhookId: nodeId(`${NODE.webhook}:id`), notes: 'One endpoint for HubSpot meeting workflows (shared secret) and Calendly webhook subscriptions (signed).', notesInFlow: false },
    code(NODE.validate, [x(1), 200], ['config', 'intake'], LOGIC.validate, 'Shared secret or Calendly signature, event normalisation and EVENT_DEDUPE_DAYS de-duplication. Needs NODE_FUNCTION_ALLOW_BUILTIN=crypto.'),
    { parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.response) }}', options: { responseCode: '={{ $json.statusCode }}' } }, id: nodeId(NODE.respond), name: NODE.respond, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [x(2), 40] },
    condition(NODE.accepted, [x(2), 240], "={{ $json.accepted ? 'yes' : 'no' }}", 'yes'),
    code(NODE.raise, [x(3), 420], ['config'], LOGIC.raise, 'Fails the execution after a 503, so the error branch alerts.'),
    { parameters: {}, id: nodeId(NODE.manual), name: NODE.manual, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [x(0), 520] },
    code(NODE.manualBatch, [x(1), 520], ['config', 'intake'], LOGIC.manualBatch, 'Demo: bundled events. HubSpot mode: MANUAL_TEST_MEETING_IDS.'),
    code(NODE.route, [x(3), 240], ['config', 'hubspot'], LOGIC.route, 'Validates configuration and pins one clock for the run.'),
    condition(NODE.isDemo, [x(4), 240], '={{ $json.mode }}', 'demo'),
    code(NODE.demo, [x(5), 40], ALL, LOGIC.demo, 'Fictional records behind mock HubSpot, Calendly and Twilio. No network.'),
    http(NODE.account, [x(5), 340], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, continueOnError: false }),
    code(NODE.enforce, [x(6), 340], ['config', 'hubspot'], LOGIC.enforce, 'Stops unless the portal is a sandbox or developer test account (SANDBOX_MODE=true).'),
    http(NODE.pipelines, [x(7), 340], { method: 'GET', url: '={{ $json.pipelinesRequest.url }}', auth: HUBSPOT_AUTH, continueOnError: false }),
    http(NODE.owners, [x(8), 340], { method: 'GET', url: `={{ $(${N('enforce')}).first().json.ownersRequest.url }}`, auth: HUBSPOT_AUTH, continueOnError: false, pagination: OWNER_PAGINATION }),
    code(NODE.planCalendly, [x(9), 340], NOSHOW, LOGIC.planCalendly, 'Calendly no-show payloads that carry only the invitee URI are resolved to an email.'),
    skipIf(NODE.needCalendly, [x(10), 340]),
    http(NODE.calendly, [x(11), 240], { method: 'GET', url: '={{ $json.request.url }}', auth: CALENDLY_AUTH, notes: 'GET the invitee (only https://api.calendly.com URIs). Header from $env.CALENDLY_API_TOKEN.' }),
    code(NODE.tagCalendly, [x(12), 240], ['config', 'hubspot'], LOGIC.tagCalendly),
    code(NODE.planLookups, [x(13), 340], NOSHOW, LOGIC.planLookups),
    http(NODE.lookup, [x(14), 340], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, batching: true, notes: 'HubSpot events: the meeting with contact and deal associations. Calendly events: the contact by email.' }),
    code(NODE.tagLookups, [x(15), 340], ['config', 'hubspot'], LOGIC.tagLookups),
    code(NODE.filter, [x(16), 340], NOSHOW, LOGIC.filter, 'Keeps only meetings whose hs_meeting_outcome is in NO_SHOW_OUTCOME_VALUES, and Calendly no-shows that match a HubSpot contact.'),
    condition(NODE.noShows, [x(17), 340], '={{ $json.noShows }}', 'yes'),
    skipIf(NODE.needDetails, [x(18), 240]),
    http(NODE.details, [x(19), 140], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, batching: true }),
    code(NODE.tagDetails, [x(20), 140], ['config', 'hubspot'], LOGIC.tagDetails),
    code(NODE.decide, [x(21), 240], NOSHOW, LOGIC.decide, 'Deal stage policy, channel router decision, contact stamp and rep task content for every no-show.'),
    code(NODE.planDeals, [x(22), 240], WRITES, LOGIC.planDeals, 'Open deals only; never moves a deal backwards unless ALLOW_BACKWARD_STAGE_MOVES=true.'),
    skipIf(NODE.needDeals, [x(23), 240]),
    http(NODE.dealUpdate, [x(24), 140], { method: 'PATCH', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, body: '={{ JSON.stringify($json.request.body) }}' }),
    code(NODE.tagDeals, [x(25), 140], ['config', 'hubspot'], LOGIC.tagDeals),
    code(NODE.router, [x(26), 240], WRITES, LOGIC.router, 'Plans one SMS per no-show routed to SMS (consent, number, hours, sandbox recipient already checked).'),
    skipIf(NODE.needSms, [x(27), 240]),
    http(NODE.twilio, [x(28), 140], { method: 'POST', url: "={{ $json.request.url.replace('{ACCOUNT_SID}', $env.TWILIO_ACCOUNT_SID) }}", auth: TWILIO_AUTH, form: '={{ $json.request.form }}', retries: 2, notes: 'Twilio Messages API. The account SID and credentials come from $env at request time.' }),
    code(NODE.tagSms, [x(29), 140], ['config', 'hubspot'], LOGIC.tagSms),
    code(NODE.planSequences, [x(30), 240], WRITES, LOGIC.planSequences, 'Only with EMAIL_PROVIDER=hubspot_sequence. With hubspot_workflow the contact stamp starts the email workflow.'),
    skipIf(NODE.needSequences, [x(31), 240]),
    http(NODE.enroll, [x(32), 140], { method: 'POST', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, body: '={{ JSON.stringify($json.request.body) }}', retries: 2 }),
    code(NODE.tagSequences, [x(33), 140], ['config', 'hubspot'], LOGIC.tagSequences),
    code(NODE.planStamps, [x(34), 240], WRITES, LOGIC.planStamps, 'Writes status, last re-engaged at and no-show count. "email_triggered" enrols the contact in the HubSpot email workflow.'),
    skipIf(NODE.needStamps, [x(35), 240]),
    http(NODE.stamp, [x(36), 140], { method: 'PATCH', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, body: '={{ JSON.stringify($json.request.body) }}' }),
    code(NODE.tagStamps, [x(37), 140], ['config', 'hubspot'], LOGIC.tagStamps),
    code(NODE.planTasks, [x(38), 240], WRITES, LOGIC.planTasks, 'One HIGH priority task per no-show, associated with the contact (204) and deal (216).'),
    skipIf(NODE.needTasks, [x(39), 240]),
    http(NODE.task, [x(40), 140], { method: 'POST', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, body: '={{ JSON.stringify($json.request.body) }}', retries: 2 }),
    code(NODE.tagTasks, [x(41), 140], ['config', 'hubspot'], LOGIC.tagTasks),
    code(NODE.finalize, [x(42), 340], ENGINE, LOGIC.finalize, 'Run summary and daily counters. Fails the execution if any write failed, after the others were kept.'),
    { parameters: {}, id: nodeId(NODE.errorTrigger), name: NODE.errorTrigger, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [x(0), 820] },
    code(NODE.buildFailure, [x(1), 820], ['config', 'actions'], LOGIC.buildFailure, 'Redacts tokens, SIDs, webhook URLs, phone numbers and emails.'),
    condition(NODE.needFailure, [x(2), 820], '={{ $json.send }}', 'yes'),
    http(NODE.sendFailure, [x(3), 720], { method: 'POST', url: '={{ $env.ALERT_WEBHOOK_URL }}', body: '={{ JSON.stringify($json.message) }}', retries: 2, continueOnError: false }),
    { parameters: { content: STICKY, height: 320, width: 560, color: 4 }, id: nodeId(NODE.note), name: NODE.note, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x(0), -280] },
  ];

  const link = (...branches) => ({ main: branches.map((targets) => targets.map((node) => ({ node, type: 'main', index: 0 }))) });
  const chain = (planNode, ifNode, httpNode, tagNode, next) => ({
    [planNode]: link([ifNode]),
    [ifNode]: link([httpNode], [next]),
    [httpNode]: link([tagNode]),
    [tagNode]: link([next]),
  });
  const connections = {
    [NODE.webhook]: link([NODE.validate]),
    [NODE.validate]: link([NODE.respond, NODE.accepted]),
    [NODE.accepted]: link([NODE.route], [NODE.raise]),
    [NODE.manual]: link([NODE.manualBatch]),
    [NODE.manualBatch]: link([NODE.route]),
    [NODE.route]: link([NODE.isDemo]),
    [NODE.isDemo]: link([NODE.demo], [NODE.account]),
    [NODE.demo]: link([NODE.finalize]),
    [NODE.account]: link([NODE.enforce]),
    [NODE.enforce]: link([NODE.pipelines]),
    [NODE.pipelines]: link([NODE.owners]),
    [NODE.owners]: link([NODE.planCalendly]),
    ...chain(NODE.planCalendly, NODE.needCalendly, NODE.calendly, NODE.tagCalendly, NODE.planLookups),
    [NODE.planLookups]: link([NODE.lookup]),
    [NODE.lookup]: link([NODE.tagLookups]),
    [NODE.tagLookups]: link([NODE.filter]),
    [NODE.filter]: link([NODE.noShows]),
    [NODE.noShows]: link([NODE.needDetails], [NODE.finalize]),
    [NODE.needDetails]: link([NODE.details], [NODE.decide]),
    [NODE.details]: link([NODE.tagDetails]),
    [NODE.tagDetails]: link([NODE.decide]),
    [NODE.decide]: link([NODE.planDeals]),
    ...chain(NODE.planDeals, NODE.needDeals, NODE.dealUpdate, NODE.tagDeals, NODE.router),
    ...chain(NODE.router, NODE.needSms, NODE.twilio, NODE.tagSms, NODE.planSequences),
    ...chain(NODE.planSequences, NODE.needSequences, NODE.enroll, NODE.tagSequences, NODE.planStamps),
    ...chain(NODE.planStamps, NODE.needStamps, NODE.stamp, NODE.tagStamps, NODE.planTasks),
    ...chain(NODE.planTasks, NODE.needTasks, NODE.task, NODE.tagTasks, NODE.finalize),
    [NODE.errorTrigger]: link([NODE.buildFailure]),
    [NODE.buildFailure]: link([NODE.needFailure]),
    [NODE.needFailure]: link([NODE.sendFailure], []),
  };

  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false, license: LICENSE_LINE },
    tags: [],
  };
}

export function serializeWorkflow() {
  return `${JSON.stringify(buildWorkflow(), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = serializeWorkflow();
  if (process.argv.includes('--check')) {
    if (readFileSync(WORKFLOW_PATH, 'utf8') !== output) {
      console.error('workflow.json is out of date. Run "npm run build:workflow".');
      process.exit(1);
    }
    console.log('workflow.json is up to date.');
  } else {
    writeFileSync(WORKFLOW_PATH, output);
    console.log(`Wrote ${WORKFLOW_PATH} (${buildWorkflow().nodes.length} nodes, ${Math.round(Buffer.byteLength(output) / 1024)} KB)`);
  }
}
