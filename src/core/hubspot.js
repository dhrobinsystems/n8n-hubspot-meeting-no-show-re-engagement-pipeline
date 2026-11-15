// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * HubSpot and Calendly request builders and parsers. No network access, and no request object
 * carries a token: the n8n HTTP Request nodes add Authorization headers from $env.
 */
import { isPlaceholder, SANDBOX_ACCOUNT_TYPES } from './config.js';

export const ASSOCIATION_TYPES = Object.freeze({ taskToContact: 204, taskToDeal: 216 });
export const MEETING_PROPERTIES = Object.freeze(['hs_meeting_outcome', 'hs_meeting_title', 'hs_meeting_start_time', 'hubspot_owner_id']);
export const DEAL_PROPERTIES = Object.freeze(['dealname', 'dealstage', 'pipeline', 'hubspot_owner_id', 'createdate', 'amount']);

export function contactProperties(config) {
  return [...new Set(['email', 'firstname', 'lastname', 'mobilephone', 'phone', 'hubspot_owner_id', config.routing.smsConsentProperty, config.routing.emailOptOutProperty, ...Object.values(config.properties)])];
}

export function hubspotUrl(config, path) {
  return `${config.hubspot.baseUrl}${path}`;
}

export const buildAccountDetailsRequest = (config) => ({ method: 'GET', url: hubspotUrl(config, '/account-info/v3/details') });
export const buildPipelinesRequest = (config) => ({ method: 'GET', url: hubspotUrl(config, '/crm/v3/pipelines/deals') });
export const buildOwnersRequest = (config) => ({ method: 'GET', url: hubspotUrl(config, '/crm/v3/owners?limit=500&archived=false') });

export function buildMeetingReadRequest(config, meetingId) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/meetings/${encodeURIComponent(meetingId)}?properties=${encodeURIComponent(MEETING_PROPERTIES.join(','))}&associations=contacts,deals`) };
}

export function buildContactReadRequest(config, contactId) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${encodeURIComponent(contactProperties(config).join(','))}&associations=deals`) };
}

export function buildContactByEmailRequest(config, email) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=${encodeURIComponent(contactProperties(config).join(','))}&associations=deals`) };
}

export function buildDealReadRequest(config, dealId) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(DEAL_PROPERTIES.join(','))}`) };
}

export function buildDealStageUpdateRequest(config, dealId, stageId) {
  return { method: 'PATCH', url: hubspotUrl(config, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`), body: { properties: { dealstage: stageId } } };
}

export function buildContactUpdateRequest(config, contactId, properties) {
  return { method: 'PATCH', url: hubspotUrl(config, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`), body: { properties } };
}

export function buildSequenceEnrollmentRequest(config, { contactId, senderUserId, senderEmail }) {
  return {
    method: 'POST',
    url: hubspotUrl(config, `/automation/v4/sequences/enrollments?userId=${encodeURIComponent(senderUserId)}`),
    body: { contactId: String(contactId), sequenceId: String(config.email.sequenceId), senderEmail },
  };
}

export function buildTaskRequest(config, task) {
  const associations = [{ to: { id: task.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.taskToContact }] }];
  if (task.dealId) associations.push({ to: { id: task.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPES.taskToDeal }] });
  const properties = {
    hs_task_subject: task.subject.slice(0, 250),
    hs_task_body: task.body,
    hs_timestamp: task.dueAt,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_task_type: 'CALL',
  };
  if (task.ownerId) properties.hubspot_owner_id = task.ownerId;
  return { method: 'POST', url: hubspotUrl(config, '/crm/v3/objects/tasks'), body: { properties, associations } };
}

/** Calendly invitee lookup, used when a no-show payload carries only the invitee URI. */
export function buildCalendlyInviteeRequest(config, inviteeUri) {
  if (!inviteeUri || !inviteeUri.startsWith(`${config.calendly.baseUrl}/`)) return null;
  return { method: 'GET', url: inviteeUri };
}

export function parseCalendlyInvitee(body) {
  const resource = body && body.resource && typeof body.resource === 'object' ? body.resource : null;
  if (!resource || !resource.email) return { found: false, email: null, firstName: null, scheduledEventUri: null };
  return { found: true, email: String(resource.email).toLowerCase(), firstName: resource.first_name || (resource.name ? String(resource.name).split(' ')[0] : null), scheduledEventUri: resource.event || null };
}

export function enforceSandbox(account, config) {
  const portalId = account && account.portalId !== undefined && account.portalId !== null ? String(account.portalId) : null;
  const accountType = account && account.accountType ? String(account.accountType).toUpperCase() : null;
  const uiDomain = account && /^app(?:-[a-z0-9]+)?\.hubspot\.com$/.test(String(account.uiDomain || '')) ? account.uiDomain : 'app.hubspot.com';
  const base = { portalId, accountType, uiDomain };
  if (!config.sandboxMode) return { ok: true, ...base, reason: 'SANDBOX_MODE=false, so production portals are allowed' };
  if (accountType && SANDBOX_ACCOUNT_TYPES.includes(accountType)) return { ok: true, ...base, reason: `account type ${accountType} is a sandbox or test account` };
  if (portalId && !isPlaceholder(config.hubspot.sandboxPortalId) && portalId === config.hubspot.sandboxPortalId) return { ok: true, ...base, reason: 'portal ID matches HUBSPOT_SANDBOX_PORTAL_ID' };
  return { ok: false, ...base, reason: `SANDBOX_MODE=true, but the connected portal (account type ${accountType || 'unknown'}) is not a sandbox or developer test account and does not match HUBSPOT_SANDBOX_PORTAL_ID. I refuse to continue.` };
}

export function buildStageIndex(pipelinesBody) {
  const stages = {};
  for (const pipeline of (pipelinesBody && Array.isArray(pipelinesBody.results) ? pipelinesBody.results : [])) {
    for (const stage of pipeline.stages || []) {
      const closed = stage.metadata && String(stage.metadata.isClosed).toLowerCase() === 'true';
      stages[String(stage.id)] = { id: String(stage.id), label: stage.label || String(stage.id), pipelineId: String(pipeline.id), pipelineLabel: pipeline.label || String(pipeline.id), order: Number(stage.displayOrder), closed };
    }
  }
  return stages;
}

export function buildOwnerIndex(pages) {
  const byOwnerId = {};
  for (const page of pages) {
    for (const owner of (page && Array.isArray(page.results) ? page.results : [])) {
      byOwnerId[String(owner.id)] = { ownerId: String(owner.id), userId: owner.userId !== undefined && owner.userId !== null ? String(owner.userId) : null, email: owner.email || null, name: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || `Owner ${owner.id}` };
    }
  }
  return byOwnerId;
}

function associationIds(body, type) {
  const block = body && body.associations && body.associations[type];
  return block && Array.isArray(block.results) ? [...new Set(block.results.map((entry) => String(entry.id)))] : [];
}

/** Parses any CRM object response into { found, id, properties, contactIds, dealIds, error }. */
export function parseObjectResponse(body) {
  if (body && typeof body === 'object' && body.id !== undefined && body.properties) {
    return { found: true, id: String(body.id), properties: body.properties, contactIds: associationIds(body, 'contacts'), dealIds: associationIds(body, 'deals'), error: null };
  }
  const message = body && typeof body === 'object' ? (typeof body.error === 'object' && body.error ? body.error.message : body.message || body.error) : null;
  return { found: false, id: null, properties: {}, contactIds: [], dealIds: [], error: String(message || 'not_readable').slice(0, 200) };
}

export function parseWriteResponse(key, body) {
  const ok = Boolean(body && typeof body === 'object' && !body.error && !(typeof body.code === 'number' && Number(body.status) >= 400) && (body.id !== undefined || body.sid !== undefined));
  return { key, ok, id: ok ? String(body.id ?? body.sid ?? '') : null, error: ok ? null : String((body && (body.message || (body.error && body.error.message) || body.error)) || 'write_failed').slice(0, 200) };
}

export function recordUrl(portal, objectTypeId, id) {
  if (!portal || !/^\d+$/.test(String(portal.portalId || ''))) return null;
  return `https://${portal.uiDomain || 'app.hubspot.com'}/contacts/${portal.portalId}/record/${objectTypeId}/${id}`;
}

/* ---------- one-time property setup (scripts/create-properties.js) ---------- */

export function buildPropertyDefinitions(config, groupName = 'contactinformation') {
  return [
    {
      name: config.properties.status, label: 'No-show re-engagement status', groupName, type: 'enumeration', fieldType: 'select',
      description: 'Set by the no-show re-engagement pipeline. A HubSpot workflow can trigger on "email_triggered".',
      options: ['email_triggered', 'sms_sent', 'sequence_enrolled', 'skipped_cooldown', 'skipped_no_channel'].map((value, displayOrder) => ({ label: value.replace(/_/g, ' '), value, displayOrder })),
    },
    { name: config.properties.lastReengagedAt, label: 'No-show last re-engaged at', groupName, type: 'datetime', fieldType: 'date', description: 'When the pipeline last re-engaged this contact after a no-show (drives the cooldown).' },
    { name: config.properties.count, label: 'No-show count', groupName, type: 'number', fieldType: 'number', description: 'Meetings this contact missed, as counted by the pipeline.' },
    { name: config.routing.smsConsentProperty, label: 'SMS marketing consent', groupName, type: 'enumeration', fieldType: 'booleancheckbox', description: 'Explicit SMS consent. Only "true" allows re-engagement SMS.', options: [{ label: 'Yes', value: 'true', displayOrder: 0 }, { label: 'No', value: 'false', displayOrder: 1 }] },
  ];
}
