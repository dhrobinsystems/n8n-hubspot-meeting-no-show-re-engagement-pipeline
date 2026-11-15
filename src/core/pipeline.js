// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Node.js mirror of workflow.json: the same functions in the same order as the n8n nodes.
 */
import { isPlaceholder, resolveNow, validateNoShowConfig } from './config.js';
import { extractEvents } from './intake.js';
import {
  buildAccountDetailsRequest, buildOwnerIndex, buildOwnersRequest, buildPipelinesRequest, buildStageIndex, enforceSandbox,
  parseCalendlyInvitee, parseObjectResponse, parseWriteResponse,
} from './hubspot.js';
import { applyCalendlyLookups, buildCases, filterNoShows, planCalendlyLookups, planDetailReads, planPrimaryLookups, summarizeCases } from './noshow.js';
import { buildRunTotals, caseReport, planContactStamps, planDealUpdates, planSequenceEnrollments, planSmsSends, planTasks, recordDailyCounters, redactSecrets } from './actions.js';
import { createDemoRecords, createDemoWebhookBodies, createMockCalendly, createMockHubSpot, createMockTwilio, DEMO_NOW, DEMO_STAGE_MAP } from './mocks.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** fetch wrapper: JSON or form bodies, retries on 429/5xx (Retry-After honoured), returns { status, body } for every response. */
export function createHttpClient({ authorization, fetchImpl = globalThis.fetch, maxRetries = 3, baseDelayMs = 1000, secrets = [], fillUrl = (url) => url }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available. Use Node.js 20 or newer.');
  return async function send(req) {
    const url = fillUrl(req.url);
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        const headers = { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json' };
        let body;
        if (req.form !== undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = req.form; } else if (req.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(req.body); }
        response = await fetchImpl(url, { method: req.method, headers, body });
      } catch (error) {
        if (attempt < maxRetries) { await sleep(baseDelayMs * 2 ** attempt); continue; }
        throw new Error(redactSecrets(`Request to ${new URL(url).host} failed: ${error.message}`, secrets));
      }
      const raw = await response.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw.slice(0, 200) }; }
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      return { status: response.status, body: parsed };
    }
  };
}

function unwrap(response) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  return { error: { status: response.status, message: body.message || (body.error && body.error.message) || `HTTP ${response.status}` } };
}

async function required(http, request, label) {
  const response = await http(request);
  if (response.status < 200 || response.status >= 300) throw new Error(`HubSpot ${label} failed with ${response.status}`);
  return response.body;
}

/**
 * Processes normalised events end to end. Clients resolve to { status, body }.
 * Returns { cases, report, results, totals }.
 */
export async function processEvents({ config, events, hubspotHttp, calendlyHttp, twilioHttp, now, state = {} }) {
  const gate = enforceSandbox(await required(hubspotHttp, buildAccountDetailsRequest(config), 'account check'), config);
  if (!gate.ok) throw new Error(gate.reason);
  const portal = { portalId: gate.portalId, uiDomain: gate.uiDomain };
  const stageIndex = buildStageIndex(await required(hubspotHttp, buildPipelinesRequest(config), 'pipeline read'));
  const owners = buildOwnerIndex([await required(hubspotHttp, buildOwnersRequest(config), 'owner read')]);

  const calendlyLookups = [];
  for (const plan of planCalendlyLookups(events, config)) calendlyLookups.push({ eventKey: plan.eventKey, ...parseCalendlyInvitee(unwrap(await calendlyHttp(plan.request))) });
  const resolved = applyCalendlyLookups(events, calendlyLookups);

  const lookups = [];
  for (const plan of planPrimaryLookups(resolved, config)) lookups.push({ eventKey: plan.eventKey, kind: plan.kind, ...parseObjectResponse(unwrap(await hubspotHttp(plan.request))) });
  const filtered = filterNoShows(resolved, lookups, config);

  const details = [];
  for (const plan of planDetailReads(filtered, config)) {
    const parsed = parseObjectResponse(unwrap(await hubspotHttp(plan.request)));
    details.push({ kind: plan.kind, ...parsed, id: plan.id });
  }
  const cases = buildCases(filtered, details, stageIndex, owners, portal, config, now);

  const results = { deals: [], sms: [], sequences: [], stamps: [], tasks: [] };
  for (const plan of planDealUpdates(cases, config)) results.deals.push(parseWriteResponse(plan.key, unwrap(await hubspotHttp(plan.request))));
  for (const plan of planSmsSends(cases, config)) results.sms.push(parseWriteResponse(plan.key, unwrap(await twilioHttp(plan.request))));
  for (const plan of planSequenceEnrollments(cases, config)) results.sequences.push(parseWriteResponse(plan.key, unwrap(await hubspotHttp(plan.request))));
  for (const plan of planContactStamps(cases, config)) results.stamps.push(parseWriteResponse(plan.key, unwrap(await hubspotHttp(plan.request))));
  for (const plan of planTasks(cases, config)) results.tasks.push(parseWriteResponse(plan.key, unwrap(await hubspotHttp(plan.request))));

  const { counters, skipReasons } = summarizeCases(cases);
  const totals = buildRunTotals(counters, results);
  recordDailyCounters(state, totals, now);
  return { cases, report: cases.map(caseReport), results, totals, skipReasons, portal };
}

export function demoEvents() {
  return createDemoWebhookBodies().flatMap((body) => extractEvents(body, 50).events).filter((event) => event.action !== 'no_show_removed');
}

/** Demo mode: bundled fictional records behind mocks, the demo stage map, fixed clock, SMS via the mock. */
export async function runDemo({ config, events = null, state = {} }) {
  const records = createDemoRecords();
  const hubspot = createMockHubSpot({ records });
  const calendly = createMockCalendly({ records });
  const twilio = createMockTwilio();
  const demoConfig = {
    ...config,
    deals: { ...config.deals, stageMap: Object.keys(config.deals.stageMap).length ? config.deals.stageMap : { ...DEMO_STAGE_MAP } },
    sms: config.sms.provider === 'twilio' ? config.sms : { ...config.sms, provider: 'twilio', from: '+15555550100', sandboxRecipient: isPlaceholder(config.sms.sandboxRecipient) ? '+15555550199' : config.sms.sandboxRecipient },
    rebookUrl: isPlaceholder(config.rebookUrl) ? 'https://example.com/book-again' : config.rebookUrl,
  };
  const result = await processEvents({ config: demoConfig, events: events && events.length ? events : demoEvents(), hubspotHttp: hubspot.request, calendlyHttp: calendly.request, twilioHttp: twilio.request, now: Date.parse(DEMO_NOW), state });
  return { ...result, hubspot, twilio, calendly };
}

export function basicAuthHeader(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Full run with real HTTP clients (or injected ones), after configuration validation. */
export async function runPipeline({ config, events, fetchImpl = globalThis.fetch, hubspotHttp, calendlyHttp, twilioHttp, state = {} }) {
  const { errors } = validateNoShowConfig(config);
  if (errors.length) throw new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
  if (config.mode === 'demo') return runDemo({ config, events, state });
  const secrets = [config.hubspot.token, config.sms.authToken, config.calendly.apiToken, config.webhook.secret, config.webhook.calendlySigningKey];
  return processEvents({
    config,
    events,
    hubspotHttp: hubspotHttp || createHttpClient({ authorization: `Bearer ${config.hubspot.token}`, fetchImpl, secrets }),
    calendlyHttp: calendlyHttp || createHttpClient({ authorization: `Bearer ${config.calendly.apiToken}`, fetchImpl, secrets }),
    twilioHttp: twilioHttp || createHttpClient({ authorization: basicAuthHeader(config.sms.accountSid, config.sms.authToken), fetchImpl, secrets, fillUrl: (url) => url.replace('{ACCOUNT_SID}', encodeURIComponent(config.sms.accountSid)) }),
    now: resolveNow(config),
    state,
  });
}
