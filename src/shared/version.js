// shared/version.js — Single source of truth for the app runtime version.
// Kept in JS (not imported from package.json) to avoid Node import-attribute
// (JSON module) compatibility issues inside Electron. package.json "version"
// is manually synced to this value; tests assert they match.
export const VERSION = '1.1.4';