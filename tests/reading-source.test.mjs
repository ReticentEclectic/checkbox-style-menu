import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskLine, replaceTaskSymbol } from '../src/reading-source.ts';

test('resolves absolute and section-relative rendered lines', () => {
    const lines = ['heading', 'text', '- [ ] one', '  - [x] child', '- [ ] two'];
    assert.equal(resolveTaskLine(lines, { lineStart: 2, lineEnd: 4 }, '3', 'child'), 3);
    assert.equal(resolveTaskLine(lines, { lineStart: 2, lineEnd: 4 }, '1', 'child'), 3);
});

test('does not guess when duplicate tasks fit both line interpretations', () => {
    const lines = ['heading', '- [ ] other', '- [ ] same', '- [ ] same'];
    assert.equal(resolveTaskLine(lines, { lineStart: 1, lineEnd: 3 }, '2', 'same'), null);
    assert.equal(resolveTaskLine(lines, { lineStart: 1, lineEnd: 3 }, null, 'same'), null);
});

test('rejects a changed task line during the atomic write', () => {
    const original = '- [ ] task';
    assert.equal(replaceTaskSymbol(original, 0, original, 'x'), '- [x] task');
    assert.equal(replaceTaskSymbol('- [ ] revised', 0, original, 'x'), '- [ ] revised');
    assert.equal(replaceTaskSymbol('- [x] task', 0, original, '/'), '- [x] task');
});
