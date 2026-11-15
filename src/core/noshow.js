// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * The no-show engine: meeting status filter, deal stage policy, re-engagement channel router
 * and rep task content. Pure functions; every write is planned here and executed elsewhere.
 */
import { isPlaceholder, smsEnabled } from './config.js';
import {
  buildCalendlyInviteeRequest, buildContactByEmailRequest, buildContactReadRequest, buildDealReadRequest, buildMeetingReadRequest, recordUrl,
} from './hubspot.js';

const DAY_MS = 86400000;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/* ---------- 1. Calendly invitee lookups (only when the payload has no email) ---------- */

export function planCalendlyLookups(events, config) {
  const tokenReady = config.mode === 'demo' || !isPlaceholder(config.calendly.apiToken);
  return events
    .filter((event) => event.source === 'calendly' && !event.email && event.inviteeUri && tokenReady)
    .map((event) => ({ eventKey: event.eventKey, request: buildCalendlyInviteeRequest(config, event.inviteeUri) }))
    .filter((plan) => plan.request);
}

export function applyCalendlyLookups(events, lookups) {
  const byKey = Object.fromEntries(lookups.map((lookup) => [lookup.eventKey, lookup]));
  return events.map((event) => {
    const lookup = byKey[event.eventKey];
    if (!lookup || !lookup.found) return event;
    return { ...event, email: lookup.email, firstName: event.firstName || lookup.firstName };
  });
}

/* ---------- 2. Primary lookups: the meeting (HubSpot) or the contact by email (Calendly) ---------- */

export function planPrimaryLookups(events, config) {
  const plans = [];
  for (const event of events) {
    if (event.source === 'hubspot') plans.push({ eventKey: event.eventKey, kind: 'meeting', request: buildMeetingReadRequest(config, event.meetingId) });
    else if (event.email) plans.push({ eventKey: event.eventKey, kind: 'contact', request: buildContactByEmailRequest(config, event.email) });
  }
  return plans;
}

/**
 * The HubSpot Meeting Status Filter. Returns one case per event:
 * { eventKey, source, status: 'no_show' | 'skipped', skipReason, meeting, contactId, contact, dealIds }.
 */
export function filterNoShows(events, lookups, config) {
  const byKey = Object.fromEntries(lookups.map((lookup) => [lookup.eventKey, lookup]));
  return events.map((event) => {
    const base = { eventKey: event.eventKey, source: event.source, firstName: event.firstName, meetingTitle: event.meetingTitle, scheduledAt: event.scheduledAt };
    const lookup = byKey[event.eventKey];
    if (event.source === 'calendly' && !event.email) return { ...base, status: 'skipped', skipReason: 'calendly_invitee_email_unknown' };
    if (!lookup || !lookup.found) return { ...base, status: 'skipped', skipReason: event.source === 'calendly' ? 'contact_not_in_hubspot' : 'meeting_not_readable' };
    if (event.source === 'hubspot') {
      const outcome = text(lookup.properties.hs_meeting_outcome).toUpperCase();
      if (!config.hubspot.noShowOutcomes.includes(outcome)) return { ...base, status: 'skipped', skipReason: `outcome_${(outcome || 'empty').toLowerCase()}` };
      if (!lookup.contactIds.length) return { ...base, status: 'skipped', skipReason: 'no_associated_contact' };
      return {
        ...base,
        status: 'no_show',
        meeting: { id: lookup.id, title: text(lookup.properties.hs_meeting_title) || null, startTime: text(lookup.properties.hs_meeting_start_time) || null, ownerId: text(lookup.properties.hubspot_owner_id) || null },
        meetingTitle: text(lookup.properties.hs_meeting_title) || event.meetingTitle,
        scheduledAt: text(lookup.properties.hs_meeting_start_time) || event.scheduledAt,
        contactId: lookup.contactIds[0],
        extraContacts: lookup.contactIds.length - 1,
        contact: null,
        dealIds: lookup.dealIds,
      };
    }
    return { ...base, status: 'no_show', meeting: null, contactId: lookup.id, extraContacts: 0, contact: { id: lookup.id, properties: lookup.properties }, dealIds: lookup.dealIds };
  });
}

/* ---------- 3. Detail reads: contacts (meeting path) and deals ---------- */

export function planDetailReads(cases, config) {
  const plans = [];
  const contacts = new Set();
  const deals = new Set();
  for (const entry of cases.filter((item) => item.status === 'no_show')) {
    if (!entry.contact && !contacts.has(entry.contactId)) {
      contacts.add(entry.contactId);
      plans.push({ kind: 'contact', id: entry.contactId, request: buildContactReadRequest(config, entry.contactId) });
    }
    for (const dealId of entry.dealIds.slice(0, config.deals.maxDealsPerContact)) {
      if (deals.has(dealId)) continue;
      deals.add(dealId);
      plans.push({ kind: 'deal', id: dealId, request: buildDealReadRequest(config, dealId) });
    }
  }
  return plans;
}

/* ---------- 4. Deal stage policy ---------- */

export function decideDeals(deals, stageIndex, config) {
  const open = deals.filter((deal) => {
    const stage = stageIndex[text(deal.properties.dealstage)];
    return !stage || !stage.closed;
  }).sort((a, b) => (Date.parse(b.properties.createdate) || 0) - (Date.parse(a.properties.createdate) || 0));
  if (!deals.length) return [{ dealId: null, action: 'skip', reason: 'no_associated_deal' }];
  if (!open.length) return [{ dealId: null, action: 'skip', reason: 'no_open_deal' }];
  const selected = config.deals.selection === 'all' ? open : open.slice(0, 1);
  return selected.map((deal) => {
    const current = stageIndex[text(deal.properties.dealstage)] || null;
    const base = { dealId: deal.id, dealName: text(deal.properties.dealname) || `Deal ${deal.id}`, ownerId: text(deal.properties.hubspot_owner_id) || null, fromStage: current ? current.label : text(deal.properties.dealstage) };
    if (!current) return { ...base, action: 'skip', reason: 'unknown_stage' };
    const targetId = config.deals.stageMap[current.pipelineId];
    const target = targetId ? stageIndex[targetId] : null;
    if (!targetId) return { ...base, action: 'skip', reason: 'no_target_stage_for_pipeline' };
    if (!target || target.pipelineId !== current.pipelineId) return { ...base, action: 'skip', reason: 'target_stage_not_in_pipeline' };
    if (current.id === target.id) return { ...base, action: 'skip', reason: 'already_in_no_show_stage', toStage: target.label };
    if (!config.deals.allowBackwardMoves && current.order > target.order) return { ...base, action: 'skip', reason: 'deal_beyond_no_show_stage', toStage: target.label };
    return { ...base, action: 'update', targetStageId: target.id, toStage: target.label };
  });
}

/* ---------- 5. Re-engagement channel router ---------- */

export function normalizeSmsNumber(raw, defaultCountryCode) {
  const value = text(raw);
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (value.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (defaultCountryCode === '1' && digits.length === 10) return `+1${digits}`;
  if (digits.startsWith(defaultCountryCode) && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function localHour(now, timeZone) {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(hour) % 24;
}

export function renderTemplate(template, values) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (values[key] === undefined || values[key] === null ? '' : String(values[key]))).replace(/\s{2,}/g, ' ').trim().slice(0, 480);
}

function isTrue(value) {
  return ['true', 'yes', '1'].includes(text(value).toLowerCase());
}

/**
 * Picks the channel(s) for one contact: cooldown first, then CHANNEL_PRIORITY, with SMS needing explicit
 * consent, a usable number, the allowed hours and (in sandbox mode) a test recipient; email needing an
 * address, no opt-out and an email provider.
 */
export function routeChannels(contact, config, now, context) {
  const properties = contact.properties;
  const reasons = [];
  const lastAt = Date.parse(text(properties[config.properties.lastReengagedAt]));
  if (config.routing.cooldownDays > 0 && Number.isFinite(lastAt) && now - lastAt < config.routing.cooldownDays * DAY_MS) {
    return { channels: [], status: 'skipped_cooldown', reasons: [`re-engaged ${Math.floor((now - lastAt) / DAY_MS)} day(s) ago (cooldown ${config.routing.cooldownDays} days)`], sms: null };
  }
  const eligible = [];
  let sms = null;
  for (const channel of config.routing.channelPriority) {
    if (channel === 'sms') {
      const number = normalizeSmsNumber(properties.mobilephone || properties.phone, config.sms.defaultCountryCode);
      const hour = localHour(now, config.sms.timeZone);
      if (!smsEnabled(config)) reasons.push('sms: SMS_PROVIDER=none');
      else if (!isTrue(properties[config.routing.smsConsentProperty])) reasons.push(`sms: no explicit consent in ${config.routing.smsConsentProperty}`);
      else if (!number) reasons.push('sms: no usable mobile number');
      else if (hour < config.sms.allowedHours.start || hour >= config.sms.allowedHours.end) reasons.push(`sms: outside allowed hours (${hour}:00 in ${config.sms.timeZone})`);
      else if (config.sandboxMode && isPlaceholder(config.sms.sandboxRecipient)) reasons.push('sms: SANDBOX_MODE is on and SMS_SANDBOX_RECIPIENT is not set');
      else {
        eligible.push('sms');
        sms = {
          to: config.sandboxMode ? config.sms.sandboxRecipient : number,
          originalNumberMasked: maskNumber(number),
          body: renderTemplate(config.sms.template, { firstName: text(properties.firstname) || context.firstName || 'there', rebookUrl: config.rebookUrl, meetingTitle: context.meetingTitle || 'our meeting' }),
        };
      }
    }
    if (channel === 'email') {
      if (config.email.provider === 'none') reasons.push('email: EMAIL_PROVIDER=none');
      else if (!text(properties.email)) reasons.push('email: no email address');
      else if (isTrue(properties[config.routing.emailOptOutProperty])) reasons.push('email: contact opted out of email');
      else eligible.push('email');
    }
  }
  const channels = config.routing.sendBoth ? eligible : eligible.slice(0, 1);
  const status = !channels.length ? 'skipped_no_channel' : channels[0] === 'sms' ? 'sms_sent' : config.email.provider === 'hubspot_sequence' ? 'sequence_enrolled' : 'email_triggered';
  return { channels, status, reasons, sms: channels.includes('sms') ? sms : null };
}

export function maskNumber(e164) {
  const digits = text(e164).replace(/\D/g, '');
  return digits.length > 4 ? `+${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : '****';
}

/* ---------- 6. Cases: everything decided for each no-show ---------- */

export function buildCases(filtered, details, stageIndex, owners, portal, config, now) {
  const contacts = Object.fromEntries(details.filter((detail) => detail.kind === 'contact' && detail.found).map((detail) => [detail.id, detail]));
  const deals = Object.fromEntries(details.filter((detail) => detail.kind === 'deal' && detail.found).map((detail) => [detail.id, detail]));
  return filtered.map((entry) => {
    if (entry.status !== 'no_show') return entry;
    const contact = entry.contact || (contacts[entry.contactId] ? { id: entry.contactId, properties: contacts[entry.contactId].properties } : null);
    if (!contact) return { ...entry, status: 'skipped', skipReason: 'contact_not_readable' };
    const properties = contact.properties;
    const name = [text(properties.firstname), text(properties.lastname)].filter(Boolean).join(' ') || text(properties.email) || `Contact ${contact.id}`;
    const dealDecisions = decideDeals(entry.dealIds.slice(0, config.deals.maxDealsPerContact).map((id) => deals[id]).filter(Boolean).map((detail) => ({ id: detail.id, properties: detail.properties })), stageIndex, config);
    const route = routeChannels(contact, config, now, { firstName: entry.firstName, meetingTitle: entry.meetingTitle });
    const primaryDeal = dealDecisions.find((decision) => decision.dealId) || null;
    const ownerId = (entry.meeting && entry.meeting.ownerId) || (primaryDeal && primaryDeal.ownerId) || text(properties.hubspot_owner_id) || (isPlaceholder(config.tasks.fallbackOwnerId) ? null : config.tasks.fallbackOwnerId);
    const owner = ownerId ? owners[ownerId] || null : null;
    const previousCount = Number(text(properties[config.properties.count])) || 0;
    const stamp = { [config.properties.status]: route.status, [config.properties.count]: String(previousCount + 1) };
    if (route.channels.length) stamp[config.properties.lastReengagedAt] = new Date(now).toISOString();
    const dealLine = dealDecisions.map((decision) => (decision.action === 'update' ? `Deal "${decision.dealName}" moved from ${decision.fromStage} to ${decision.toStage}.` : `Deal not moved (${decision.reason.replace(/_/g, ' ')}${decision.dealName ? `: ${decision.dealName}` : ''}).`)).join(' ');
    const channelLine = route.channels.length ? `Automated re-engagement: ${route.channels.join(' + ')}.` : `No automated message (${route.status === 'skipped_cooldown' ? 'cooldown' : 'no eligible channel'}): ${route.reasons.join('; ')}.`;
    const task = config.tasks.enabled ? {
      contactId: contact.id,
      dealId: primaryDeal ? primaryDeal.dealId : null,
      ownerId,
      dueAt: new Date(now + config.tasks.dueHours * 3600000).toISOString(),
      subject: `No-show follow-up: ${name}${entry.meetingTitle ? ` (${entry.meetingTitle})` : ''}`,
      body: [
        `${name} missed ${entry.meetingTitle ? `"${entry.meetingTitle}"` : 'a scheduled meeting'}${entry.scheduledAt ? ` scheduled for ${entry.scheduledAt}` : ''}.`,
        channelLine,
        dealLine,
        isPlaceholder(config.rebookUrl) ? 'Call or email personally to rebook.' : `Rebooking link: ${config.rebookUrl}`,
        entry.extraContacts > 0 ? `Note: ${entry.extraContacts} other attendee(s) on this meeting were not re-engaged automatically.` : '',
      ].filter(Boolean).join('\n'),
    } : null;
    return {
      ...entry,
      contact: { id: contact.id, name, email: text(properties.email) || null, url: recordUrl(portal, '0-1', contact.id) },
      dealDecisions,
      route,
      stamp,
      task,
      ownerName: owner ? owner.name : null,
      sequenceSender: owner && owner.userId && owner.email ? { senderUserId: owner.userId, senderEmail: owner.email } : null,
    };
  });
}

export function summarizeCases(cases) {
  const counters = { events: cases.length, noShows: 0, skipped: 0, dealsMoved: 0, dealsNotMoved: 0, smsPlanned: 0, emailPlanned: 0, noChannel: 0, cooldown: 0, tasksPlanned: 0 };
  const skipReasons = {};
  for (const entry of cases) {
    if (entry.status !== 'no_show') {
      counters.skipped += 1;
      skipReasons[entry.skipReason] = (skipReasons[entry.skipReason] || 0) + 1;
      continue;
    }
    counters.noShows += 1;
    for (const decision of entry.dealDecisions) {
      if (decision.action === 'update') counters.dealsMoved += 1;
      else counters.dealsNotMoved += 1;
    }
    if (entry.route.channels.includes('sms')) counters.smsPlanned += 1;
    if (entry.route.channels.includes('email')) counters.emailPlanned += 1;
    if (entry.route.status === 'skipped_cooldown') counters.cooldown += 1;
    else if (!entry.route.channels.length) counters.noChannel += 1;
    if (entry.task) counters.tasksPlanned += 1;
  }
  return { counters, skipReasons };
}
