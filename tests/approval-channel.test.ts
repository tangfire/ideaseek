import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ALLOW,
  APPROVAL_REJECT,
  APPROVAL_REQUEST_PREFIX,
  encodeApprovalRequest,
  parseApprovalRequest,
} from '../src/dsh/approval-channel.js';

/**
 * Stdio approval channel (docs/TERMINAL_UX 审批界面): the agent child
 * emits one magic JSON line per tool-approval request and blocks on an
 * `allow`/`reject` stdin answer — pure encode/parse, no SDK.
 */

describe('approval channel (unit)', () => {
  it('round-trips a request through an encoded stdout line', () => {
    const line = encodeApprovalRequest({ toolName: 'pwsh', reason: 'run ls' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.startsWith(APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(parseApprovalRequest(line.trim())).toEqual({ toolName: 'pwsh', reason: 'run ls' });
  });

  it('ignores ordinary output lines', () => {
    expect(parseApprovalRequest('agent turn → session ses_1 (new, …)')).toBeNull();
    expect(parseApprovalRequest('')).toBeNull();
    expect(parseApprovalRequest(`${APPROVAL_REQUEST_PREFIX}not-json`)).toBeNull();
    expect(parseApprovalRequest(`${APPROVAL_REQUEST_PREFIX}{"reason":"no tool"}`)).toBeNull();
  });

  it('answers vocabulary is plain stdin lines', () => {
    expect(APPROVAL_ALLOW).toBe('allow');
    expect(APPROVAL_REJECT).toBe('reject');
  });
});
