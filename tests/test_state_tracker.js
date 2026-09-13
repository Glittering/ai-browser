// tests/test_state_tracker.js — Tests for preload/watcher.cjs (the runtime tracker)
// @vitest-environment jsdom
//
// watcher.cjs is CommonJS and emits side effects through an injected
// onEvent(event, data) callback (bridge.js wires it to ipcRenderer). Here we
// inject a collector and assert on the real emitted events.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const htmlPath = resolve(__dirname, 'test_pages/dynamic_content.html');
const dynamicHTML = readFileSync(htmlPath, 'utf-8');

let startTracking, stopTracking;
let extractTree;
let events = [];

async function loadModule(pathStr) {
  const mod = await import(pathStr);
  return mod.default || mod;
}

function emitted(eventType) {
  return events.filter(e => e.event === eventType);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Discovery: any emitted state_changed whose changes satisfy predicate
function anyChange(eventType, predicate) {
  return emitted(eventType).some(ev => (ev.data.changes || []).some(predicate));
}

beforeAll(async () => {
  document.documentElement.innerHTML = dynamicHTML;
  await new Promise(r => setTimeout(r, 600));
  registerDynamicHandlers();
  const ex = await loadModule('../src/preload/extractor.cjs');
  extractTree = ex.extractTree;
  const w = await loadModule('../src/preload/watcher.cjs');
  startTracking = w.startTracking;
  stopTracking = w.stopTracking;
});

// Register all event handlers from dynamic_content.html inline script
function registerDynamicHandlers() {
  let childCount = 1;
  document.getElementById('btn-insert-child').addEventListener('click', () => {
    const target = document.getElementById('mutation-target');
    const p = document.createElement('p');
    p.id = `p-child-${childCount}`;
    p.textContent = `Child ${childCount}`;
    target.appendChild(p);
    childCount++;
  });

  document.getElementById('btn-remove-child').addEventListener('click', () => {
    const target = document.getElementById('mutation-target');
    const lastChild = target.lastElementChild;
    if (lastChild && lastChild.id.startsWith('p-child-') && lastChild.id !== 'p-child-0') {
      target.removeChild(lastChild);
    }
  });

  let disabledState = false;
  document.getElementById('btn-toggle-disabled').addEventListener('click', () => {
    disabledState = !disabledState;
    document.getElementById('btn-insert-child').disabled = disabledState;
  });
}

beforeEach(async () => {
  // Reset page, re-extract (assigns data-ai-id), start a fresh watcher
  document.documentElement.innerHTML = dynamicHTML;
  await sleep(600);
  registerDynamicHandlers();
  extractTree();
  events = [];
  startTracking({ onEvent: (event, data) => events.push({ event, data }) });
});

afterEach(() => {
  stopTracking();
});

describe('watcher.cjs — state/dom tracking (runtime tracker)', () => {
  it('ST-RT-001: DOM insertion broadcasts state_changed/dom_changed', async () => {
    document.getElementById('btn-insert-child').click();
    await sleep(650); // wait past MUTATION_FLUSH_DELAY (500ms)
    const hasAdded = anyChange('state_changed', c => c.type === 'dom_changed' && c.added > 0);
    expect(hasAdded).toBe(true);
  });

  it('ST-RT-002: DOM removal broadcasts dom_changed with removed>0', async () => {
    // Insert one child first so there's something to remove
    document.getElementById('btn-insert-child').click();
    await sleep(650);
    events = []; // discard the insert event
    document.getElementById('btn-remove-child').click();
    await sleep(650);
    const hasRemoved = anyChange('state_changed', c => c.type === 'dom_changed' && c.removed > 0);
    expect(hasRemoved).toBe(true);
  });

  it('ST-RT-003: disabled attribute change broadcasts state_changed', async () => {
    document.getElementById('btn-toggle-disabled').click();
    await sleep(650);
    const hasDisabled = anyChange('state_changed', c => c.type === 'state_changed' && c.attribute === 'disabled');
    expect(hasDisabled).toBe(true);
  });

  it('ST-RT-004: unrelated attribute changes do not broadcast', async () => {
    // style.color is not in the observed attributeFilter
    const p0 = document.getElementById('p-child-0');
    p0.style.color = 'red';
    // A <p> child is not itself data-ai-id'd (no id); even if it were, style is
    // not tracked. No state_changed should arrive before the scan timer fires.
    await sleep(650);
    expect(emitted('state_changed')).toHaveLength(0);
  });

  it('ST-RT-005: stopTracking stops further broadcasts', async () => {
    stopTracking();
    document.getElementById('btn-insert-child').click();
    await sleep(650);
    expect(emitted('state_changed').length).toBe(0);
  });
});