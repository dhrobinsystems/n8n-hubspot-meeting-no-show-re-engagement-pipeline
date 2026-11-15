// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Write planners for every action the pipeline takes, plus run totals and redacted failure alerts.
 * Every planner returns [] under DRY_RUN, so no write or message can leave a dry run.
 */
import { buildContactUpdateRequest, buildDealStageUpdateRequest, buildSequenceEnrollmentRequest, buildTaskRequest } from './hubspot.js';

/** Twilio Messages API. The account SID stays a {ACCOUNT_SID} token that the n8n node fills from $env. */
export function buildTwilioMessageRequest(config, sms) {
  const form = new URLSearchParams();
  form.set('To', sms.to);
  if (config.sms.messagingServiceSid && !/YOUR_/.test(config.sms.messagingServiceSid)) form.set('MessagingServiceSid', config.sms.messagingServiceSid);
  else form.set('From', config.sms.from);
  form.set('Body', sms.body);
  return { method: 'POST', url: `${config.sms.baseUrl}/2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json`, form: form.toString() };
}

const active = (cases) => cases.filter((entry) => entry.status === 'no_show');

export function planDealUpdates(cases, config) {
  if (config.dryRun) return [];
  const seen = new Set();
  const plans = [];
  for (const entry of active(cases)) {
    for (const decision of entry.dealDecisions) {
      if (decision.action !== 'update' || seen.has(decision.dealId)) continue;
      seen.add(decision.dealId);
      plans.push({ key: `deal:${decision.dealId}`, request: buildDealStageUpdateRequest(config, decision.dealId, decision.targetStageId) });
    }
  }
  return plans;
}

export function planSmsSends(cases, config) {
  if (config.dryRun) return [];
  return active(cases).filter((entry) => entry.route.sms).map((entry) => ({ key: `sms:${entry.eventKey}`, request: buildTwilioMessageRequest(config, entry.route.sms) }));
}

export function planSequenceEnrollments(cases, config) {
  if (config.dryRun || config.email.provider !== 'hubspot_sequence') return [];
  return active(cases)
    .filter((entry) => entry.route.channels.includes('email') && entry.sequenceSender)
    .map((entry) => ({ key: `sequence:${entry.eventKey}`, request: buildSequenceEnrollmentRequest(config, { contactId: entry.contact.id, ...entry.sequenceSender }) }));
}

/** Contact stamps record the outcome. With EMAIL_PROVIDER=hubspot_workflow the "email_triggered" stamp starts the email workflow. */
export function planContactStamps(cases, config) {
  if (config.dryRun) return [];
  const byContact = {};
  for (const entry of active(cases)) byContact[entry.contact.id] = entry;
  return Object.values(byContact).map((entry) => ({ key: `contact:${entry.contact.id}`, request: buildContactUpdateRequest(config, entry.contact.id, entry.stamp) }));
}

export function planTasks(cases, config) {
  if (config.dryRun) return [];
  return active(cases).filter((entry) => entry.task).map((entry) => ({ key: `task:${entry.eventKey}`, request: buildTaskRequest(config, entry.task) }));
}

export function buildRunTotals(counters, results) {
  const count = (stage, ok) => (results[stage] || []).filter((result) => result.ok === ok).length;
  return {
    ...counters,
    dealsUpdated: count('deals', true),
    smsSent: count('sms', true),
    sequencesEnrolled: count('sequences', true),
    contactsStamped: count('stamps', true),
    tasksCreated: count('tasks', true),
    failures: ['deals', 'sms', 'sequences', 'stamps', 'tasks'].reduce((sum, stage) => sum + count(stage, false), 0),
  };
}

/** Per-case report with masked contact data, for the execution log and the CLI. */
export function caseReport(entry) {
  if (entry.status !== 'no_show') return { eventKey: entry.eventKey, source: entry.source, status: 'skipped', reason: entry.skipReason };
  return {
    eventKey: entry.eventKey,
    source: entry.source,
    status: 'no_show',
    contactId: entry.contact.id,
    contactName: entry.contact.name,
    meeting: entry.meetingTitle || null,
    deals: entry.dealDecisions.map((decision) => ({ dealId: decision.dealId, action: decision.action, reason: decision.reason || null, from: decision.fromStage || null, to: decision.toStage || null })),
    channels: entry.route.channels,
    reengagementStatus: entry.route.status,
    channelNotes: entry.route.reasons,
    smsTo: entry.route.sms ? entry.route.sms.originalNumberMasked : null,
    taskOwner: entry.ownerName || (entry.task && entry.task.ownerId) || null,
  };
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
  /pat-[a-z0-9]+-[A-Za-z0-9-]+/gi,
  /\bAC[0-9a-f]{32}\b/gi,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
  /\+?\d[\d\s().-]{7,}\d/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/** Removes tokens, Twilio SIDs, webhook URLs, phone numbers and email addresses. */
export function redactSecrets(value, extraSecrets = []) {
  let output = String(value ?? '');
  for (const secret of extraSecrets) if (secret && String(secret).length >= 6) output = output.split(String(secret)).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}

export function buildFailureAlert({ errorMessage, lastNode, executionId, workflowName, config, secrets }) {
  const message = redactSecrets(errorMessage || 'Unknown error', secrets).slice(0, 1500);
  const label = config.dryRun || config.sandboxMode ? ' [DRY RUN / SANDBOX]' : '';
  return {
    text: `No-show re-engagement pipeline failed${label}${lastNode ? ` in "${lastNode}"` : ''}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'No-show re-engagement pipeline failed', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `:x: Node: *${lastNode || 'unknown'}*${label}\n\`\`\`${message}\`\`\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow ${workflowName || 'n8n-hubspot-meeting-no-show-re-engagement-pipeline'} · execution ${executionId || 'unknown'}` }] },
    ],
  };
}

/** 30 days of daily counters in n8n workflow static data (or a CLI state file). */
export function recordDailyCounters(state, totals, now) {
  const store = state.noShowDailyCounters || (state.noShowDailyCounters = {});
  const day = new Date(now).toISOString().slice(0, 10);
  const bucket = store[day] || (store[day] = { runs: 0 });
  bucket.runs += 1;
  for (const [key, value] of Object.entries(totals)) if (typeof value === 'number') bucket[key] = (bucket[key] || 0) + value;
  const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(store)) if (key < cutoff) delete store[key];
  return bucket;
}
