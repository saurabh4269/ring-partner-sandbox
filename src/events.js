// Builders for Ring webhook v1.1 payloads, shaped after the public Ring Partner API docs.
import { randomUUID } from 'node:crypto';

export const DEVICE_EVENTS = ['motion_detected', 'button_press', 'device_online', 'device_offline', 'device_added', 'device_removed'];
export const ACCOUNT_EVENTS = ['app_integration_added', 'app_integration_removed'];
export const SUBSCRIPTION_EVENTS = ['subscription_activated', 'subscription_deactivated'];
export const EVENT_TYPES = [...DEVICE_EVENTS, ...ACCOUNT_EVENTS, ...SUBSCRIPTION_EVENTS];
export const MOTION_SUB_TYPES = ['human', 'vehicle', 'motion', 'other_motion', 'animal'];

export const DEFAULT_ACCOUNT_ID = 'ava1.ring.account.SANDBOX0001';
export const DEFAULT_DEVICE_ID = 'ava1.ring.device.SANDBOX0001';

function readable(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Build one webhook body.
 * @param {object} o
 * @param {string} o.type one of EVENT_TYPES
 * @param {string} [o.subType] motion sub type, or "paid"/"trial" for subscriptions
 * @param {string} [o.deviceId]
 * @param {string} [o.accountId]
 * @param {number} [o.timestamp] epoch ms of the event
 * @param {boolean} [o.simFlag=true] add non-standard meta.simulated = true
 */
export function buildEvent({ type, subType, deviceId = DEFAULT_DEVICE_ID, accountId = DEFAULT_ACCOUNT_ID, timestamp = Date.now(), simFlag = true, planId, subscriptionId } = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type "${type}". Valid: ${EVENT_TYPES.join(', ')}`);
  const meta = { version: '1.1', time: new Date().toISOString(), request_id: randomUUID(), account_id: accountId };
  if (simFlag) meta.simulated = true;

  if (ACCOUNT_EVENTS.includes(type)) {
    return { meta, data: { id: randomUUID(), type, attributes: { source: accountId, source_type: 'users', timestamp } } };
  }

  if (SUBSCRIPTION_EVENTS.includes(type)) {
    const sub = subType || 'paid';
    const attributes = {
      source: 'subscriptions',
      source_id: subscriptionId || `ava1.ring.subscription.SANDBOX${String(timestamp).slice(-6)}`,
      sub_type: sub,
      plan_id: sub === 'trial' ? null : planId || '00000000-0000-4000-8000-00000000a11a',
    };
    if (type === 'subscription_activated') attributes.expires_at = new Date(timestamp + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      meta,
      data: {
        id: randomUUID(),
        type,
        attributes,
        relationships: {
          devices: { data: [{ type: 'device', id: deviceId }] },
          subscriptions: { links: { self: '/v1/accounts/me/subscriptions' } },
        },
      },
    };
  }

  const attributes = { source: deviceId, source_type: 'devices', timestamp };
  let idPart = type;
  if (type === 'motion_detected') {
    const st = subType || 'motion';
    attributes.timestamp_readable = readable(timestamp);
    attributes.sub_type = st;
    attributes.component_ids = ['0'];
    idPart = st;
  }
  return {
    meta,
    data: {
      id: `${deviceId}_${idPart}_${timestamp}`,
      type,
      attributes,
      relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
    },
  };
}

/** Map a webhook event to the history event_type it produces, or null. */
export function historyTypeFor(type) {
  if (type === 'motion_detected') return 'motion';
  if (type === 'button_press') return 'ding';
  return null;
}
