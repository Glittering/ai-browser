// shared/watchdog.js — Pure decision logic for the NetworkService watchdog.
// No Electron / Node-side-effect imports: everything here is a pure function so
// it can be unit tested without booting Electron. The main process owns the
// actual probing (net.request), the interval and the relaunch — this module only
// answers "what targets?" and "is it on?".
//
// Deliberately NOT included: any "is a human probably at the wheel?" heuristic.
// `mainWindow.isFocused()` cannot distinguish the human from the agent — the
// agent steals focus itself (page_manager's `_inputViaCdp` / `peek` call
// `window.show()/moveTop()/focus()` on every action). Under the most common
// scenario (a human sitting and watching the agent work) such a heuristic would
// defer forever and the watchdog would never self-heal at all. Not interrupting
// people is achieved by lowering false positives + making it configurable +
// making it switchable off — not by guessing who is at the keyboard.

// Two hosts by default, not one. The watchdog only needs the NetworkService to
// round-trip; if either host answers, the service is alive. example.com alone is
// unreliable from mainland China and produced false "wedged" verdicts (→ reboot
// loops), so baidu.com is a second, region-friendly probe.
export const DEFAULT_WATCHDOG_TARGETS = ['https://example.com/', 'https://www.baidu.com/'];

// Values that explicitly turn the watchdog off (case-insensitive).
const WATCHDOG_OFF_VALUES = ['0', 'off', 'false', 'no'];

/**
 * Parse the AI_BROWSER_WATCHDOG_URLS env var into a de-duplicated target list.
 * Empty / unset → DEFAULT_WATCHDOG_TARGETS.
 * @param {string|undefined} envStr raw comma-separated env value
 * @returns {string[]} non-empty, trimmed, de-duplicated URLs
 */
export function parseWatchdogTargets(envStr) {
  if (typeof envStr !== 'string') return [...DEFAULT_WATCHDOG_TARGETS];

  const parsed = envStr
    .split(',')
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0);

  const unique = [];
  for (const url of parsed) {
    if (!unique.includes(url)) unique.push(url);
  }

  return unique.length > 0 ? unique : [...DEFAULT_WATCHDOG_TARGETS];
}

/**
 * Whether the watchdog should run at all. Defaults to on; AI_BROWSER_WATCHDOG
 * set to 0/off/false/no (any case) disables it.
 * @param {string|undefined} envValue
 * @returns {boolean}
 */
export function isWatchdogEnabled(envValue) {
  if (typeof envValue !== 'string') return true;
  return !WATCHDOG_OFF_VALUES.includes(envValue.trim().toLowerCase());
}

