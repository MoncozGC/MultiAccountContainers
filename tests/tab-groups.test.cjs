const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers/chrome-worker.cjs');

const work = { id: 'work', name: 'Work', color: '#fb9349', showTabColor: false };

test('legacy containers automatically group concurrent new tabs into one named group', async () => {
  const { context, tabs, groups, flushGroups } = await loadWorker({ containers: { work } });
  await Promise.all([
    context.openNewTabInContainer('work'),
    context.openNewTabInContainer('work'),
  ]);
  await flushGroups();
  assert.equal(groups.size, 1);
  assert.equal(new Set([...tabs.values()].map(t => t.groupId)).size, 1);
  assert.equal([...groups.values()][0].title, 'Work');
  assert.equal([...groups.values()][0].color, 'orange');
});

test('worker wake-up repairs membership and titles while preserving collapsed groups', async () => {
  const { tabs, groups } = await loadWorker({
    containers: { work }, tab_container_map: { 1: 'work', 2: 'work' }, mc_group_map: { '1:work': 9 },
  }, [
    { id: 1, windowId: 1, groupId: 9, url: 'https://example.com' },
    { id: 2, windowId: 1, groupId: -1, url: 'about:blank' },
  ], [{ id: 9, windowId: 1, title: '', color: 'blue', collapsed: true }]);
  assert.equal(groups.size, 1);
  assert.equal(tabs.get(2).groupId, 9);
  assert.equal(groups.get(9).title, 'Work');
  assert.equal(groups.get(9).color, 'orange');
  assert.equal(groups.get(9).collapsed, true);
});

test('name and color edits update all window groups; legacy false cannot disable grouping', async () => {
  const { context, groups, tabs } = await loadWorker({
    containers: { work }, tab_container_map: { 1: 'work', 2: 'work' },
  }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }]);
  assert.equal(groups.size, 2);
  assert.notEqual(tabs.get(1).groupId, tabs.get(2).groupId);
  await context.handleMessage({ action: 'updateContainer', containerId: 'work',
    updates: { name: 'Office', color: '#a87bda', showTabColor: false } }, {});
  for (const group of groups.values()) {
    assert.equal(group.title, 'Office');
    assert.equal(group.color, 'purple');
  }
  assert.notEqual(tabs.get(1).groupId, -1);
});

test('moving a tab to another window joins the destination container group', async () => {
  const { chrome, tabs } = await loadWorker({
    containers: { work }, tab_container_map: { 1: 'work', 2: 'work' },
  }, [{ id: 1, windowId: 1 }, { id: 2, windowId: 2 }]);
  tabs.get(1).windowId = 2;
  await chrome.tabs.onAttached.listeners[0](1, { newWindowId: 2 });
  assert.equal(tabs.get(1).groupId, tabs.get(2).groupId);
});

test('stale group references are replaced and removed group objects clean up mappings', async () => {
  const { context, chrome, data, groups } = await loadWorker({
    containers: { work }, tab_container_map: { 1: 'work' }, mc_group_map: { '1:work': 99 },
  }, [{ id: 1, windowId: 1 }]);
  assert.equal(groups.size, 1);
  const id = data.mc_group_map['1:work'];
  assert.notEqual(id, 99);
  groups.delete(id);
  chrome.tabGroups.onRemoved.listeners[0]({ id, windowId: 1 });
  assert.equal(data.mc_group_map['1:work'], undefined);
  await context.addToContainerGroup(1, work);
  assert.equal(groups.size, 1);
});
