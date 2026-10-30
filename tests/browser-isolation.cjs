// Run with CHROMIUM_EXECUTABLE pointing to a Chromium installation (Node.js 22+).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-isolation-test-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, cookies: req.headers.cookie || '' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login') res.setHeader('Set-Cookie', [
      `session=${url.searchParams.get('user')}; Path=/; HttpOnly; SameSite=Lax`,
      `visible=${url.searchParams.get('user')}; Path=/; SameSite=Lax`,
    ]);
    if (url.pathname === '/who') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cookies: req.headers.cookie || '' }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><script>window.firstCookies=document.cookie; window.firstStorage=localStorage.getItem("identity"); window.firstToken=localStorage.getItem("token");</script><p>Local isolation test</p><a id="assistant-link" href="/aiassistant/#/">AI assistant</a>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const root = path.resolve(__dirname, '..');
    const child = spawn(process.env.CHROMIUM_EXECUTABLE, [
      '--headless=new', '--silent-debugger-extension-api', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--disable-extensions-except=' + root, '--load-extension=' + root,
      'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let logs = '';
      const timeout = setTimeout(() => reject(new Error('Browser startup timed out: ' + logs)), 20000);
      child.on('error', reject);
      child.stderr.on('data', chunk => {
        logs += chunk.toString();
        const match = logs.match(/DevTools listening on (ws:\/\/[^\r\n]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let next = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.consoleAPICalled' && process.env.MC_TEST_DEBUG) {
        console.log('[Browser]', message.params.args.map(a => a.value || a.description).join(' '));
      }
      if (!message.id) return;
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    browser = { close: async () => {
      const exited = new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
      try { await send('Browser.close'); } finally { socket.close(); await exited; }
    } };
    const wait = async fn => {
      for (let i = 0; i < 150; i++) {
        const value = await fn();
        if (value) return value;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('Timed out waiting for browser state');
    };
    const target = await wait(async () => (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://')));
    if (process.env.MC_TEST_DEBUG) {
      const workerSession = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await send('Runtime.enable', {}, workerSession.sessionId);
    }
    const id = new URL(target.url).host;
    const popup = await send('Target.createTarget', { url: 'chrome-extension://' + id + '/popup/popup.html' });
    let attached = await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const message = async m => {
      const result = await evaluate('chrome.runtime.sendMessage(' + JSON.stringify(m) + ')');
      assert.ok(!result?.error, result?.error);
      return result;
    };
    await wait(async () => evaluate('typeof chrome !== "undefined" && !!chrome.runtime?.id'));
    // Theme controls persist independently of container data and sync both UIs.
    await wait(async () => evaluate('!!document.getElementById("theme-toggle") && !!document.querySelector(".cl-item")'));
    const panelTarget = await send('Target.createTarget', { url: 'chrome-extension://' + id + '/side-panel/panel.html' });
    const panelSession = (await send('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: true })).sessionId;
    await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 760, deviceScaleFactor: 1, mobile: false }, panelSession);
    const panelEval = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, panelSession);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const capture = async (name, sessionId, width, height) => {
      if (!process.env.MC_THEME_SCREENSHOTS_DIR) return;
      fs.mkdirSync(process.env.MC_THEME_SCREENSHOTS_DIR, { recursive: true });
      await send('Page.bringToFront', {}, sessionId);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
      fs.writeFileSync(path.join(process.env.MC_THEME_SCREENSHOTS_DIR, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    await wait(async () => panelEval('!!document.querySelector(".container-item")'));
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
    await evaluate('document.getElementById("theme-toggle").click()');
    await wait(async () => panelEval('document.documentElement.dataset.theme === "light"'));
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
    assert.equal(await panelEval('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 255, 255)');
    await capture('panel-light', panelSession, 380, 760);
    await capture('popup-light', attached.sessionId, 320, 580);
    await evaluate('document.getElementById("menu-create").click()');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("m-name")).backgroundColor'), 'rgb(255, 255, 255)');
    await capture('popup-light-modal', attached.sessionId, 320, 580);
    await evaluate('document.getElementById("m-cancel").click()');
    await panelEval('document.getElementById("theme-toggle").click()');
    await wait(async () => evaluate('document.documentElement.dataset.theme === "dark"'));
    await capture('popup-dark', attached.sessionId, 320, 580);
    await capture('panel-dark', panelSession, 380, 760);
    await panelEval('document.getElementById("theme-toggle").click()');
    await wait(async () => evaluate('document.documentElement.dataset.theme === "light"'));
    await send('Page.reload', {}, attached.sessionId);
    await wait(async () => evaluate('document.readyState === "complete" && !!document.querySelector(".cl-item")'));
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    assert.equal(await evaluate('document.getElementById("theme-toggle").getAttribute("aria-label")'), '切换深色');
    assert.equal(await evaluate('(async () => (await chrome.storage.local.get("ui_theme")).ui_theme)()'), 'light');
    await send('Target.closeTarget', { targetId: panelTarget.targetId });
    const run = async (tabId, expression) => {
      const result = await evaluate('chrome.debugger.sendCommand({tabId:' + tabId + '}, "Runtime.evaluate", ' + JSON.stringify({ expression, awaitPromise: true, returnByValue: true, userGesture: true }) + ')');
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const loaded = async tabId => wait(async () => {
      const tab = await evaluate('chrome.tabs.get(' + tabId + ')');
      return tab.status === 'complete';
    });
    const open = async (containerId, url) => {
      const result = await message({ action: 'openInContainer', containerId, url });
      await loaded(result.tabId);
      return result.tabId;
    };
    const who = tabId => run(tabId, '(async () => (await (await fetch("/who")).json()).cookies)()');
    const work = await open('work', base + '/login?user=alice');
    assert.match(await who(work), /session=alice/);
    await wait(async () => (await run(work, 'document.cookie')) === 'visible=alice');
    await run(work, 'localStorage.setItem("identity", "alice")');
    const personal = await open('personal', base + '/empty');
    assert.equal(await who(personal), '');
    assert.equal(await run(personal, 'window.firstCookies'), '');
    assert.equal(await run(personal, 'window.firstStorage'), null);
    await evaluate('chrome.tabs.update(' + personal + ', {url:' + JSON.stringify(base + '/login?user=bob') + '})');
    await loaded(personal);
    assert.match(await who(personal), /session=bob/);
    await run(personal, 'localStorage.setItem("identity", "bob")');
    assert.match(await who(work), /session=alice/);
    assert.equal(await run(work, 'localStorage.getItem("identity")'), 'alice');
    assert.equal(await run(personal, 'localStorage.getItem("identity")'), 'bob');
    assert.equal(await run(work, 'localStorage.identity'), 'alice');
    assert.equal(await run(personal, 'localStorage.identity'), 'bob');
    await run(personal, 'localStorage.extra = "personal-only"; document.cookie = "jsToken=bob; Path=/"');
    await wait(async () => (await who(personal)).includes('jsToken=bob'));
    assert.ok(!(await who(work)).includes('jsToken=bob'));
    assert.equal(await run(work, 'localStorage.extra'), undefined);
    assert.deepEqual(await run(personal, 'Object.keys(localStorage).sort()'), ['extra', 'identity']);
    for (const tabId of [work, personal]) {
      const before = await run(tabId, 'performance.timeOrigin');
      await evaluate('chrome.tabs.reload(' + tabId + ')');
      await loaded(tabId);
      await wait(async () => (await run(tabId, 'performance.timeOrigin')) !== before);
    }
    assert.match(await who(work), /session=alice/);
    assert.match(await who(personal), /session=bob/);
    assert.equal(await run(work, 'window.firstCookies'), 'visible=alice');
    const visiblePersonal = await run(personal, 'window.firstCookies');
    assert.match(visiblePersonal, /visible=bob/);
    assert.match(visiblePersonal, /jsToken=bob/);
    assert.ok(!visiblePersonal.includes('session='));
    assert.equal(await run(work, 'window.firstStorage'), 'alice');
    assert.equal(await run(personal, 'window.firstStorage'), 'bob');
    const jar = await evaluate('chrome.cookies.getAll({ domain: "127.0.0.1" })');
    assert.equal(jar.length, 0, 'Container cookies do not remain in the shared jar');
    const groups = await evaluate('chrome.tabGroups.query({})');
    assert.ok(groups.some(g => g.title === 'Work'));
    assert.ok(groups.some(g => g.title === 'Personal'));
    // Match the reported same-origin /asset/ -> /aiassistant/ navigation.
    for (const [tabId, token] of [[work, 'alice-token'], [personal, 'bob-token']]) {
      await run(tabId, 'localStorage.setItem("token", ' + JSON.stringify(token) + ')');
      await evaluate('chrome.tabs.update(' + tabId + ', {url:' + JSON.stringify(base + '/asset/#/dashboard') + '})');
      await loaded(tabId);
      assert.equal(await run(tabId, 'window.firstToken'), token);
      for (const method of ['window-open', 'blank-link', 'ctrl-click', 'middle-click']) {
        const beforeTabs = await evaluate('chrome.tabs.query({})');
        const destination = '/aiassistant/?probe=' + tabId + '-' + method + '#/';
        // The reported site is HTTP on an intranet; randomUUID is unavailable there.
        await run(tabId, 'crypto.randomUUID = undefined');
        if (method === 'window-open') {
          assert.equal(await run(tabId, '!!window.open(' + JSON.stringify(destination) + ', "_blank")'), true);
        } else {
          await run(tabId, '(function(){ const a = document.getElementById("assistant-link"); a.href = ' + JSON.stringify(destination) + '; a.target = ' + JSON.stringify(method === 'blank-link' ? '_blank' : '_self') + '; a.dispatchEvent(new MouseEvent(' + JSON.stringify(method === 'middle-click' ? 'auxclick' : 'click') + ', {bubbles:true, cancelable:true, button:' + (method === 'middle-click' ? 1 : 0) + ', ctrlKey:' + (method === 'ctrl-click') + '})); })()');
        }
        const childTab = await wait(async () => (await evaluate('chrome.tabs.query({})')).find(t => !beforeTabs.some(old => old.id === t.id)));
        await wait(async () => (await evaluate('chrome.tabs.get(' + childTab.id + ')')).url === base + destination);
        await loaded(childTab.id);
        assert.equal(await run(childTab.id, 'window.firstToken'), token, method + ': initial script gets opener token');
        assert.match(requests.find(r => r.url === destination.split('#')[0])?.cookies || '', tabId === work ? /session=alice/ : /session=bob/, method + ': first HTTP request uses opener cookies');
        assert.match(await who(childTab.id), tabId === work ? /session=alice/ : /session=bob/);
        await wait(async () => {
          const parent = await evaluate('chrome.tabs.get(' + tabId + ')');
          return (await evaluate('chrome.tabs.get(' + childTab.id + ')')).groupId === parent.groupId;
        });
        await evaluate('chrome.tabs.remove(' + childTab.id + ')');
      }
      await run(tabId, 'document.getElementById("assistant-link").href = "/aiassistant/#/"; document.getElementById("assistant-link").target = "_self"');
      await run(tabId, 'document.getElementById("assistant-link").click()');
      await loaded(tabId);
      assert.equal(await run(tabId, 'location.pathname'), '/aiassistant/');
      assert.equal(await run(tabId, 'window.firstToken'), token);
    }
    // Reload the extension, then refresh its existing tabs after isolation recovers.
    await evaluate('chrome.runtime.reload()').catch(() => {});
    await wait(async () => (await send('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.includes(id) && t.targetId !== target.targetId));
    const replacement = await send('Target.createTarget', { url: 'chrome-extension://' + id + '/popup/popup.html' });
    attached = await send('Target.attachToTarget', { targetId: replacement.targetId, flatten: true });
    await wait(async () => evaluate('typeof chrome !== "undefined" && !!chrome.runtime?.id'));
    await message({ action: 'ping' });
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light', 'Theme survives extension reload');
    for (const tabId of [work, personal]) {
      await wait(async () => { try { return await run(tabId, 'true'); } catch { return false; } });
      await evaluate('chrome.tabs.reload(' + tabId + ')');
      await loaded(tabId);
    }
    assert.match(await who(work), /session=alice/);
    assert.match(await who(personal), /session=bob/);
    assert.equal(await run(work, 'localStorage.identity'), 'alice');
    assert.equal(await run(personal, 'localStorage.identity'), 'bob');
    console.log('PASS: light/dark themes sync between popup and panel and survive reloads; independent Alice/Bob logins; window.open, target=_blank, Ctrl-click and middle-click inherit initial token, first-request cookies and group; same-tab path navigation; HttpOnly, storage, page/extension reloads and shared jar cleanup');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (path.resolve(profile).startsWith(tempRoot) && path.basename(profile).startsWith('mc-isolation-test-')) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
