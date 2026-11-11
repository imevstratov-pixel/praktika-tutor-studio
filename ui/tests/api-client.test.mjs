import test from 'node:test';
import assert from 'node:assert/strict';
import {apiMode, readApiStatus} from '../src/lib/api-client.mjs';

const doc = content => ({querySelector: () => content === null ? null : {getAttribute: () => content}});

test('API discovery requires exact hosted opt-in or an existing loopback HTTP page', () => {
  for (const hostname of ['imevstratov-pixel.github.io', 'demo.example', 'localhost.example']) {
    assert.equal(apiMode({protocol:'https:', hostname}, doc(null)), 'offline');
    assert.equal(apiMode({protocol:'https:', hostname}, doc('same-origin')), 'hosted');
    assert.equal(apiMode({protocol:'https:', hostname}, doc('https://another.example')), 'offline');
  }
  for (const hostname of ['127.0.0.1', 'localhost']) {
    assert.equal(apiMode({protocol:'http:', hostname}, doc(null)), 'local');
    assert.equal(apiMode({protocol:'http:', hostname}, doc('same-origin')), 'hosted');
  }
  assert.equal(apiMode({protocol:'file:', hostname:''}, doc('same-origin')), 'offline');
});

test('status uses a fixed same-origin URL, no redirects/cache, and keeps only safe public fields', async () => {
  let request;
  const result = await readApiStatus({fetchImpl:async (url, options) => {
    request = {url, options};
    return new Response(JSON.stringify({ai:true, provider:' Demo model ', remaining:3, unexpected:'discard'}));
  }});
  assert.equal(request.url, '/api/status');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store');
  assert.deepEqual(result, {ai:true, provider:'Demo model', remaining:3});
});

test('status distinguishes provider off from invalid, denied and unreadable responses', async () => {
  assert.deepEqual(await readApiStatus({fetchImpl:async () => new Response('{"ai":false,"provider":"off"}')}), {ai:false, provider:''});
  for (const body of ['null', '[]', '{}', '{"ai":"true"}', '{"ai":true,"provider":""}', 'not json']) {
    await assert.rejects(readApiStatus({fetchImpl:async () => new Response(body)}));
  }
  await assert.rejects(readApiStatus({fetchImpl:async () => new Response('{}', {status:503})}));
  await assert.rejects(readApiStatus({fetchImpl:async () => {throw new TypeError('Failed to fetch')}}));
});

test('stalled status is aborted within a bounded timeout, and a later check can recover', {timeout:1000}, async () => {
  let requestSignal;
  await assert.rejects(readApiStatus({timeoutMs:10, fetchImpl:(_url, {signal}) => {
    requestSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  }}), {name:'TimeoutError'});
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(await readApiStatus({fetchImpl:async () => new Response('{"ai":true,"provider":"Recovered"}')}), {ai:true, provider:'Recovered'});
});

test('unmount or superseded check cancels the status request', async () => {
  const controller = new AbortController();
  const request = readApiStatus({signal:controller.signal, fetchImpl:(_url, {signal}) => new Promise((_resolve,reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  })});
  controller.abort();
  await assert.rejects(request, {name:'AbortError'});
});
