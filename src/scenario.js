// Scenario files: a JSON array of { "at": seconds, "type": ..., "sub_type"?: ..., "device"?: ... }
import { readFile } from 'node:fs/promises';
import { EVENT_TYPES } from './events.js';

export function parseScenario(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  const steps = Array.isArray(doc) ? doc : doc?.events;
  if (!Array.isArray(steps)) throw new Error('scenario must be a JSON array (or { "events": [...] })');
  return steps
    .map((s, i) => {
      if (!EVENT_TYPES.includes(s.type)) throw new Error(`scenario step ${i}: unknown type "${s.type}"`);
      const at = Number(s.at ?? 0);
      if (!Number.isFinite(at) || at < 0) throw new Error(`scenario step ${i}: "at" must be seconds >= 0`);
      return { at, type: s.type, sub_type: s.sub_type, device: s.device, note: s.note, index: i };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index);
}

export async function loadScenario(path) {
  return parseScenario(await readFile(path, 'utf8'));
}

/**
 * Play steps in order. `speed` 10 means 10x faster than real time.
 * `run(step)` is awaited for each step; returns the list of results.
 */
export async function playScenario(steps, run, { speed = 1, signal } = {}) {
  const t0 = Date.now();
  const results = [];
  for (const step of steps) {
    const due = t0 + (step.at * 1000) / (speed > 0 ? speed : 1);
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) break;
    results.push(await run(step));
  }
  return results;
}
