import { STORAGE_KEYS, cookieMatchesUrl } from './constants.js';

class DebuggerManager {
  constructor() {
    // Per-tab isolation state; Cookie headers are calculated for each request URL.
    this._attachedTabs = new Map();
    this._attaching = new Map();
    this._isolatorSource = null;
  }

  isAttached(tabId) {
    return this._attachedTabs.has(tabId);
  }

  // ============================================================
  // Attach debugger to a tab and set up request interception
  // ============================================================
  async attach(tabId, containerId) {
    if (this._attaching.has(tabId)) return this._attaching.get(tabId);
    const pending = this._attach(tabId, containerId);
    this._attaching.set(tabId, pending);
    try { return await pending; } finally { this._attaching.delete(tabId); }
  }

  async _attach(tabId, containerId) {
    if (this._attachedTabs.has(tabId)) {
      const info = this._attachedTabs.get(tabId);
      if (info.containerId !== containerId) throw new Error('Reopen the tab to change its container');
      return;
    }

    try {
      // Step 1: Attach debugger
      try { await chrome.debugger.attach({ tabId }, '1.3'); }
      catch (attachError) {
        // A worker wake-up can retain this extension's existing debugger session.
        try { await chrome.debugger.sendCommand({ tabId }, 'Network.enable'); }
        catch { throw attachError; }
      }
      console.log('[Debugger v4.1] Attached to tab', tabId, 'for container', containerId);

      // Register the full storage isolator with a per-tab identity before navigation.
      // A domain cookie cannot identify two different containers on the same site.
      this._attachedTabs.set(tabId, { containerId });
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await this._registerIsolator(tabId, containerId);
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Network.setBypassServiceWorker', { bypass: true });
      await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });

      // Intercept requests and capture each response before the document proceeds.
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [
          { urlPattern: 'http*', requestStage: 'Request' },
          { urlPattern: 'http*', requestStage: 'Response' }
        ]
      });
    } catch (e) {
      this._attachedTabs.delete(tabId);
      try { await chrome.debugger.detach({ tabId }); } catch {}
      console.error('[Debugger v4.1] Failed to attach to tab', tabId, ':', e.message);
      throw new Error('Container isolation could not start: ' + e.message);
    }
  }

  async _registerIsolator(tabId, containerId) {
    if (!this._isolatorSource) {
      this._isolatorSource = fetch(chrome.runtime.getURL('content/storage-isolator.js')).then(response => {
        if (!response.ok) throw new Error('Cannot load storage isolator');
        return response.text();
      });
    }
    const key = STORAGE_KEYS.CONTAINER_COOKIES + containerId;
    const scriptKey = 'mc_isolator_script_' + tabId;
    const stored = await chrome.storage.local.get([key, scriptKey]);
    const cookies = Object.values(stored[key] || {}).flat().filter(c => !c.httpOnly && c.name !== '__mc_container__');
    const source = 'globalThis.__mcContainerId = ' + JSON.stringify(containerId) + ';\n' +
      'globalThis.__mcCookieMatchesUrl = (' + cookieMatchesUrl.toString() + ');\n' +
      'globalThis.__mcInitialCookies = ' + JSON.stringify(cookies) + ';\n' + await this._isolatorSource;
    const info = this._attachedTabs.get(tabId);
    const previous = info.scriptId || stored[scriptKey];
    if (previous) {
      try { await chrome.debugger.sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: previous }); } catch {}
    }
    const script = await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source });
    info.scriptId = script.identifier;
    await chrome.storage.local.set({ [scriptKey]: script.identifier });
  }

  async refreshContainer(containerId) {
    for (const [tabId, info] of this._attachedTabs) {
      if (info.containerId === containerId) await this._registerIsolator(tabId, containerId);
    }
  }

  // ============================================================
  // Detach debugger from a tab
  // ============================================================
  async detach(tabId) {
    if (!this._attachedTabs.has(tabId)) return;

    try {
      const info = this._attachedTabs.get(tabId);
      if (info.scriptId) {
        await chrome.debugger.sendCommand({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: info.scriptId });
      }
      try { await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable'); } catch {}
      try { await chrome.debugger.sendCommand({ tabId }, 'Network.disable'); } catch {}
      await chrome.debugger.detach({ tabId });
    } catch (e) {}

    this._attachedTabs.delete(tabId);
    await chrome.storage.local.remove('mc_isolator_script_' + tabId);
    console.log('[Debugger v4.1] Detached from tab', tabId);
  }

}

export default DebuggerManager;
