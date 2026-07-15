// tests/test_protocol.js — Unit tests for shared/protocol.js
import { describe, it, expect } from 'vitest';
import {
  createRequest,
  createResponse,
  createError,
  createEvent,
  parseMessage,
  VALID_METHODS,
  ERROR_CODES,
} from '../src/shared/protocol.js';

describe('createRequest', () => {
  it('creates valid JSON-RPC request', () => {
    const result = createRequest(1, 'ui.get_tree', {});
    const parsed = JSON.parse(result);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.method).toBe('ui.get_tree');
    expect(parsed.params).toEqual({});
  });

  it('includes params in request', () => {
    const result = createRequest(2, 'ui.act', { action: 'click', target: 'e:btn-1' });
    const parsed = JSON.parse(result);
    expect(parsed.params.action).toBe('click');
    expect(parsed.params.target).toBe('e:btn-1');
  });

  it('defaults params to empty object', () => {
    const result = createRequest(3, 'ui.navigate');
    const parsed = JSON.parse(result);
    expect(parsed.params).toEqual({});
  });
});

describe('createResponse', () => {
  it('creates valid success response', () => {
    const result = createResponse(1, { tree: { root: null } });
    const parsed = JSON.parse(result);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result.tree).toBeDefined();
  });
});

describe('createError', () => {
  it('creates valid error response', () => {
    const result = createError(1, -32601, 'Method not found');
    const parsed = JSON.parse(result);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeUndefined();
    expect(parsed.error.code).toBe(-32601);
    expect(parsed.error.message).toBe('Method not found');
  });

  it('includes optional data', () => {
    const result = createError(2, -32002, 'Target not found', { target: 'e:xxx' });
    const parsed = JSON.parse(result);
    expect(parsed.error.data).toEqual({ target: 'e:xxx' });
  });

  it('omits data when null', () => {
    const result = createError(3, -32603, 'Internal error');
    const parsed = JSON.parse(result);
    expect(parsed.error.data).toBeUndefined();
  });
});

describe('createEvent', () => {
  it('creates notification without id', () => {
    const result = createEvent('dom_change', { changes: [] });
    const parsed = JSON.parse(result);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBeUndefined();
    expect(parsed.method).toBe('dom_change');
    expect(parsed.params.changes).toEqual([]);
  });
});

describe('parseMessage', () => {
  it('parses valid JSON-RPC message', () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ui.get_tree', params: {} });
    const parsed = parseMessage(msg);
    expect(parsed.id).toBe(1);
    expect(parsed.method).toBe('ui.get_tree');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseMessage('not json')).toThrow('Failed to parse');
  });

  it('throws on wrong version', () => {
    const msg = JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'test' });
    expect(() => parseMessage(msg)).toThrow('Invalid JSON-RPC version');
  });
});

describe('VALID_METHODS', () => {
  it('includes all core methods', () => {
    expect(VALID_METHODS).toContain('ui.get_tree');
    expect(VALID_METHODS).toContain('ui.act');
    expect(VALID_METHODS).toContain('ui.subscribe');
    expect(VALID_METHODS).toContain('ui.unsubscribe');
    expect(VALID_METHODS).toContain('ui.navigate');
  });
});

describe('ERROR_CODES', () => {
  it('has standard JSON-RPC codes', () => {
    expect(ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('has custom AI Browser codes', () => {
    expect(ERROR_CODES.ACTION_FAILED).toBe(-32001);
    expect(ERROR_CODES.TARGET_NOT_FOUND).toBe(-32002);
  });
});