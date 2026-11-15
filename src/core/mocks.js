// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Fictional demo portal (Acme Corp, Example Company Inc.) plus in-memory HubSpot, Calendly and Twilio
 * stand-ins for demo mode, the tests and the workflow simulation. Every phone number is in the
 * reserved fictional NANP range 555-0100 to 555-0199. No network access.
 */

export const DEMO_NOW = '2026-11-16T15:30:00.000Z';
export const DEMO_STAGE_MAP = Object.freeze({ default: 'meeting_no_show' });
const NOW = Date.parse(DEMO_NOW);
const daysAgo = (days) => new Date(NOW - days * 86400000).toISOString();

export const DEMO_PIPELINES = Object.freeze({
  results: [{
    id: 'default',
    label: 'Sales Pipeline',
    stages: [
      { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
      { id: 'meeting_no_show', label: 'Meeting No-Show (Re-engage)', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.1' } },
      { id: 'qualifiedtobuy', label: 'Qualified To Buy', displayOrder: 2, metadata: { isClosed: 'false', probability: '0.4' } },
      { id: 'presentationscheduled', label: 'Presentation Scheduled', displayOrder: 3, metadata: { isClosed: 'false', probability: '0.6' } },
      { id: 'contractsent', label: 'Contract Sent', displayOrder: 4, metadata: { isClosed: 'false', probability: '0.9' } },
      { id: 'closedwon', label: 'Closed Won', displayOrder: 5, metadata: { isClosed: 'true', probability: '1.0' } },
      { id: 'closedlost', label: 'Closed Lost', displayOrder: 6, metadata: { isClosed: 'true', probability: '0.0' } },
    ],
  }],
});

export const DEMO_OWNERS = Object.freeze({
  results: [
    { id: '501', userId: 7001, firstName: 'Avery', lastName: 'Example', email: 'avery.example@example.com' },
    { id: '502', userId: 7002, firstName: 'Jordan', lastName: 'Sample', email: 'jordan.sample@example.com' },
  ],
});

export function createDemoRecords() {
  return {
    contacts: {
      201: { email: 'taylor.prospect@example.com', firstname: 'Taylor', lastname: 'Prospect', company: 'Acme Corp', mobilephone: '+1 555 555 0111', sms_marketing_consent: 'true', hs_email_optout: 'false', hubspot_owner_id: '501', _deals: ['401', '402'] },
      202: { email: 'morgan.buyer@example.com', firstname: 'Morgan', lastname: 'Buyer', company: 'Example Company Inc.', mobilephone: '(555) 555-0112', sms_marketing_consent: 'false', hubspot_owner_id: '502', _deals: ['403'] },
      203: { email: 'riley.lead@example.com', firstname: 'Riley', lastname: 'Lead', company: 'Acme Corp', hs_email_optout: 'true', hubspot_owner_id: '501', _deals: [] },
      204: { email: 'casey.contact@example.com', firstname: 'Casey', lastname: 'Contact', company: 'Example Company Inc.', mobilephone: '+15555550114', sms_marketing_consent: 'true', no_show_last_reengaged_at: daysAgo(2), no_show_count: '1', hubspot_owner_id: '502', _deals: ['404'] },
      205: { email: 'jamie.demo@example.com', firstname: 'Jamie', lastname: 'Demo', company: 'Acme Corp', mobilephone: '+15555550115', sms_marketing_consent: 'true', hubspot_owner_id: '501', _deals: ['405'] },
    },
    deals: {
      401: { dealname: 'Acme Corp - Discovery', dealstage: 'appointmentscheduled', pipeline: 'default', hubspot_owner_id: '501', createdate: daysAgo(10), amount: '12000' },
      402: { dealname: 'Acme Corp - Old Pilot', dealstage: 'closedlost', pipeline: 'default', hubspot_owner_id: '501', createdate: daysAgo(400), amount: '5000' },
      403: { dealname: 'Example Company Inc. - Expansion', dealstage: 'contractsent', pipeline: 'default', hubspot_owner_id: '502', createdate: daysAgo(30), amount: '48000' },
      404: { dealname: 'Example Company Inc. - Starter', dealstage: 'meeting_no_show', pipeline: 'default', hubspot_owner_id: '502', createdate: daysAgo(20), amount: '6000' },
      405: { dealname: 'Acme Corp - Demo Request', dealstage: 'appointmentscheduled', pipeline: 'default', hubspot_owner_id: '501', createdate: daysAgo(3), amount: '9000' },
    },
    meetings: {
      301: { hs_meeting_outcome: 'NO_SHOW', hs_meeting_title: 'Discovery call', hs_meeting_start_time: '2026-11-16T14:00:00.000Z', hubspot_owner_id: '501', _contacts: ['201'], _deals: ['401', '402'] },
      302: { hs_meeting_outcome: 'NO_SHOW', hs_meeting_title: 'Contract walkthrough', hs_meeting_start_time: '2026-11-16T13:00:00.000Z', hubspot_owner_id: '502', _contacts: ['202'], _deals: ['403'] },
      303: { hs_meeting_outcome: 'COMPLETED', hs_meeting_title: 'Follow-up', hs_meeting_start_time: '2026-11-15T16:00:00.000Z', hubspot_owner_id: '501', _contacts: ['201'], _deals: ['401'] },
      304: { hs_meeting_outcome: 'NO_SHOW', hs_meeting_title: 'Intro call', hs_meeting_start_time: '2026-11-16T12:00:00.000Z', hubspot_owner_id: '501', _contacts: ['203'], _deals: [] },
      305: { hs_meeting_outcome: 'NO_SHOW', hs_meeting_title: 'Onboarding check-in', hs_meeting_start_time: '2026-11-16T11:00:00.000Z', hubspot_owner_id: '502', _contacts: ['204'], _deals: ['404'] },
    },
    calendlyInvitees: {
      'https://api.calendly.com/scheduled_events/EXAMPLEEVENT0001/invitees/EXAMPLEINVITEE01': { email: 'jamie.demo@example.com', name: 'Jamie Demo', first_name: 'Jamie', event: 'https://api.calendly.com/scheduled_events/EXAMPLEEVENT0001' },
    },
  };
}

/** Webhook bodies: five HubSpot meeting workflow calls and three Calendly events (one is a no-show removal). */
export function createDemoWebhookBodies() {
  return [
    ...['301', '302', '303', '304', '305'].map((id) => ({ objectId: Number(id) })),
    { event: 'invitee_no_show.created', created_at: '2026-11-16T15:20:00.000000Z', payload: { uri: 'https://api.calendly.com/invitee_no_shows/EXAMPLENOSHOW001', invitee: 'https://api.calendly.com/scheduled_events/EXAMPLEEVENT0001/invitees/EXAMPLEINVITEE01', created_at: '2026-11-16T15:20:00.000000Z' } },
    { event: 'invitee_no_show.created', created_at: '2026-11-16T15:21:00.000000Z', payload: { uri: 'https://api.calendly.com/invitee_no_shows/EXAMPLENOSHOW002', email: 'not.in.crm@example.com', scheduled_event: { name: 'Product demo', start_time: '2026-11-16T15:00:00.000000Z' } } },
    { event: 'invitee_no_show.deleted', created_at: '2026-11-16T15:22:00.000000Z', payload: { uri: 'https://api.calendly.com/invitee_no_shows/EXAMPLENOSHOW003', email: 'jamie.demo@example.com' } },
  ];
}

function selectProperties(record, names) {
  const properties = {};
  for (const name of names) properties[name] = record[name] === undefined ? null : record[name];
  return properties;
}

function associations(requested, map) {
  const out = {};
  for (const type of requested) out[type] = { results: (map[type] || []).map((id) => ({ id, type: `x_to_${type}` })) };
  return out;
}

export function createMockHubSpot({ records = createDemoRecords(), account = { portalId: 'DEMO', accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' }, failWritesFor = [] } = {}) {
  const calls = [];
  const tasks = [];
  const enrollments = [];
  async function request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url);
    calls.push({ method, path: url.pathname, search: url.search, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)), headers: req.headers || {} });
    const names = (url.searchParams.get('properties') || '').split(',').filter(Boolean);
    const wanted = (url.searchParams.get('associations') || '').split(',').filter(Boolean);
    if (method === 'GET' && url.pathname === '/account-info/v3/details') return { status: 200, body: { ...account } };
    if (method === 'GET' && url.pathname === '/crm/v3/pipelines/deals') return { status: 200, body: JSON.parse(JSON.stringify(DEMO_PIPELINES)) };
    if (method === 'GET' && url.pathname === '/crm/v3/owners') return { status: 200, body: JSON.parse(JSON.stringify(DEMO_OWNERS)) };
    const match = url.pathname.match(/^\/crm\/v3\/objects\/(meetings|contacts|deals|tasks)(?:\/([^/]+))?$/);
    if (match) {
      const [, type, rawId] = match;
      let id = rawId ? decodeURIComponent(rawId) : null;
      if (type === 'contacts' && url.searchParams.get('idProperty') === 'email') {
        id = Object.keys(records.contacts).find((key) => records.contacts[key].email === id) || null;
      }
      if (type === 'tasks' && method === 'POST') {
        if (failWritesFor.includes('tasks')) return { status: 500, body: { status: 'error', message: 'Internal error' } };
        const taskId = String(90000 + tasks.length + 1);
        tasks.push({ id: taskId, ...JSON.parse(JSON.stringify(req.body)) });
        return { status: 201, body: { id: taskId, properties: req.body.properties } };
      }
      const store = records[type];
      const record = id ? store[id] : null;
      if (!record) return { status: 404, body: { status: 'error', category: 'OBJECT_NOT_FOUND', message: `resource not found for ${type}` } };
      if (method === 'GET') {
        return { status: 200, body: { id, properties: { hs_object_id: id, ...selectProperties(record, names) }, associations: associations(wanted, { contacts: record._contacts, deals: record._deals }) } };
      }
      if (method === 'PATCH') {
        if (failWritesFor.includes(`${type}:${id}`)) return { status: 500, body: { status: 'error', message: 'Internal error' } };
        Object.assign(record, req.body.properties);
        return { status: 200, body: { id, properties: { ...req.body.properties } } };
      }
    }
    if (method === 'POST' && url.pathname === '/automation/v4/sequences/enrollments') {
      const id = String(70000 + enrollments.length + 1);
      enrollments.push({ id, userId: url.searchParams.get('userId'), ...JSON.parse(JSON.stringify(req.body)) });
      return { status: 200, body: { id, toEmail: 'redacted', enrolledAt: new Date(NOW).toISOString() } };
    }
    if (method === 'POST' && url.pathname === '/crm/v3/properties/contacts') return { status: 201, body: req.body };
    return { status: 404, body: { status: 'error', message: `Mock HubSpot has no route for ${method} ${url.pathname}` } };
  }
  return { request, calls, tasks, enrollments, records };
}

export function createMockCalendly({ records = createDemoRecords() } = {}) {
  const calls = [];
  async function request(req) {
    calls.push({ method: req.method, url: req.url, headers: req.headers || {} });
    const invitee = records.calendlyInvitees[req.url];
    if (!invitee) return { status: 404, body: { title: 'Resource Not Found', message: 'The server could not find the requested resource.' } };
    return { status: 200, body: { resource: { uri: req.url, ...invitee } } };
  }
  return { request, calls };
}

export function createMockTwilio({ fail = false } = {}) {
  const messages = [];
  async function request(req) {
    const form = Object.fromEntries(new URLSearchParams(req.form || req.body || ''));
    if (fail) return { status: 400, body: { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 } };
    const sid = `SM${String(messages.length + 1).padStart(32, '0')}`;
    messages.push({ sid, url: req.url, ...form });
    return { status: 201, body: { sid, status: 'queued', to: form.To } };
  }
  return { request, messages };
}
