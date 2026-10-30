const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers/chrome-worker.cjs');

const work = { id: 'work', name: 'Work', color: '#fb9349' };
const personal = { id: 'personal', name: 'Personal', color: '#37adff' };
const paused = (id, url = 'https://example.com/') => ({
  requestId: id, request: { url, headers: { Cookie: 'session=shared', Accept: '*/*' } },
});

test('child pages inherit the sender container before navigating, regardless of a supplied container ID', async () => {
  const marker = 'about:blank#mc-child-' + 'a'.repeat(32);
  const { context, commands, tabs, data, flushGroups } = await loadWorker({
    containers: { work, personal }, tab_container_map: { 1: 'work' }
  }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, url: marker, status: 'complete' }]);
  const child = await context.handleMessage({ action: 'prepareChildTab', marker,
    url: 'http://example.com/aiassistant/#/', containerId: 'personal' }, { tab: { id: 1 } });
  assert.equal(child.containerId, 'work');
  assert.equal(data.tab_container_map[2], 'work');
  const attach = commands.findIndex(c => c.method === 'Fetch.enable' && c.tabId === 2);
  const navigate = commands.findIndex(c => c.method === 'tabs.update' && c.params.url.startsWith('http'));
  assert.ok(attach >= 0 && navigate > attach);
  await flushGroups();
  assert.equal(tabs.get(2).groupId, tabs.get(1).groupId);
});

test('a child remains blank if isolation cannot start, and unassigned senders cannot claim children', async () => {
  const marker = 'about:blank#mc-child-' + 'b'.repeat(32);
  const { context, commands, tabs } = await loadWorker({
    containers: { work }, tab_container_map: { 1: 'work' }
  }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 1, url: marker, status: 'complete' }], [], { attachError: 'Debugger unavailable' });
  const message = { action: 'prepareChildTab', marker, url: 'http://example.com/aiassistant/#/' };
  await assert.rejects(context.handleMessage(message, { tab: { id: 3 } }), /opener has no container/);
  await assert.rejects(context.handleMessage(message, { tab: { id: 1 } }), /isolation could not start/);
  assert.equal(tabs.get(2).url, 'about:blank');
  assert.ok(!commands.some(c => c.method === 'tabs.update' && c.params.url.startsWith('http')));
});

test('fresh containers explicitly replace the shared Cookie header with an empty value', async () => {
  const { context, commands } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' } }, [{ id: 1, windowId: 1 }]);
  await context.handlePausedRequest(1, paused('fresh'));
  const request = commands.find(c => c.method === 'Fetch.continueRequest');
  assert.equal(request.params.headers.find(h => h.name === 'Cookie').value, '');
});

test('each request selects the correct container, host, path, secure and expiry cookies', async () => {
  const { context, commands } = await loadWorker({
    containers: { work, personal }, tab_container_map: { 1: 'work', 2: 'personal' },
    container_cookies_work: { '.example.com': [
      { name: 'session', value: 'alice', domain: '.example.com', path: '/', httpOnly: true },
      { name: 'private', value: 'x', domain: '.example.com', path: '/private' },
      { name: 'expired', value: 'x', domain: '.example.com', path: '/', expirationDate: 1 },
      { name: 'host', value: 'x', domain: 'example.com', path: '/', hostOnly: true },
      { name: 'secure', value: 'x', domain: '.example.com', path: '/', secure: true },
    ] },
    container_cookies_personal: { '.example.com': [{ name: 'session', value: 'bob', domain: '.example.com', path: '/' }] },
  }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }]);
  await context.handlePausedRequest(1, paused('alice', 'http://sub.example.com/public'));
  await context.handlePausedRequest(2, paused('bob'));
  await context.handlePausedRequest(1, paused('other', 'https://other.com/'));
  const values = commands.filter(c => c.method === 'Fetch.continueRequest').map(c => c.params.headers.find(h => h.name === 'Cookie').value);
  assert.deepEqual(values, ['session=alice', 'session=bob', '']);
});

test('response cookies are stripped before the shared jar, retained per container and deletable', async () => {
  const { context, commands } = await loadWorker({ containers: { work, personal }, tab_container_map: { 1: 'work', 2: 'personal' } }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }]);
  const response = { ...paused('login'), responseStatusCode: 200,
    responseHeaders: [{ name: 'Set-Cookie', value: 'session=alice; Path=/; HttpOnly' }, { name: 'Content-Type', value: 'text/html' }] };
  await context.handlePausedRequest(1, response);
  const resumed = commands.find(c => c.method === 'Fetch.continueResponse');
  assert.ok(resumed.params.responseHeaders.every(h => h.name !== 'Set-Cookie'));
  await context.handlePausedRequest(1, paused('work'));
  await context.handlePausedRequest(2, paused('personal'));
  let values = commands.filter(c => c.method === 'Fetch.continueRequest').map(c => c.params.headers.find(h => h.name === 'Cookie').value);
  assert.deepEqual(values, ['session=alice', '']);
  const visible = await context.handleMessage({ action: 'getCookieString', containerId: 'personal', url: 'https://example.com/' }, { tab: { id: 1 }, url: 'https://example.com/' });
  assert.equal(visible.cookieString, '', 'HttpOnly is never exposed to document.cookie');
  await context.handlePausedRequest(1, { ...response, requestId: 'logout', responseHeaders: [{ name: 'Set-Cookie', value: 'session=; Path=/; Max-Age=0' }] });
  await context.handlePausedRequest(1, paused('after-logout'));
  assert.equal(commands.at(-1).params.headers.find(h => h.name === 'Cookie').value, '');
});

test('isolation and per-tab bootstrap start before the first website navigation', async () => {
  const { context, commands, tabs } = await loadWorker({ containers: { work } });
  const result = await context.openInContainer('https://example.com/', 'work');
  const enabled = commands.findIndex(c => c.method === 'Fetch.enable');
  const navigate = commands.findIndex(c => c.method === 'tabs.update');
  assert.ok(enabled >= 0 && enabled < navigate);
  const script = commands.find(c => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.match(script.params.source, /__mcContainerId = "work"/);
  assert.equal(tabs.get(result.tabId).url, 'https://example.com/');
});

test('debugger failure keeps the tab blank and returns an error instead of opening unisolated', async () => {
  const { context, tabs, commands } = await loadWorker({ containers: { work } }, [], [], { attachError: 'Debugger unavailable' });
  await assert.rejects(context.openInContainer('https://example.com/', 'work'), /isolation could not start/);
  assert.equal([...tabs.values()][0].url, 'about:blank');
  assert.ok(commands.every(c => c.method !== 'tabs.update'));
});

test('failed Cookie injection blocks the request and never falls back to shared credentials', async () => {
  const { chrome, commands } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' } }, [{ id: 1, windowId: 1 }], [], {
    sendCommand: async (_, method) => { if (method === 'Fetch.continueRequest') throw new Error('Rejected'); },
  });
  await chrome.debugger.onEvent.listeners[0]({ tabId: 1 }, 'Fetch.requestPaused', paused('failure'));
  assert.equal(commands.filter(c => c.method === 'Fetch.continueRequest').length, 1);
  assert.equal(commands.at(-1).method, 'Fetch.failRequest');
});

test('slow grouping does not block container messages or isolation startup', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { context, commands, flushGroups } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' } }, [{ id: 1, windowId: 1 }], [], {
    group: () => blocked, waitForRecovery: false,
  });
  try {
    const result = await context.handleMessage({ action: 'getContainers' }, {});
    assert.equal(result[0].id, 'work');
    await context.openInContainer('https://example.com/', 'work');
    assert.ok(commands.some(c => c.method === 'Fetch.enable'));
  } finally { release(); await flushGroups(); }
});

test('simultaneous responses retain all cookies instead of overwriting the container jar', async () => {
  const { context } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' } }, [{ id: 1, windowId: 1 }]);
  await Promise.all(['a', 'b', 'c'].map(name => context.handlePausedRequest(1, {
    ...paused(name), responseStatusCode: 200, responseHeaders: [{ name: 'Set-Cookie', value: `${name}=1; Path=/` }],
  })));
  const result = await context.handleMessage({ action: 'getCookieString', containerId: 'work', url: 'https://example.com/' }, {});
  assert.equal(result.cookieString.split('; ').sort().join('; '), 'a=1; b=1; c=1');
});

test('container CRUD retains live mappings and removes deleted container rules and bindings', async () => {
  const { context, data } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' }, always_open: { 'example.com': 'work' } }, [{ id: 1, windowId: 1 }]);
  const created = await context.handleMessage({ action: 'createContainer', data: { name: 'Second' } }, {});
  assert.equal(data.containers[created.id].name, 'Second');
  await context.handleMessage({ action: 'deleteContainer', containerId: 'work' }, {});
  assert.equal(await context.handleMessage({ action: 'getTabContainer', tabId: 1 }, {}), null);
  assert.equal(data.containers.work, undefined);
  assert.equal(data.always_open['example.com'], undefined);
  assert.ok(data.containers[created.id]);
});

test('complete response headers correlate by request ID when Fetch omits Set-Cookie', async () => {
  const { context, commands } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' } }, [{ id: 1, windowId: 1 }]);
  const handling = context.handlePausedRequest(1, { ...paused('response', 'https://login.example.com/'), networkId: 'network-login', responseStatusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] });
  await new Promise(resolve => setImmediate(resolve));
  context.receiveResponseHeaders(1, { requestId: 'network-login', headers: { 'Set-Cookie': 'session=alice; Path=/; HttpOnly\ncsrf=token; Path=/' } });
  await handling;
  await context.handlePausedRequest(1, paused('matching', 'https://login.example.com/'));
  assert.match(commands.at(-1).params.headers.find(h => h.name === 'Cookie').value, /session=alice/);
  await context.handlePausedRequest(1, paused('different', 'https://example.com/'));
  assert.equal(commands.at(-1).params.headers.find(h => h.name === 'Cookie').value, '');
});

test('a fresh login replaces a legacy leading-dot host cookie instead of sending two sessions', async () => {
  const { context, commands } = await loadWorker({ containers: { work }, tab_container_map: { 1: 'work' },
    container_cookies_work: { '.example.com': [{ name: 'session', value: 'old-shared', domain: '.example.com', path: '/' }] },
  }, [{ id: 1, windowId: 1 }]);
  await context.handlePausedRequest(1, { ...paused('login'), responseStatusCode: 200, responseHeaders: [{ name: 'Set-Cookie', value: 'session=alice; Path=/' }] });
  await context.handlePausedRequest(1, paused('next'));
  assert.equal(commands.at(-1).params.headers.find(h => h.name === 'Cookie').value, 'session=alice');
});
