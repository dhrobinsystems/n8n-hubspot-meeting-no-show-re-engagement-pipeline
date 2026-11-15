// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Configuration for the no-show re-engagement pipeline. Every switch fails safe:
 * - DRY_RUN and SANDBOX_MODE stay on unless explicitly set to false/0/no/off.
 * - A placeholder HubSpot token puts the pipeline in demo mode (bundled fictional records, no network).
 * - DRY_RUN blocks every write and every message: deal updates, contact stamps, tasks, SMS, sequences.
 * - SANDBOX_MODE refuses production portals and redirects SMS to SMS_SANDBOX_RECIPIENT (or sends none).
 */

export const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
export const DEFAULT_TWILIO_BASE_URL = 'https://api.twilio.com';
export const DEFAULT_CALENDLY_BASE_URL = 'https://api.calendly.com';
export const SANDBOX_ACCOUNT_TYPES = Object.freeze(['SANDBOX', 'DEVELOPER_TEST']);
export const CHANNELS = Object.freeze(['sms', 'email']);
export const EMAIL_PROVIDERS = Object.freeze(['hubspot_workflow', 'hubspot_sequence', 'none']);
export const SMS_PROVIDERS = Object.freeze(['twilio', 'none']);
export const DEAL_SELECTIONS = Object.freeze(['most_recent', 'all']);
export const MIN_SECRET_LENGTH = 24;

const PLACEHOLDER_PATTERN = /^(?:|your_[a-z0-9_]+|changeme|change_me|placeholder|x{3,})$/i;
const EMBEDDED_PLACEHOLDER_PATTERN = /YOUR_[A-Z0-9_]{3,}/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** True for empty values and template placeholders such as YOUR_HUBSPOT_PRIVATE_APP_TOKEN. */
export function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return PLACEHOLDER_PATTERN.test(text) || EMBEDDED_PLACEHOLDER_PATTERN.test(text);
}

/** Only recognised true/false words change a switch; anything else keeps the safe fallback. */
export function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function readList(value) {
  if (value === undefined || value === null || isPlaceholder(value)) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readNumber(raw, fallback, { min, max, integer = true }, name, problems) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(String(raw).trim());
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    problems.push(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (received "${raw}")`);
    return fallback;
  }
  return number;
}

function readChoice(raw, fallback, choices, name, problems) {
  const value = String(raw === undefined || raw === null || String(raw).trim() === '' ? fallback : raw).trim().toLowerCase();
  if (!choices.includes(value)) {
    problems.push(`${name} must be one of ${choices.join(', ')} (received "${raw}")`);
    return fallback;
  }
  return value;
}

function readStageMap(raw, problems) {
  if (raw === undefined || raw === null || isPlaceholder(raw)) return {};
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object');
    const map = {};
    for (const [pipelineId, stageId] of Object.entries(parsed)) {
      if (isPlaceholder(stageId)) continue;
      map[String(pipelineId)] = String(stageId);
    }
    return map;
  } catch (error) {
    problems.push(`NO_SHOW_DEAL_STAGE_MAP must be JSON like {"default":"YOUR_NO_SHOW_STAGE_ID"} (${error.message})`);
    return {};
  }
}

function readHours(raw, problems) {
  const text = String(raw === undefined || raw === null || String(raw).trim() === '' ? '9-20' : raw).trim();
  const match = text.match(/^(\d{1,2})-(\d{1,2})$/);
  const start = match ? Number(match[1]) : NaN;
  const end = match ? Number(match[2]) : NaN;
  if (!match || start > 23 || end > 24 || start >= end) {
    problems.push(`SMS_ALLOWED_HOURS must look like 9-20 (received "${raw}")`);
    return { start: 9, end: 20 };
  }
  return { start, end };
}

function isValidTimeZone(zone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** Builds runtime configuration from n8n `$env` or `process.env`. options.forceMode pins "demo" or "hubspot". */
export function loadNoShowConfig(env = {}, options = {}) {
  const source = env || {};
  const problems = [];
  const read = (name) => {
    const value = source[name];
    return value === undefined || value === null ? undefined : String(value).trim();
  };
  const token = read('HUBSPOT_PRIVATE_APP_TOKEN') || '';
  const smsTimeZone = read('SMS_TIMEZONE') || 'America/New_York';
  if (!isValidTimeZone(smsTimeZone)) problems.push(`SMS_TIMEZONE "${smsTimeZone}" is not a valid IANA time zone`);
  const channelPriority = readList(read('CHANNEL_PRIORITY'));
  const config = {
    mode: options.forceMode || (isPlaceholder(token) ? 'demo' : 'hubspot'),
    dryRun: readBooleanEnv(read('DRY_RUN'), true),
    sandboxMode: readBooleanEnv(read('SANDBOX_MODE'), true),
    hubspot: {
      token,
      baseUrl: (read('HUBSPOT_BASE_URL') || DEFAULT_HUBSPOT_BASE_URL).replace(/\/+$/, ''),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID') || '',
      noShowOutcomes: (readList(read('NO_SHOW_OUTCOME_VALUES')).length ? readList(read('NO_SHOW_OUTCOME_VALUES')) : ['NO_SHOW']).map((value) => value.toUpperCase()),
    },
    webhook: {
      secret: read('WEBHOOK_SECRET') || '',
      headerName: (read('WEBHOOK_SECRET_HEADER') || 'x-webhook-secret').toLowerCase(),
      calendlySigningKey: read('CALENDLY_WEBHOOK_SIGNING_KEY') || '',
      maxSignatureAgeMinutes: readNumber(read('WEBHOOK_MAX_AGE_MINUTES'), 5, { min: 1, max: 60 }, 'WEBHOOK_MAX_AGE_MINUTES', problems),
      maxEventsPerRequest: readNumber(read('MAX_EVENTS_PER_REQUEST'), 50, { min: 1, max: 200 }, 'MAX_EVENTS_PER_REQUEST', problems),
      dedupeDays: readNumber(read('EVENT_DEDUPE_DAYS'), 7, { min: 1, max: 90 }, 'EVENT_DEDUPE_DAYS', problems),
    },
    calendly: {
      apiToken: read('CALENDLY_API_TOKEN') || '',
      baseUrl: (read('CALENDLY_BASE_URL') || DEFAULT_CALENDLY_BASE_URL).replace(/\/+$/, ''),
    },
    deals: {
      stageMap: readStageMap(read('NO_SHOW_DEAL_STAGE_MAP'), problems),
      selection: readChoice(read('DEAL_SELECTION'), 'most_recent', DEAL_SELECTIONS, 'DEAL_SELECTION', problems),
      allowBackwardMoves: readBooleanEnv(read('ALLOW_BACKWARD_STAGE_MOVES'), false),
      maxDealsPerContact: readNumber(read('MAX_DEALS_PER_EVENT'), 10, { min: 1, max: 50 }, 'MAX_DEALS_PER_EVENT', problems),
    },
    routing: {
      channelPriority: channelPriority.length ? channelPriority.map((entry) => entry.toLowerCase()) : ['sms', 'email'],
      sendBoth: readBooleanEnv(read('SEND_BOTH_CHANNELS'), false),
      cooldownDays: readNumber(read('REENGAGEMENT_COOLDOWN_DAYS'), 7, { min: 0, max: 365 }, 'REENGAGEMENT_COOLDOWN_DAYS', problems),
      smsConsentProperty: read('SMS_CONSENT_PROPERTY') || 'sms_marketing_consent',
      emailOptOutProperty: read('EMAIL_OPT_OUT_PROPERTY') || 'hs_email_optout',
    },
    sms: {
      provider: readChoice(read('SMS_PROVIDER'), 'none', SMS_PROVIDERS, 'SMS_PROVIDER', problems),
      accountSid: read('TWILIO_ACCOUNT_SID') || '',
      authToken: read('TWILIO_AUTH_TOKEN') || '',
      from: read('TWILIO_FROM_NUMBER') || '',
      messagingServiceSid: read('TWILIO_MESSAGING_SERVICE_SID') || '',
      baseUrl: (read('TWILIO_BASE_URL') || DEFAULT_TWILIO_BASE_URL).replace(/\/+$/, ''),
      sandboxRecipient: read('SMS_SANDBOX_RECIPIENT') || '',
      timeZone: smsTimeZone,
      allowedHours: readHours(read('SMS_ALLOWED_HOURS'), problems),
      defaultCountryCode: (read('SMS_DEFAULT_COUNTRY_CODE') || '1').replace(/^\+/, ''),
      template: read('SMS_TEMPLATE') || 'Hi {{firstName}}, sorry we missed each other today. Pick a new time that suits you: {{rebookUrl}} Reply STOP to opt out.',
    },
    email: {
      provider: readChoice(read('EMAIL_PROVIDER'), 'hubspot_workflow', EMAIL_PROVIDERS, 'EMAIL_PROVIDER', problems),
      sequenceId: read('HUBSPOT_SEQUENCE_ID') || '',
    },
    rebookUrl: read('REBOOKING_URL') || '',
    properties: {
      status: read('REENGAGEMENT_STATUS_PROPERTY') || 'no_show_reengagement_status',
      lastReengagedAt: read('REENGAGEMENT_TIMESTAMP_PROPERTY') || 'no_show_last_reengaged_at',
      count: read('NO_SHOW_COUNT_PROPERTY') || 'no_show_count',
    },
    tasks: {
      enabled: readBooleanEnv(read('CREATE_REP_TASKS'), true),
      dueHours: readNumber(read('TASK_DUE_HOURS'), 2, { min: 1, max: 168 }, 'TASK_DUE_HOURS', problems),
      fallbackOwnerId: read('FALLBACK_TASK_OWNER_ID') || '',
    },
    alerts: { webhookUrl: read('ALERT_WEBHOOK_URL') || '' },
    manualTestMeetingIds: readList(read('MANUAL_TEST_MEETING_IDS')),
    nowOverride: read('PIPELINE_NOW') || null,
    problems,
  };
  if (config.nowOverride && !Number.isFinite(Date.parse(config.nowOverride))) problems.push(`PIPELINE_NOW must be an ISO 8601 timestamp (received "${config.nowOverride}")`);
  const unknownChannels = config.routing.channelPriority.filter((channel) => !CHANNELS.includes(channel));
  if (unknownChannels.length) problems.push(`CHANNEL_PRIORITY contains unknown channels: ${unknownChannels.join(', ')} (use sms, email)`);
  return config;
}

export function isLiveMode(config) {
  return !config.dryRun && !config.sandboxMode;
}

export function resolveNow(config) {
  const parsed = config.nowOverride ? Date.parse(config.nowOverride) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function smsEnabled(config) {
  return config.sms.provider === 'twilio';
}

export function alertsEnabled(config) {
  return !isPlaceholder(config.alerts.webhookUrl) && /^https:\/\//.test(config.alerts.webhookUrl);
}

export function describeSafety(config) {
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    smsProvider: config.sms.provider,
    emailProvider: config.email.provider,
    writesPossible: config.mode === 'hubspot' && !config.dryRun,
  };
}

/** Returns { errors, warnings }. Any error stops the workflow before it touches HubSpot, Twilio or Calendly. */
export function validateNoShowConfig(config) {
  const errors = [...config.problems];
  const warnings = [];
  const live = isLiveMode(config);

  for (const [key, name] of Object.entries(config.properties)) {
    if (!PROPERTY_NAME_PATTERN.test(name)) errors.push(`contact property for ${key} ("${name}") is not a valid HubSpot property name`);
  }
  for (const name of [config.routing.smsConsentProperty, config.routing.emailOptOutProperty]) {
    if (!PROPERTY_NAME_PATTERN.test(name)) errors.push(`"${name}" is not a valid HubSpot property name`);
  }
  if (!isPlaceholder(config.alerts.webhookUrl) && !/^https:\/\//.test(config.alerts.webhookUrl)) errors.push('ALERT_WEBHOOK_URL must use https://');
  if (smsEnabled(config)) {
    if (isPlaceholder(config.sms.accountSid) || isPlaceholder(config.sms.authToken)) errors.push('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (or set SMS_PROVIDER=none)');
    if (isPlaceholder(config.sms.from) && isPlaceholder(config.sms.messagingServiceSid)) errors.push('SMS_PROVIDER=twilio needs TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
    if (isPlaceholder(config.rebookUrl) && config.sms.template.includes('{{rebookUrl}}')) errors.push('SMS_TEMPLATE uses {{rebookUrl}}, so REBOOKING_URL must be set');
    if (!isPlaceholder(config.sms.sandboxRecipient) && !/^\+\d{8,15}$/.test(config.sms.sandboxRecipient)) errors.push('SMS_SANDBOX_RECIPIENT must be an E.164 number such as +15555550100');
  }
  if (!isPlaceholder(config.rebookUrl) && !/^https:\/\//.test(config.rebookUrl)) errors.push('REBOOKING_URL must use https://');
  if (config.email.provider === 'hubspot_sequence' && (isPlaceholder(config.email.sequenceId) || !/^\d+$/.test(config.email.sequenceId))) errors.push('EMAIL_PROVIDER=hubspot_sequence needs a numeric HUBSPOT_SEQUENCE_ID');

  if (config.mode === 'demo') {
    if (live) errors.push('Live mode (DRY_RUN=false and SANDBOX_MODE=false) needs a real HUBSPOT_PRIVATE_APP_TOKEN. Replace the placeholder or turn DRY_RUN back on.');
    warnings.push('HUBSPOT_PRIVATE_APP_TOKEN is a placeholder, so the pipeline runs against bundled fictional records and makes no network calls.');
    return { errors, warnings };
  }

  if (!/^https:\/\//.test(config.hubspot.baseUrl)) errors.push('HUBSPOT_BASE_URL must use https://');
  const hasSecret = !isPlaceholder(config.webhook.secret) && config.webhook.secret.length >= MIN_SECRET_LENGTH;
  const hasCalendly = !isPlaceholder(config.webhook.calendlySigningKey);
  if (!hasSecret && !hasCalendly) errors.push(`Set WEBHOOK_SECRET (at least ${MIN_SECRET_LENGTH} characters, for HubSpot workflow webhooks) and/or CALENDLY_WEBHOOK_SIGNING_KEY`);
  if (!isPlaceholder(config.webhook.secret) && config.webhook.secret.length < MIN_SECRET_LENGTH) errors.push(`WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  if (!isPlaceholder(config.hubspot.sandboxPortalId) && !/^\d+$/.test(config.hubspot.sandboxPortalId)) errors.push('HUBSPOT_SANDBOX_PORTAL_ID must be numeric when set');
  if (!Object.keys(config.deals.stageMap).length) warnings.push('NO_SHOW_DEAL_STAGE_MAP is empty, so deal stages are never changed.');
  if (hasCalendly && isPlaceholder(config.calendly.apiToken)) warnings.push('CALENDLY_API_TOKEN is not set; Calendly no-show events without an invitee email in the payload are skipped.');
  if (config.email.provider === 'none' && !smsEnabled(config)) warnings.push('Both EMAIL_PROVIDER and SMS_PROVIDER are none: only rep tasks are created.');
  if (live && !alertsEnabled(config)) warnings.push('Live mode without ALERT_WEBHOOK_URL: failures are only visible in the n8n execution log.');
  return { errors, warnings };
}
