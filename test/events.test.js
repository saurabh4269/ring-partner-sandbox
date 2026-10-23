import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvent, EVENT_TYPES } from '../src/events.js';
import { parseScenario, playScenario } from '../src/scenario.js';

test('every event type builds a v1.1 envelope', () => {
  for (const type of EVENT_TYPES) {
    const e = buildEvent({ type, deviceId: 'dev1', accountId: 'acct1' });
    assert.equal(e.meta.version, '1.1');
    assert.equal(e.meta.account_id, 'acct1');
    assert.match(e.meta.request_id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(e.meta.time)));
    assert.equal(e.meta.simulated, true);
    assert.equal(e.data.type, type);
  }
});

test('motion payload matches documented shape', () => {
  const e = buildEvent({ type: 'motion_detected', subType: 'human', deviceId: 'dev1', timestamp: 1786715596787 });
  assert.equal(e.data.id, 'dev1_human_1786715596787');
  assert.deepEqual(e.data.attributes, { source: 'dev1', source_type: 'devices', timestamp: 1786715596787, timestamp_readable: '2026-08-14 13:53:16', sub_type: 'human', component_ids: ['0'] });
  assert.equal(e.data.relationships.devices.links.self, '/v1/devices/dev1');
});

test('account and subscription payloads', () => {
  const a = buildEvent({ type: 'app_integration_added', accountId: 'acct1' });
  assert.equal(a.data.attributes.source_type, 'users');
  assert.equal(a.data.relationships, undefined);
  const s = buildEvent({ type: 'subscription_deactivated', subType: 'trial', deviceId: 'dev1' });
  assert.equal(s.data.attributes.source, 'subscriptions');
  assert.equal(s.data.attributes.plan_id, null);
  assert.equal(s.data.attributes.expires_at, undefined);
  assert.deepEqual(s.data.relationships.devices.data, [{ type: 'device', id: 'dev1' }]);
  assert.ok(buildEvent({ type: 'subscription_activated' }).data.attributes.expires_at);
});

test('--no-sim-flag removes meta.simulated; unknown type throws', () => {
  assert.equal('simulated' in buildEvent({ type: 'button_press', simFlag: false }).meta, false);
  assert.throws(() => buildEvent({ type: 'nope' }), /unknown event type/);
});

test('scenario steps are sorted by "at" (stable) and played in order', async () => {
  const steps = parseScenario([
    { at: 0.03, type: 'button_press' },
    { at: 0, type: 'motion_detected', sub_type: 'vehicle' },
    { at: 0.01, type: 'motion_detected', sub_type: 'human' },
    { at: 0.01, type: 'device_offline' },
  ]);
  assert.deepEqual(steps.map((s) => s.type), ['motion_detected', 'motion_detected', 'device_offline', 'button_press']);
  const order = [];
  const t0 = Date.now();
  await playScenario(steps, (s) => order.push([s.type, Date.now() - t0]), { speed: 0.5 });
  assert.deepEqual(order.map((o) => o[0]), steps.map((s) => s.type));
  assert.ok(order[3][1] >= 55, `last step should wait ~60ms at speed 0.5, got ${order[3][1]}`);
  assert.throws(() => parseScenario([{ at: 0, type: 'bogus' }]), /unknown type/);
});

test('shipped scenarios parse', async () => {
  const { loadScenario } = await import('../src/scenario.js');
  for (const f of ['porch-delivery.json', 'integration-lifecycle.json']) {
    const s = await loadScenario(new URL(`../scenarios/${f}`, import.meta.url));
    assert.ok(s.length > 3);
  }
});
