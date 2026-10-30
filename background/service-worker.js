// ============================================================
// background/service-worker.js — v4.4
// ============================================================
// تغییرات v4.4:
//   🐛 رفع باگ TypeError: origHeaders.map is not a function
//      — CDP headers ممکن است به صورت Object باشد (نه Array)
//      — حالا هر دو فرمت (Array و Object) پشتیبانی می‌شود
//   🐛 رفع مشکل Debug popup (inline style override)
//   🎨 حذف badge رنگی کوچک کنار تب وقتی showTabColor فعال باشد
//   🎨 مخفی کردن container indicator (نشانگر شناور) وقتی showTabColor فعال باشد
//   ☑️ checkbox "Color tab bar" per container (دیفالت خاموش)
//   ✏️ کلیک روی container name در side-panel = ویرایش (نه prompt)
//   ℹ️ بخش Info با ایمیل و آدرس ولت
// ============================================================
// تغییرات v4.3 (حفظ شده):
//   ☑️ Opt-in colored tabs per container
// ============================================================
// تغییرات v4.2 (حفظ شده):
//   🎨 تب‌های هر container با رنگ container نمایش داده می‌شوند
//      از طریق chrome.tabGroups API
// ============================================================
// تغییرات v4.1 (حفظ شده):
//   - Debugger-based cookie isolation (CDP Fetch + Network)
//   - Set-Cookie capture از Network.responseReceived
//   - حذف خودکار کوکی از shared jar
//   - Service Worker blocking
//   - Storage isolation (localStorage, IndexedDB, CacheStorage)
// ============================================================

import ContainerManager from '../lib/container-manager.js';
import CookieManager from '../lib/cookie-manager.js';
import TabManager from '../lib/tab-manager.js';
import DebuggerManager from '../lib/debugger-manager.js';
import { STORAGE_KEYS, ICON_MAP } from '../lib/constants.js';

const containerMgr = new ContainerManager();
const cookieMgr = new CookieManager(chrome.storage.local);
const tabMgr = new TabManager();
const debuggerMgr = new DebuggerManager();
let lastActiveContainer = null;
let lastError = null;

// Guard against infinite reload loops
const _reloadingTabs = new Set();

// ============================================================
// TAB GROUP MANAGEMENT — v4.4 (Opt-in per container!)
// ============================================================
// Map: "windowId:containerId" -> groupId
let _groupMap = {};

// رنگ‌های Tab Group در Chromium: فقط ۹ رنگ ثابت
const CHROME_GROUP_COLORS = {
  '#37adff': 'blue', '#51c4d3': 'cyan', '#7bc962': 'green',
  '#ffcb3e': 'yellow', '#fb9349': 'orange', '#f25c54': 'red',
  '#e861a5': 'pink', '#a87bda': 'purple', '#7c7c7d': 'grey'
};

// تبدیل hex color به نزدیک‌ترین رنگ Chrome Tab Group
function _toGroupColor(hexColor) {
  if (CHROME_GROUP_COLORS[hexColor]) return CHROME_GROUP_COLORS[hexColor];

  const predefined = {
    blue: [55,173,255], cyan: [81,196,211], green: [123,201,98],
    yellow: [255,203,62], orange: [251,147,73], red: [242,92,84],
    pink: [232,97,165], purple: [168,123,218], grey: [124,124,125]
  };
  const r = parseInt(hexColor.slice(1,3),16);
  const g = parseInt(hexColor.slice(3,5),16);
  const b = parseInt(hexColor.slice(5,7),16);
  let best = 'grey', minD = Infinity;
  for (const [name, [pr,pg,pb]] of Object.entries(predefined)) {
    const d = (r-pr)**2 + (g-pg)**2 + (b-pb)**2;
    if (d < minD) { minD = d; best = name; }
  }
  return best;
}

// بارگذاری group map از storage
async function _loadGroupMap() {
  try {
    const data = await chrome.storage.local.get('mc_group_map');
    const saved = data.mc_group_map || {};

    if (chrome.tabGroups) {
      try {
        const groups = await chrome.tabGroups.query({});
        const validIds = new Set(groups.map(g => String(g.id)));
        for (const [key, gid] of Object.entries(saved)) {
          if (validIds.has(String(gid))) {
            _groupMap[key] = gid;
          }
        }
      } catch (e) {
        console.warn('[TabGroup] Query failed:', e.message);
        _groupMap = saved;
      }
    } else {
      _groupMap = saved;
    }
    console.log('[TabGroup] Loaded map:', Object.keys(_groupMap).length, 'groups');
  } catch (e) {
    console.warn('[TabGroup] Load error:', e.message);
    _groupMap = {};
  }
}

// ذخیره group map در storage
async function _saveGroupMap() {
  try {
    await chrome.storage.local.set({ mc_group_map: _groupMap });
  } catch (e) {}
}

// Serialize group creation so simultaneous tabs share one group per window/container.
let _groupQueue = Promise.resolve();
function addToContainerGroup(tabId, container) {
  const pending = _groupQueue.then(() => _addToContainerGroup(tabId, container));
  _groupQueue = pending.catch(() => {});
  return pending;
}

async function _addToContainerGroup(tabId, container) {
  if (!chrome.tabGroups || !container) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return;

    const key = tab.windowId + ':' + container.id;
    const groupColor = _toGroupColor(container.color);

    // بررسی آیا گروه قبلاً وجود دارد
    if (_groupMap[key] !== undefined) {
      try {
        const groupId = _groupMap[key];
        const group = await chrome.tabGroups.get(groupId);
        if (group.windowId !== tab.windowId) throw new Error('Group moved to another window');
        // گروه وجود دارد — اضافه کردن تب
        await chrome.tabs.group({ tabIds: [tabId], groupId });
        await chrome.tabGroups.update(groupId, { title: container.name, color: groupColor });
        console.log('[TabGroup] Added tab', tabId, 'to existing group', groupId);
        return;
      } catch (e) {
        // گروه حذف شده — ساختن گروه جدید
        delete _groupMap[key];
      }
    }

    // ساختن گروه جدید
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: container.name,
      color: groupColor,
      collapsed: false
    });
    _groupMap[key] = groupId;
    await _saveGroupMap();
    console.log('[TabGroup] Created group', groupId, 'for container', container.name, 'color:', groupColor);
  } catch (e) {
    console.warn('[TabGroup] addToGroup error:', e.message);
  }
}

// حذف تب از گروه
async function removeFromContainerGroup(tabId) {
  if (!chrome.tabGroups) return;
  try {
    await chrome.tabs.ungroup(tabId);
  } catch (e) {}
}

// وقتی گروه به صورت خودکار حذف می‌شود (تب‌هایش صفر شد)
function onTabGroupRemoved(groupId) {
  for (const [key, gid] of Object.entries(_groupMap)) {
    if (String(gid) === String(groupId)) {
      delete _groupMap[key];
      _saveGroupMap();
      console.log('[TabGroup] Group', groupId, 'removed (empty), cleaned map');
      break;
    }
  }
}

// بازیابی گروه‌ها هنگام شروع (service worker restart)
async function recoverTabGroups() {
  if (!chrome.tabGroups) return;
  try {
    const tabMap = tabMgr.getMap();
    for (const [tidStr, cid] of Object.entries(tabMap)) {
      const tabId = parseInt(tidStr);
      const container = await containerMgr.get(cid);
      if (!container) continue;
      try {
        await addToContainerGroup(tabId, container);
      } catch (e) {}
    }
    console.log('[TabGroup] Recovery complete');
  } catch (e) {
    console.warn('[TabGroup] Recovery error:', e.message);
  }
}

// حذف تمام تب‌ها از گروه یک container (وقتی container حذف می‌شود)
async function ungroupAllContainerTabs(containerId) {
  if (!chrome.tabGroups) return;
  try {
    const tabMap = tabMgr.getMap();
    for (const [tidStr, cid] of Object.entries(tabMap)) {
      if (cid !== containerId) continue;
      const tabId = parseInt(tidStr);
      await removeFromContainerGroup(tabId);
    }
    for (const [key] of Object.entries(_groupMap)) {
      if (key.endsWith(':' + containerId)) {
        delete _groupMap[key];
      }
    }
    await _saveGroupMap();
  } catch (e) {}
}

// ============================================================
// INIT
// ============================================================
// Restore persisted mappings on every worker load, including an idle wake-up.
const initialization = (async () => {
  await containerMgr.init();
  await tabMgr.init();
})();
const isolationRecovery = initialization.then(async () => {
  for (const [tid, cid] of Object.entries(tabMgr.getMap())) {
    const tabId = Number(tid);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { await tabMgr.remove(tabId); continue; }
    if (!tab.url || (!tab.url.startsWith('http') && tab.url !== 'about:blank')) continue;
    try { await debuggerMgr.attach(tabId, cid); }
    catch (e) { lastError = e.message; console.error('[Isolation recovery]', e); }
  }
});
isolationRecovery.catch(e => { lastError = e.message; console.error('[Isolation recovery]', e); });
const groupRecovery = initialization.then(async () => {
  await _loadGroupMap();
  await recoverTabGroups();
});
groupRecovery.catch(e => {
  lastError = 'Group recovery failed: ' + e.message;
  console.error('[TabGroup] Recovery failed:', e);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Containers v4.4] Installed:', details.reason);
  try {
    await initialization;
    await rebuildContextMenu();
    console.log('[Containers v4.4] Init OK — All bugs fixed!');
  } catch (e) {
    lastError = 'Init failed: ' + e.message;
    console.error('[Containers v4.4] Init failed:', e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await initialization;
    await rebuildContextMenu();
    console.log('[Containers v4.4] Startup OK');
  } catch (e) {
    lastError = 'Startup failed: ' + e.message;
    console.error('[Containers v4.4] Startup failed:', e);
  }
});

// ============================================================
// CONTEXT MENU
// ============================================================
async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const containers = await containerMgr.getSorted();

  chrome.contextMenus.create({ id: 'mc-parent', title: 'Multi Account Containers', contexts: ['page', 'link'] });

  chrome.contextMenus.create({ id: 'mc-newtab-parent', parentId: 'mc-parent', title: 'Open in Container...', contexts: ['page'] });
  for (const c of containers) {
    chrome.contextMenus.create({ id: 'mc-newtab-' + c.id, parentId: 'mc-newtab-parent', title: (ICON_MAP[c.icon] || '') + ' ' + c.name, contexts: ['page'] });
  }

  chrome.contextMenus.create({ id: 'mc-reopen-parent', parentId: 'mc-parent', title: 'Reopen in Container...', contexts: ['page'] });
  for (const c of containers) {
    chrome.contextMenus.create({ id: 'mc-reopen-' + c.id, parentId: 'mc-reopen-parent', title: (ICON_MAP[c.icon] || '') + ' ' + c.name, contexts: ['page'] });
  }

  chrome.contextMenus.create({ id: 'mc-link-parent', parentId: 'mc-parent', title: 'Open Link in Container...', contexts: ['link'] });
  for (const c of containers) {
    chrome.contextMenus.create({ id: 'mc-link-' + c.id, parentId: 'mc-link-parent', title: (ICON_MAP[c.icon] || '') + ' ' + c.name, contexts: ['link'] });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const all = await containerMgr.getAll();
    for (const cId of Object.keys(all)) {
      if (info.menuItemId === 'mc-newtab-' + cId && tab) {
        if (tab.url && tab.url.startsWith('http')) await openInContainer(tab.url, cId, true);
        else await openNewTabInContainer(cId);
        return;
      }
      if (info.menuItemId === 'mc-reopen-' + cId && tab) {
        await reopenTabInContainer(tab.id, cId);
        return;
      }
      if (info.menuItemId === 'mc-link-' + cId && info.linkUrl) {
        await openInContainer(info.linkUrl, cId, false);
        return;
      }
    }
  } catch (e) {
    lastError = 'ContextMenu error: ' + e.message;
    console.error('[Containers] ContextMenu error:', e);
  }
});

// ============================================================
// OMNIBOX
// ============================================================
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  try {
    const containers = await containerMgr.getSorted();
    const suggestions = containers.map(c => ({
      content: text,
      deletable: false,
      description: (ICON_MAP[c.icon] || '') + ' Open "' + text + '" in ' + c.name,
    }));
    chrome.omnibox.setDefaultSuggestion({ description: 'Open "' + text + '" in a container...' });
    suggest(suggestions);
  } catch (e) {}
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  try {
    if (!text.trim()) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
    let url = text.trim();
    let containerId = null;
    if (text.includes('|')) {
      const parts = text.split('|').map(s => s.trim());
      url = parts[0];
      const name = parts[1].toLowerCase();
      const all = await containerMgr.getAll();
      for (const [id, c] of Object.entries(all)) {
        if (c.name.toLowerCase() === name) { containerId = id; break; }
      }
    }
    if (!containerId) { const s = await containerMgr.getSorted(); if (s.length) containerId = s[0].id; }
    if (!containerId) return;
    if (!url.match(/^https?:\/\//)) url = 'https://' + url;
    await openInContainer(url, containerId, disposition === 'currentTab');
  } catch (e) {
    lastError = 'Omnibox error: ' + e.message;
  }
});

// ============================================================
// MESSAGE HANDLER
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    lastError = err.message;
    console.error('[Containers] Error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  await initialization;
  switch (message.action) {
    case 'prepareChildTab':
      return await prepareChildTab(message, sender);
    case 'ping':
      return { pong: true, version: '4.4.0', containersCount: Object.keys(await containerMgr.getAll()).length };

    case 'getLastError':
      return { error: lastError };

    case 'clearError':
      lastError = null;
      return { success: true };

    case 'getContainers':
      return await containerMgr.getSorted();

    case 'createContainer': {
      const created = await containerMgr.create(message.data);
      await rebuildContextMenu();
      return created;
    }

    case 'updateContainer': {
      const updated = await containerMgr.update(message.containerId, message.updates);

      // بروزرسانی رنگ/نام گروه اگر تغییر کرد
      if (message.updates.color || message.updates.name) {
        await updateContainerGroupAppearance(message.containerId, updated);
      }
      await rebuildContextMenu();
      return updated;
    }

    case 'deleteContainer': {
      await ungroupAllContainerTabs(message.containerId);
      for (const [tid, cid] of Object.entries(tabMgr.getMap())) {
        if (cid !== message.containerId) continue;
        const tabId = Number(tid);
        await debuggerMgr.detach(tabId);
        await tabMgr.remove(tabId);
        updateBadge(tabId, null);
      }
      await containerMgr.delete(message.containerId);
      const stored = await chrome.storage.local.get(STORAGE_KEYS.ALWAYS_OPEN);
      const rules = Object.fromEntries(Object.entries(stored[STORAGE_KEYS.ALWAYS_OPEN] || {}).filter(([, cid]) => cid !== message.containerId));
      await chrome.storage.local.set({ [STORAGE_KEYS.ALWAYS_OPEN]: rules });
      await rebuildContextMenu();
      return { success: true };
    }

    case 'openInContainer':
      return await openInContainer(message.url, message.containerId, message.active !== false);

    case 'openNewTabInContainer':
      return await openNewTabInContainer(message.containerId, message.url);

    case 'reopenInContainer': {
      if (!message.tabId) return { error: 'No tabId' };
      return await reopenTabInContainer(message.tabId, message.containerId);
    }

    case 'getTabContainer':
      return tabMgr.getContainer(message.tabId) || tabMgr.getContainer(sender.tab?.id);

    case 'unassignTab': {
      const tId = message.tabId || sender.tab?.id;
      if (!tId) return { error: 'No tab' };
      await removeFromContainerGroup(tId);
      await tabMgr.remove(tId);
      updateBadge(tId, null);
      await debuggerMgr.detach(tId);
      return { success: true };
    }

    case 'getAlwaysOpen': {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.ALWAYS_OPEN);
      return stored[STORAGE_KEYS.ALWAYS_OPEN] || {};
    }
    case 'setAlwaysOpen': {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.ALWAYS_OPEN);
      const ao = { ...(stored[STORAGE_KEYS.ALWAYS_OPEN] || {}), [message.domain]: message.containerId };
      await chrome.storage.local.set({ [STORAGE_KEYS.ALWAYS_OPEN]: ao });
      return { success: true };
    }
    case 'removeAlwaysOpen': {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.ALWAYS_OPEN);
      const ao = stored[STORAGE_KEYS.ALWAYS_OPEN] || {};
      delete ao[message.domain];
      await chrome.storage.local.set({ [STORAGE_KEYS.ALWAYS_OPEN]: ao });
      return { success: true };
    }

    case 'getCookieString': {
      const cid = sender.tab ? tabMgr.getContainer(sender.tab.id) : message.containerId;
      return { cookieString: cid ? await cookieMgr.getCookieString(cid, sender.url || message.url, false) : '' };
    }

    case 'captureCookies': {
      const cid = sender.tab ? tabMgr.getContainer(sender.tab.id) : message.containerId;
      if (cid && (sender.url || message.url)) {
        await cookieMgr.captureSetCookie(cid, sender.url || message.url, message.rawCookie);
        await debuggerMgr.refreshContainer(cid);
      }
      return { success: true };
    }

    case 'sortTabsByContainer': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const groups = {};
      for (const t of tabs) {
        const cid = tabMgr.getContainer(t.id) || '__none__';
        if (!groups[cid]) groups[cid] = [];
        groups[cid].push(t);
      }
      const ctrs = await containerMgr.getSorted();
      const sortedTabs = [];
      for (const c of ctrs) { if (groups[c.id]) sortedTabs.push(...groups[c.id]); }
      if (groups['__none__']) sortedTabs.push(...groups['__none__']);
      for (let i = 0; i < sortedTabs.length; i++) {
        await chrome.tabs.move(sortedTabs[i].id, { index: i });
      }
      return { success: true, sortedCount: sortedTabs.length };
    }

    default:
      return { error: 'Unknown action: ' + (message.action || 'null') };
  }
}

// ============================================================
// بروزرسانی ظاهر گروه container (رنگ/نام)
// ============================================================
async function updateContainerGroupAppearance(containerId, container) {
  if (!chrome.tabGroups) return;
  try {
    const groupColor = _toGroupColor(container.color);
    for (const [key, gid] of Object.entries(_groupMap)) {
      if (key.endsWith(':' + containerId)) {
        try {
          await chrome.tabGroups.update(gid, {
            title: container.name,
            color: groupColor
          });
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// ============================================================
// CORE: Open URL in Container
// ============================================================
async function openInContainer(url, containerId, active = true) {
  await initialization;
  const container = await containerMgr.get(containerId);
  if (!container) throw new Error('Container not found: ' + containerId);
  console.log('[v4.4] Opening', url, 'in', container.name);

  // Create the tab
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only HTTP(S) URLs can open in a container');
  const tab = await chrome.tabs.create({ url: 'about:blank', active });

  // Assign tab to container
  await tabMgr.assign(tab.id, containerId);

  // Badge فقط وقتی showTabColor خاموش است
  updateBadge(tab.id, container);

  // Install isolation before the first website request. Grouping is presentation only.
  await debuggerMgr.attach(tab.id, containerId);
  await chrome.tabs.update(tab.id, { url: target.href });
  addToContainerGroup(tab.id, container).catch(e => console.warn('[TabGroup]', e.message));

  lastActiveContainer = containerId;
  return { tabId: tab.id, containerId, containerName: container.name };
}

// Page-created windows remain blank until their opener's isolation is ready.
async function prepareChildTab(message, sender) {
  const containerId = sender.tab && tabMgr.getContainer(sender.tab.id);
  if (!containerId) throw new Error('The opener has no container');
  if (!/^about:blank#mc-child-[a-f0-9]{32}$/.test(message.marker || '')) throw new Error('Invalid child marker');
  const url = new URL(message.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported child URL');
  let child;
  for (let attempt = 0; attempt < 40; attempt++) {
    const tabs = await chrome.tabs.query({});
    child = tabs.find(tab => (tab.pendingUrl || tab.url) === message.marker);
    if (child) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!child) throw new Error('The child window was blocked or closed');
  const previous = tabMgr.getContainer(child.id);
  if (previous && previous !== containerId) throw new Error('Cannot reuse a different container window');
  // Chrome's debugger permission check accepts plain about:blank, but rejects
  // an opener-created about:blank URL with a fragment on some Chrome versions.
  await chrome.tabs.update(child.id, { url: 'about:blank' });
  for (let attempt = 0; attempt < 40; attempt++) {
    const tab = await chrome.tabs.get(child.id);
    if (tab.url === 'about:blank' && tab.status === 'complete') break;
    if (attempt === 39) throw new Error('Child blank page did not finish loading');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await tabMgr.assign(child.id, containerId);
  await debuggerMgr.attach(child.id, containerId);
  const container = await containerMgr.get(containerId);
  updateBadge(child.id, container);
  await chrome.tabs.update(child.id, { url: url.href });
  addToContainerGroup(child.id, container).catch(e => console.warn('[TabGroup]', e.message));
  return { tabId: child.id, containerId };
}

// ============================================================
// CORE: Open new tab in Container
// ============================================================
async function openNewTabInContainer(containerId, url) {
  await initialization;
  if (url && url.startsWith('http')) {
    return await openInContainer(url, containerId, true);
  }
  const container = await containerMgr.get(containerId);
  if (!container) throw new Error('Container not found');
  const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await tabMgr.assign(newTab.id, containerId);
  updateBadge(newTab.id, container);
  await debuggerMgr.attach(newTab.id, containerId);
  addToContainerGroup(newTab.id, container).catch(e => console.warn('[TabGroup]', e.message));
  lastActiveContainer = containerId;
  return { tabId: newTab.id, containerId, containerName: container.name };
}

// ============================================================
// CORE: Reopen tab in different container
// ============================================================
async function reopenTabInContainer(tabId, containerId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url === 'about:blank') {
    return { error: 'Cannot reopen this tab' };
  }
  await debuggerMgr.detach(tabId);
  await chrome.tabs.remove(tabId);
  return await openInContainer(tab.url, containerId, true);
}

// ============================================================
// TAB LIFECYCLE
// ============================================================
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await initialization;
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url === 'about:blank') return;

    const cid = tabMgr.getContainer(tabId);
    if (!cid) return;

    const container = await containerMgr.get(cid);
    if (!container) return;

    lastActiveContainer = cid;

    // Make sure debugger is attached
    if (!debuggerMgr.isAttached(tabId)) {
      console.log('[v4.4] Re-attaching debugger to tab', tabId);
      await debuggerMgr.attach(tabId, cid);
    }
  } catch (e) {
    console.error('[v4.4] Tab activated error:', e);
  }
});

// When tab URL changes
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await initialization;
  if (!changeInfo.url) return;

  if (_reloadingTabs.has(tabId)) {
    _reloadingTabs.delete(tabId);
    return;
  }

  const cid = tabMgr.getContainer(tabId);
  if (!cid) return;

  const c = await containerMgr.get(cid);
  if (c) updateBadge(tabId, c);

  if (changeInfo.url.startsWith('http')) {
    if (!debuggerMgr.isAttached(tabId)) {
      await debuggerMgr.attach(tabId, cid);
    }
  }
});

// When tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initialization;
  const cid = tabMgr.getContainer(tabId);
  await debuggerMgr.detach(tabId);
  await tabMgr.remove(tabId);
});

// Keep the same per-window grouping when a container tab moves to another window.
chrome.tabs.onAttached.addListener(async (tabId) => {
  await groupRecovery;
  const container = await containerMgr.get(tabMgr.getContainer(tabId));
  if (container) await addToContainerGroup(tabId, container);
});

// When tab group is auto-removed
if (chrome.tabGroups) {
  try {
    chrome.tabGroups.onRemoved.addListener((group) => {
      onTabGroupRemoved(group.id);
    });
  } catch (e) {}
}

// ============================================================
// BADGE — فقط وقتی showTabColor خاموش باشد
// ============================================================
const toolbarIconRequests = new Map();
let toolbarBaseIcon;
async function updateToolbarIcon(tabId, color) {
  if (!chrome.action.setIcon) return;
  const request = {};
  toolbarIconRequests.set(tabId, request);
  try {
    if (!color) {
      await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
      return;
    }
    if (!toolbarBaseIcon) {
      toolbarBaseIcon = fetch(chrome.runtime.getURL('icons/icon128.png'))
        .then(response => response.blob()).then(blob => createImageBitmap(blob));
    }
    const base = await toolbarBaseIcon;
    const imageData = {};
    for (const size of [16, 32]) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext('2d');
      context.drawImage(base, 0, 0, size, size);
      context.beginPath();
      context.arc(size * 0.79, size * 0.79, size * 0.16, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.strokeStyle = '#fff';
      context.lineWidth = size / 16;
      context.stroke();
      imageData[size] = context.getImageData(0, 0, size, size);
    }
    if (toolbarIconRequests.get(tabId) === request) await chrome.action.setIcon({ tabId, imageData });
  } catch (error) {
    console.warn('[Toolbar icon]', error.message);
  } finally {
    if (toolbarIconRequests.get(tabId) === request) toolbarIconRequests.delete(tabId);
  }
}

function updateBadge(tabId, container) {
  // A native text badge has a fixed font and background size. Draw a small
  // container-colored dot into the toolbar icon instead.
  chrome.action.setBadgeText({ text: '', tabId });
  updateToolbarIcon(tabId, container && !container.showTabColor ? container.color || '#7c7c7d' : null);
  if (container) {
    chrome.action.setTitle({ title: container.name + ' Container', tabId });
  } else {
    chrome.action.setTitle({ title: 'Multi Account Containers', tabId });
  }
}

// ============================================================
// AUTO-SAVE (فقط تب‌های بدون debugger)
// ============================================================
chrome.alarms.create('auto-save', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'auto-save') return;
  await initialization;
  for (const [tidStr, cid] of Object.entries(tabMgr.getMap())) {
    try {
      const tabId = parseInt(tidStr);
      if (debuggerMgr.isAttached(tabId)) continue;
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && !tab.url.startsWith('chrome://') && tab.status === 'complete') {
        await debuggerMgr.attach(tabId, cid);
      }
    } catch (e) { lastError = e.message; }
  }
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[v4.4] Debugger detached from tab', source.tabId, 'reason:', reason);
  debuggerMgr._attachedTabs.delete(source.tabId);
});

// ============================================================
// CDP EVENT HANDLER — Cookie injection + Set-Cookie capture
// ============================================================
const responseHeaderQueues = new Map();
function responseHeaderKey(tabId, requestId) { return tabId + ':' + requestId; }
function receiveResponseHeaders(tabId, params) {
  const key = responseHeaderKey(tabId, params.requestId);
  const pending = responseHeaderQueues.get(key);
  if (pending?.resolve) { responseHeaderQueues.delete(key); pending.resolve(params.headers); }
  else {
    const headers = pending || [];
    headers.push(params.headers);
    responseHeaderQueues.set(key, headers);
  }
}
async function takeResponseHeaders(tabId, networkId) {
  const key = responseHeaderKey(tabId, networkId);
  const queued = responseHeaderQueues.get(key);
  if (Array.isArray(queued) && queued.length) {
    const headers = queued.shift();
    if (!queued.length) responseHeaderQueues.delete(key);
    return headers;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      responseHeaderQueues.delete(key);
      reject(new Error('Full response headers unavailable'));
    }, 5000);
    responseHeaderQueues.set(key, { resolve: headers => { clearTimeout(timer); resolve(headers); } });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Network.responseReceivedExtraInfo' && source.tabId) {
    receiveResponseHeaders(source.tabId, params);
    return;
  }
  if (method !== 'Fetch.requestPaused' || !source.tabId) return;
  return handlePausedRequest(source.tabId, params).catch(async error => {
    lastError = 'Isolation request failed: ' + error.message;
    console.error('[Isolation]', error);
    // Never retry with the browser's shared Cookie header.
    try {
      await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.failRequest', {
        requestId: params.requestId, errorReason: 'BlockedByClient'
      });
    } catch {}
  });
});


async function handlePausedRequest(tabId, params) {
  await initialization;
  const containerId = tabMgr.getContainer(tabId);
  const target = { tabId };
  if (!containerId) {
    // An unassigned tab may still deliver a pending event during detach.
    await chrome.debugger.sendCommand(target, 'Fetch.failRequest', {
      requestId: params.requestId, errorReason: 'BlockedByClient'
    });
    return;
  }
  if (params.responseStatusCode !== undefined) {
    const headers = params.responseHeaders || [];
    const complete = params.networkId ? await takeResponseHeaders(tabId, params.networkId) : null;
    const cookies = complete
      ? Object.entries(complete).filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value)
      : headers.filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
    if (cookies.length) {
      await cookieMgr.captureResponseSetCookie(containerId, params.request.url, cookies, !!complete);
      await chrome.debugger.sendCommand(target, 'Fetch.continueResponse', {
        requestId: params.requestId,
        responseCode: params.responseStatusCode,
        responseHeaders: headers.filter(h => h.name.toLowerCase() !== 'set-cookie')
      });
      await debuggerMgr.refreshContainer(containerId);
    } else {
      await chrome.debugger.sendCommand(target, 'Fetch.continueResponse', { requestId: params.requestId });
    }
    return;
  }
  const original = params.request.headers || {};
  const headers = (Array.isArray(original) ? original : Object.entries(original).map(([name, value]) => ({ name, value: String(value) })))
    .filter(h => h.name.toLowerCase() !== 'cookie');
  // An explicit empty Cookie header is intentional for a fresh container.
  headers.push({ name: 'Cookie', value: await cookieMgr.getCookieString(containerId, params.request.url) });
  await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: params.requestId, headers });
}

console.log('[Containers] Service Worker loaded');
