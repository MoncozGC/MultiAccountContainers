const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real worker and managers against a small in-memory Chrome API.
async function loadWorker(seed = {}, initialTabs = [], initialGroups = [], options = {}) {
  const data = structuredClone(seed);
  const commands = [];
  const tabs = new Map(initialTabs.map(t => [t.id, { ...t }]));
  const groups = new Map(initialGroups.map(g => [g.id, { ...g }]));
  let nextTab = 100, nextGroup = 100;
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const chrome = {
    storage: { local: {
      async get(keys) {
        const selected = typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(selected.map(k => [k, data[k]])));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(key) { delete data[key]; },
    } },
    runtime: { getURL: p => p, onInstalled: event(), onStartup: event(), onMessage: event() },
    contextMenus: { onClicked: event(), async removeAll() {}, create() {} },
    omnibox: { onInputChanged: event(), onInputEntered: event() },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(), onAttached: event(),
      async query() { return [...tabs.values()].map(tab => ({ ...tab })); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('Tab not found');
        return { ...tabs.get(id) };
      },
      async update(id, changes) {
        commands.push({ method: 'tabs.update', tabId: id, params: changes });
        Object.assign(tabs.get(id), changes);
        return { ...tabs.get(id) };
      },
      async remove(id) { tabs.delete(id); },
      async create(options) {
        const tab = { id: nextTab++, windowId: 1, groupId: -1, ...options };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async group({ tabIds, groupId }) {
        if (options.group) await options.group();
        const tab = tabs.get(tabIds[0]);
        if (groupId === undefined) {
          groupId = nextGroup++;
          groups.set(groupId, { id: groupId, windowId: tab.windowId });
        }
        assert.equal(groups.get(groupId).windowId, tab.windowId);
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        return groupId;
      },
      async ungroup(id) { tabs.get(id).groupId = -1; },
    },
    tabGroups: {
      onRemoved: event(),
      async query() { return [...groups.values()]; },
      async get(id) {
        if (!groups.has(id)) throw new Error('Group not found');
        return { ...groups.get(id) };
      },
      async update(id, changes) { Object.assign(groups.get(id), changes); },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    cookies: { async set() {}, async remove() {} },
    alarms: { create() {}, onAlarm: event() },
    debugger: { onEvent: event(), onDetach: event(), async attach({ tabId }) {
      commands.push({ method: 'debugger.attach', tabId });
      if (options.attachError) throw new Error(options.attachError);
    }, async detach() {}, async sendCommand(target, method, params) {
      commands.push({ method, params, tabId: target.tabId });
      if (options.attachError && method === 'Network.enable') throw new Error(options.attachError);
      if (options.sendCommand) await options.sendCommand(target, method, params);
      return { identifier: 'script-' + commands.length };
    } },
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, fetch: async () => ({ ok: true, text: async () => fs.readFileSync(path.join(__dirname, '..', '..', 'content/storage-isolator.js'), 'utf8') }), console: { log() {}, warn() {}, error() {} } });
  for (const file of [
    'lib/constants.js', 'lib/container-manager.js', 'lib/cookie-manager.js',
    'lib/tab-manager.js', 'lib/debugger-manager.js', 'background/service-worker.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
      .replace(/^import .*;\r?$/gm, '')
      .replace(/^export default .*;\r?$/gm, '')
      .replace(/^export /gm, '');
    vm.runInContext(source, context, { filename: file });
  }
  await vm.runInContext(options.waitForRecovery === false ? 'initialization' : 'groupRecovery', context);
  return { context, chrome, data, tabs, groups, commands, flushGroups: () => vm.runInContext('_groupQueue', context) };
}

module.exports = { loadWorker };
