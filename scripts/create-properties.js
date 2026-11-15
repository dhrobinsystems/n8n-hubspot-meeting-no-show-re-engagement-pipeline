#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * One-time setup: creates the contact properties the pipeline writes (status, last re-engaged at,
 * no-show count) and the SMS consent checkbox.
 *
 *   npm run properties:create                     DRY_RUN=true (default): prints the payloads only
 *   DRY_RUN=false npm run properties:create       creates them (SANDBOX_MODE still applies)
 *
 * Existing properties (HTTP 409) are reported and left unchanged. PROPERTY_GROUP_NAME selects the group.
 */
import { loadContext } from '../src/index.js';
import { isPlaceholder } from '../src/core/config.js';
import { buildAccountDetailsRequest, buildPropertyDefinitions, enforceSandbox, hubspotUrl } from '../src/core/hubspot.js';
import { createHttpClient } from '../src/core/pipeline.js';
import { createMockHubSpot } from '../src/core/mocks.js';

export async function createProperties(context, { log = console.log, http } = {}) {
  const { config, env } = context;
  const send = http || (config.mode === 'demo' ? createMockHubSpot().request : createHttpClient({ authorization: `Bearer ${config.hubspot.token}`, secrets: [config.hubspot.token] }));
  const gate = enforceSandbox((await send(buildAccountDetailsRequest(config))).body, config);
  if (!gate.ok) throw new Error(gate.reason);
  const groupName = isPlaceholder(env.PROPERTY_GROUP_NAME) ? 'contactinformation' : String(env.PROPERTY_GROUP_NAME).trim();
  const results = [];
  for (const body of buildPropertyDefinitions(config, groupName)) {
    if (config.dryRun || config.mode === 'demo') {
      log(`[${config.mode === 'demo' ? 'DEMO' : 'DRY RUN'}] would POST /crm/v3/properties/contacts ${JSON.stringify(body)}`);
      results.push({ name: body.name, outcome: 'planned' });
      continue;
    }
    const response = await send({ method: 'POST', url: hubspotUrl(config, '/crm/v3/properties/contacts'), body });
    const outcome = response.status === 409 ? 'already exists' : response.status >= 200 && response.status < 300 ? 'created' : `failed (${response.status})`;
    log(`${body.name}: ${outcome}`);
    results.push({ name: body.name, outcome });
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('create-properties.js')) {
  createProperties(loadContext()).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
