import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClipboardWriter} from '../src/lib/clipboard.mjs';

function fallbackDocument(result = true) {
  const calls = [], fields = [];
  const original = {focus() { document.activeElement = this; calls.push('restore-focus'); }};
  const document = {
    activeElement: original,
    body: {append(field) { fields.push(field); }},
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return {style: {}, setAttribute() {}, focus() { document.activeElement = this; },
        select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        remove() { fields.splice(fields.indexOf(this), 1); }};
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      const field = document.activeElement;
      calls.push({text: field.value, readonly: field.readOnly, selection: [field.selectionStart, field.selectionEnd]});
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {document, calls, fields, original};
}
function writeOnlyClipboard(writeText) {
  return {writeText, get readText() { throw Error('Clipboard must never be read'); }, get read() { throw Error('Clipboard must never be read'); }};
}

test('clipboard API writes the exact payload and confirms success only after resolution', async () => {
  let resolve, calls = [];
  const fallback = fallbackDocument();
  const write = createClipboardWriter({isSecureContext: true, navigator: {clipboard: writeOnlyClipboard(text => {
    calls.push(text); return new Promise(done => { resolve = done; });
  })}, document: fallback.document});
  const text = '  Инструкция\n\n{"json":"😀"}\n';
  let completed = false;
  const result = write(text).then(value => { completed = true; return value; });
  assert.deepEqual(calls, [text]);
  await Promise.resolve();
  assert.equal(completed, false);
  resolve();
  assert.equal(await result, true);
  assert.deepEqual(fallback.calls, []);
});

test('unavailable or denied clipboard API uses a confirmed selection copy and restores focus', async () => {
  for (const clipboard of [undefined, writeOnlyClipboard(async () => { throw Error('Denied'); })]) {
    const fallback = fallbackDocument();
    const write = createClipboardWriter({isSecureContext: true, navigator: {clipboard}, document: fallback.document});
    assert.equal(await write(' A\nБ😀 '), true);
    assert.deepEqual(fallback.calls, [{text: ' A\nБ😀 ', readonly: true, selection: [0, 7]}, 'restore-focus']);
    assert.equal(fallback.document.activeElement, fallback.original);
    assert.deepEqual(fallback.fields, []);
  }
});

test('insecure context uses the selection path without calling the secure API', async () => {
  const fallback = fallbackDocument();
  const write = createClipboardWriter({isSecureContext: false, navigator: {clipboard: writeOnlyClipboard(() => { throw Error('Must not be called'); })}, document: fallback.document});
  assert.equal(await write('Local file'), true);
  assert.equal(fallback.calls[0].text, 'Local file');
});

test('false, nonboolean and throwing selection copies never report success and always remove the field', async () => {
  for (const result of [false, undefined, 'true', new Error('Blocked')]) {
    const fallback = fallbackDocument(result);
    // Passing undefined to the fixture uses its default; overwrite for this case.
    if (result === undefined) fallback.document.execCommand = () => undefined;
    const write = createClipboardWriter({isSecureContext: false, document: fallback.document});
    assert.equal(await write('Manual copy only'), false);
    assert.deepEqual(fallback.fields, []);
    assert.equal(fallback.document.activeElement, fallback.original);
  }
  assert.equal(await createClipboardWriter({})('No browser'), false);
});

test('outstanding writes are serialized so an older result cannot overwrite a newer payload', async () => {
  const started = [], finish = [];
  const write = createClipboardWriter({isSecureContext: true, navigator: {clipboard: writeOnlyClipboard(text => {
    started.push(text); return new Promise(resolve => { finish.push(resolve); });
  })}});
  const first = write('First prompt');
  const second = write('Second prompt');
  assert.deepEqual(started, ['First prompt']);
  finish[0]();
  assert.equal(await first, true);
  await Promise.resolve();
  assert.deepEqual(started, ['First prompt', 'Second prompt']);
  finish[1]();
  assert.equal(await second, true);
});

test('a replaced prompt never starts a stale queued write or a fallback after rejection', async () => {
  let reject, current = true;
  const fallback = fallbackDocument();
  const calls = [];
  const write = createClipboardWriter({isSecureContext: true, document: fallback.document, navigator: {clipboard: writeOnlyClipboard(text => {
    calls.push(text); return new Promise((resolve, fail) => { reject = fail; });
  })}});
  const first = write('Old prompt', () => current);
  const queued = write('Also replaced', () => current);
  current = false;
  reject(Error('Denied after switch'));
  assert.equal(await first, false);
  assert.equal(await queued, false);
  assert.deepEqual(calls, ['Old prompt']);
  assert.deepEqual(fallback.calls, []);
});
