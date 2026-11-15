// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Webhook intake for two sources on one endpoint:
 * - HubSpot meeting-based workflow ("Meeting outcome changed" → Send a webhook) with a shared-secret header.
 * - Calendly webhook subscription (invitee_no_show.created), verified with Calendly-Webhook-Signature:
 *   t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.rawBody" with the signing key>.
 * Events are normalised, and replays are dropped for EVENT_DEDUPE_DAYS.
 */
import { isPlaceholder } from './config.js';

export function constantTimeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}

export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

/** `hmacHex(secret, text)` is injected (Node crypto), so this module stays dependency-free. */
export function verifyCalendlySignature({ headers, rawBody, config, now, hmacHex }) {
  const header = headerValue(headers, 'calendly-webhook-signature');
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=')).filter((pair) => pair.length === 2));
  if (!parts.t || !parts.v1) return { ok: false, reason: 'signature_header_missing' };
  const sentAt = Number(parts.t) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > config.webhook.maxSignatureAgeMinutes * 60000) return { ok: false, reason: 'signature_timestamp_outside_window' };
  const expected = hmacHex(config.webhook.calendlySigningKey, `${parts.t}.${rawBody}`);
  return constantTimeEqual(parts.v1.toLowerCase(), expected.toLowerCase()) ? { ok: true, reason: null } : { ok: false, reason: 'signature_mismatch' };
}

function firstDefined(...values) {
  const found = values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return found === undefined ? null : String(found).trim();
}

function normalizeCalendly(body) {
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const invitee = payload.invitee && typeof payload.invitee === 'object' ? payload.invitee : null;
  const inviteeUri = firstDefined(typeof payload.invitee === 'string' ? payload.invitee : null, invitee && invitee.uri, payload.invitee_uri);
  const email = firstDefined(payload.email, invitee && invitee.email, payload.invitee_email);
  const scheduled = payload.scheduled_event || (invitee && invitee.scheduled_event) || {};
  return {
    source: 'calendly',
    eventKey: `calendly:${firstDefined(payload.uri, inviteeUri, `${email}:${scheduled.start_time}`)}`,
    action: body.event === 'invitee_no_show.created' ? 'no_show' : body.event === 'invitee_no_show.deleted' ? 'no_show_removed' : 'ignored',
    meetingId: null,
    email: email ? email.toLowerCase() : null,
    inviteeUri,
    firstName: firstDefined(payload.first_name, invitee && invitee.first_name),
    meetingTitle: firstDefined(scheduled.name, payload.event_name),
    scheduledAt: firstDefined(scheduled.start_time, payload.start_time),
  };
}

function normalizeHubSpot(entry) {
  const nested = entry.properties && entry.properties.hs_object_id;
  const meetingId = firstDefined(entry.meetingId, entry.objectId, entry.hs_object_id, nested && typeof nested === 'object' ? nested.value : nested);
  if (!meetingId || !/^\d{1,20}$/.test(meetingId)) return null;
  return { source: 'hubspot', eventKey: `hubspot:meeting:${meetingId}`, action: 'check_outcome', meetingId, email: null, inviteeUri: null, firstName: null, meetingTitle: null, scheduledAt: null };
}

/** Normalises a request body into events. Calendly sends one event per request; HubSpot sends one meeting. */
export function extractEvents(body, maxEvents) {
  const entries = Array.isArray(body) ? body : body && typeof body === 'object' ? (Array.isArray(body.events) ? body.events : [body]) : [];
  const events = [];
  let ignored = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') { ignored += 1; continue; }
    const event = typeof entry.event === 'string' && entry.payload ? normalizeCalendly(entry) : normalizeHubSpot(entry);
    if (!event || event.action === 'ignored') { ignored += 1; continue; }
    events.push(event);
  }
  const overflow = Math.max(0, events.length - maxEvents);
  return { events: events.slice(0, maxEvents), ignored, overflow };
}

/** Drops events whose key was processed within EVENT_DEDUPE_DAYS (state: n8n workflow static data or a CLI file). */
export function filterDuplicateEvents(events, state, now, days) {
  const seen = state.processedEventKeys || (state.processedEventKeys = {});
  for (const [key, at] of Object.entries(seen)) if (now - at > days * 86400000) delete seen[key];
  const fresh = [];
  let duplicates = 0;
  for (const event of events) {
    if (event.action === 'no_show' || event.action === 'check_outcome') {
      if (seen[event.eventKey]) { duplicates += 1; continue; }
      seen[event.eventKey] = now;
    }
    fresh.push(event);
  }
  return { fresh, duplicates };
}

export function newRequestId(now) {
  return `ns-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns { accepted, statusCode, response, events, requestId, configError, source }. Never echoes secrets or payloads. */
export function validateIntake({ headers, body, rawBody }, config, configErrors, state, now, hmacHex) {
  const requestId = newRequestId(now);
  const reply = (statusCode, response, extra = {}) => ({ accepted: false, statusCode, response: { requestId, ...response }, events: [], requestId, configError: false, ...extra });
  if (configErrors.length) return reply(503, { error: 'pipeline_not_configured' }, { configError: true });

  const isCalendly = Boolean(headerValue(headers, 'calendly-webhook-signature'));
  const demoWithoutSecrets = config.mode === 'demo' && isPlaceholder(config.webhook.secret) && isPlaceholder(config.webhook.calendlySigningKey);
  if (!demoWithoutSecrets) {
    if (isCalendly) {
      if (isPlaceholder(config.webhook.calendlySigningKey)) return reply(401, { error: 'unauthorized' });
      const raw = typeof rawBody === 'string' ? rawBody : JSON.stringify(body ?? '');
      if (!verifyCalendlySignature({ headers, rawBody: raw, config, now, hmacHex }).ok) return reply(401, { error: 'unauthorized' });
    } else if (isPlaceholder(config.webhook.secret) || !constantTimeEqual(headerValue(headers, config.webhook.headerName), config.webhook.secret)) {
      return reply(401, { error: 'unauthorized' });
    }
  }
  let payload = body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return reply(400, { error: 'invalid_json' }); }
  }
  const { events, ignored, overflow } = extractEvents(payload, config.webhook.maxEventsPerRequest);
  const { fresh, duplicates } = filterDuplicateEvents(events, state, now, config.webhook.dedupeDays);
  const actionable = fresh.filter((event) => event.action !== 'no_show_removed');
  const removed = fresh.length - actionable.length;
  if (!actionable.length) return reply(200, { accepted: 0, ignored, duplicates, noShowRemovals: removed, note: 'nothing to re-engage' });
  return {
    accepted: true,
    statusCode: 202,
    response: { requestId, accepted: actionable.length, ignored, duplicates, overflow, noShowRemovals: removed, mode: config.mode, dryRun: config.dryRun },
    events: actionable,
    requestId,
    configError: false,
  };
}
