import { expect, test } from 'bun:test';
import { createRuntimeState } from '../runtime-state.js';

test('runtime instances isolate requests, approvals and turn ownership even when identifiers collide', () => {
 const a = createRuntimeState(), b = createRuntimeState();
 expect(a.nextRequestId()).toBe(1); expect(b.nextRequestId()).toBe(1);
 a.pending.set(1, { resolve() {}, reject() {} });
 b.pending.set(1, { resolve() {}, reject() {} });
 a.approvalRequests.set(1, { params: { threadId: 'a' } });
 b.approvalRequests.set(1, { params: { threadId: 'b' } });
 a.activeTurns.add('thread'); b.activeTurns.add('thread');
 a.turnThreads.set('turn', 'a'); b.turnThreads.set('turn', 'b');
 a.clearActivity();
 expect(a.approvalRequests.size).toBe(0); expect(a.activeTurns.size).toBe(0);
 expect(b.approvalRequests.get(1).params.threadId).toBe('b');
 expect(b.activeTurns.has('thread')).toBe(true); expect(b.turnThreads.get('turn')).toBe('b');
 expect(b.pending.has(1)).toBe(true);
});
