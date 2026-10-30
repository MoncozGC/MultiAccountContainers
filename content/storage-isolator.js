// ============================================================
// content/storage-isolator.js — v4.1 (MAIN world, document_start)
// ============================================================
// این اسکریپت در context صفحه (MAIN world) اجرا می‌شود و:
//   1. localStorage را ایزوله می‌کند (prefix per container)
//   2. IndexedDB را ایزوله می‌کند (prefix database names)
//   3. CacheStorage را ایزوله می‌کند
//   4. Service Worker ثبت را مسدود می‌کند (!)
//   5. document.cookie را بازنویسی می‌کند
//
// ⚠️ v4.1 تغییر:
//   fetch/XHR interception حذف شد! چون:
//   - response.headers.get('set-cookie') یک "forbidden header" است
//     و مرورگر خطای "Refused to get unsafe header" می‌دهد
//   - در v4.1 Set-Cookie از طریق CDP Network events گرفته می‌شود
//     که بالاتر از Fetch API است و این محدودیت را ندارد
// ============================================================

(function() {
  'use strict';
  if (!location.protocol.startsWith('http')) return;

  // ============================================================
  // STEP 1: خواندن container ID از cookie
  // ============================================================
  const containerId = globalThis.__mcContainerId;
  if (!containerId || globalThis.__mcIsolationInstalled) return;
  globalThis.__mcIsolationInstalled = true;

  const P = '__mc_' + containerId + '__';

  // ============================================================
  // STEP 2: localStorage isolation (فوری!)
  // ============================================================
  const _origGetItem = Storage.prototype.getItem;
  const _origSetItem = Storage.prototype.setItem;
  const _origRemoveItem = Storage.prototype.removeItem;
  const _origClear = Storage.prototype.clear;
  const _origKey = Storage.prototype.key;
  const _origLengthDesc = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');

  function _realKeys(storage) {
    const keys = [];
    const len = _origLengthDesc.get.call(storage);
    for (let i = 0; i < len; i++) {
      try { keys.push(_origKey.call(storage, i)); } catch (e) {}
    }
    return keys;
  }

  function _ourKeys(storage) {
    return _realKeys(storage).filter(function(k) { return k.startsWith(P); });
  }

  Storage.prototype.getItem = function(key) {
    return _origGetItem.call(this, P + key);
  };
  Storage.prototype.setItem = function(key, value) {
    return _origSetItem.call(this, P + key, String(value));
  };
  Storage.prototype.removeItem = function(key) {
    return _origRemoveItem.call(this, P + key);
  };
  Storage.prototype.clear = function() {
    const ours = _ourKeys(this);
    for (let i = 0; i < ours.length; i++) {
      _origRemoveItem.call(this, ours[i]);
    }
  };
  Storage.prototype.key = function(index) {
    const ours = _ourKeys(this);
    if (index < 0 || index >= ours.length) return null;
    return ours[index].substring(P.length);
  };
  Object.defineProperty(Storage.prototype, 'length', {
    get: function() { return _ourKeys(this).length; },
    configurable: true
  });

  // Storage also supports property access (storage.token), which bypasses getItem.
  for (const property of ['localStorage', 'sessionStorage']) {
    const storage = window[property];
    const proxy = new Proxy(storage, {
      get(target, key) {
        if (typeof key !== 'string' || key in Storage.prototype) {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const value = _origGetItem.call(target, P + key);
        return value === null ? undefined : value;
      },
      set(target, key, value) { _origSetItem.call(target, P + String(key), String(value)); return true; },
      deleteProperty(target, key) { _origRemoveItem.call(target, P + String(key)); return true; },
      ownKeys(target) { return _ourKeys(target).map(key => key.substring(P.length)); },
      has(target, key) { return key in Storage.prototype || _origGetItem.call(target, P + String(key)) !== null; },
      getOwnPropertyDescriptor(target, key) {
        const value = _origGetItem.call(target, P + String(key));
        return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(target, key, descriptor) {
        if (!('value' in descriptor)) return false;
        _origSetItem.call(target, P + String(key), String(descriptor.value));
        return true;
      },
    });
    Object.defineProperty(window, property, { get: () => proxy, configurable: true });
  }

  // ============================================================
  // STEP 3: IndexedDB isolation (فوری!)
  // ============================================================
  const _origIDBOpen = IDBFactory.prototype.open;
  const _origIDBDelete = IDBFactory.prototype.deleteDatabase;
  const _origIDBDatabases = IDBFactory.prototype.databases;

  IDBFactory.prototype.open = function(name, version) {
    return _origIDBOpen.call(this, P + name, version);
  };
  IDBFactory.prototype.deleteDatabase = function(name) {
    return _origIDBDelete.call(this, P + name);
  };
  if (_origIDBDatabases) {
    IDBFactory.prototype.databases = function() {
      return _origIDBDatabases.call(this).then(function(dbs) {
        return dbs
          .filter(function(db) { return db.name && db.name.startsWith(P); })
          .map(function(db) {
            return { name: db.name.substring(P.length), version: db.version };
          });
      });
    };
  }
  if (IDBDatabase.prototype) {
    const _origDBName = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    if (_origDBName) {
      Object.defineProperty(IDBDatabase.prototype, 'name', {
        get: function() {
          const realName = _origDBName.get.call(this);
          if (realName && realName.startsWith(P)) return realName.substring(P.length);
          return realName;
        },
        configurable: true
      });
    }
  }

  // ============================================================
  // STEP 4: CacheStorage isolation (فوری!)
  // ============================================================
  if (window.caches) {
    const _origCacheOpen = CacheStorage.prototype.open;
    const _origCacheHas = CacheStorage.prototype.has;
    const _origCacheDelete = CacheStorage.prototype.delete;
    const _origCacheKeys = CacheStorage.prototype.keys;

    CacheStorage.prototype.open = function(cacheName, options) {
      return _origCacheOpen.call(this, P + cacheName, options);
    };
    CacheStorage.prototype.has = function(cacheName, options) {
      return _origCacheHas.call(this, P + cacheName, options);
    };
    CacheStorage.prototype.delete = function(cacheName, options) {
      return _origCacheDelete.call(this, P + cacheName, options);
    };
    CacheStorage.prototype.keys = function(request, options) {
      return _origCacheKeys.call(this, request, options).then(function(names) {
        return names.filter(function(n) { return n.startsWith(P); }).map(function(n) { return n.substring(P.length); });
      });
    };
  }

  // ============================================================
  // STEP 5: Block Service Worker registration (!)
  // ============================================================
  // این بخش CRITICAL است! Service Worker واتساپ مشترک بین همه
  // تب‌هاست. با مسدود کردن آن، هر تب مستقل می‌شود.
  // ============================================================
  if (navigator.serviceWorker) {
    // Fake registration object
    const _fakeRegistration = {
      active: null,
      installing: null,
      waiting: null,
      scope: '/',
      unregister: function() { return Promise.resolve(false); },
      update: function() { return Promise.resolve(); },
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return false; }
    };

    // Block register()
    navigator.serviceWorker.register = function() {
      console.log('[MC v4.1] Service Worker registration BLOCKED for container:', containerId);
      return Promise.resolve(_fakeRegistration);
    };

    // Block getRegistrations()
    navigator.serviceWorker.getRegistrations = function() {
      return Promise.resolve([]);
    };

    // Block getRegistration()
    navigator.serviceWorker.getRegistration = function() {
      return Promise.resolve(undefined);
    };

    // Override 'ready' to resolve immediately
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      get: function() {
        return Promise.resolve(_fakeRegistration);
      },
      configurable: true
    });

    // Override 'controller' to return null
    Object.defineProperty(navigator.serviceWorker, 'controller', {
      get: function() { return null; },
      configurable: true
    });
  }

  // ============================================================
  // STEP 6: document.cookie override
  // ============================================================
  // صفحه از طریق document.cookie هم کوکی‌ها را می‌خواند.
  // ما آن را بازنویسی می‌کنیم تا فقط کوکی‌های container را ببیند.
  // ============================================================
  let _ourCookieString = (globalThis.__mcInitialCookies || [])
    .filter(c => globalThis.__mcCookieMatchesUrl(c, location.href))
    .map(c => c.name + '=' + c.value).join('; ');
  delete globalThis.__mcInitialCookies;
  delete globalThis.__mcCookieMatchesUrl;

  // Get the original property descriptor
  const _docCookieProto = Document.prototype;
  let _origDocCookieDesc = null;
  try {
    _origDocCookieDesc = Object.getOwnPropertyDescriptor(_docCookieProto, 'cookie');
  } catch (e) {}

  // Set our cookie string when received from background
  window.addEventListener('message', function(e) {
    if (e.source === window && e.data && e.data.type === 'mc-cookie-response' && e.data.containerId === containerId) {
      _ourCookieString = e.data.cookieString || '';
    }
  });

  if (_origDocCookieDesc) {
    Object.defineProperty(_docCookieProto, 'cookie', {
      get: function() {
        return _ourCookieString;
      },
      set: function(value) {
        // When WhatsApp sets a cookie, pass it to the bridge
        if (value) {
          window.dispatchEvent(new CustomEvent('mc-set-cookie', {
            detail: { raw: value, containerId: containerId }
          }));
        }
        // Keep synchronous reads local to this document; never write the shared jar.
        const pair = String(value).split(';')[0];
        const equals = pair.indexOf('=');
        if (equals > 0) {
          const name = pair.slice(0, equals).trim();
          const parts = _ourCookieString ? _ourCookieString.split('; ').filter(p => p.split('=')[0] !== name) : [];
          const deleted = /;\s*max-age\s*=\s*(?:0|-\d+)(?:;|$)/i.test(String(value));
          if (!deleted) parts.push(pair.trim());
          _ourCookieString = parts.join('; ');
        }
        return value;
      },
      configurable: true
    });
  }

  // ============================================================
  // STEP 7: Request cookies from background
  // ============================================================
  // پس از document_start، کوکی‌های container را از background می‌گیریم
  // و به cookie-bridge می‌فرستیم تا به document.cookie اضافه شود
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', requestCookies);
  } else {
    requestCookies();
  }

  function requestCookies() {
    window.postMessage({
      type: 'mc-get-cookies',
      containerId: containerId,
      url: location.href
    }, '*');
  }

  // Also request cookies when URL changes (SPA navigation)
  let _lastUrl = location.href;
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;

  history.pushState = function() {
    _origPushState.apply(this, arguments);
    setTimeout(function() {
      if (location.href !== _lastUrl) {
        _lastUrl = location.href;
        requestCookies();
      }
    }, 100);
  };

  history.replaceState = function() {
    _origReplaceState.apply(this, arguments);
    setTimeout(function() {
      if (location.href !== _lastUrl) {
        _lastUrl = location.href;
        requestCookies();
      }
    }, 100);
  };

  // A new page must receive its container before its first request or script.
  // Keep the native WindowProxy, but defer HTTP(S) navigation through the bridge.
  const nativeOpen = window.open;
  window.open = function(url, target, features) {
    const name = target == null || target === '' ? '_blank' : String(target);
    if (['_self', '_parent', '_top'].includes(name.toLowerCase()) || !url) {
      return nativeOpen.apply(window, arguments);
    }
    let destination;
    try { destination = new URL(String(url), document.baseURI); } catch { return nativeOpen.apply(window, arguments); }
    if (!['http:', 'https:'].includes(destination.protocol)) return nativeOpen.apply(window, arguments);
    // getRandomValues also works on HTTP intranet origins where randomUUID is absent.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    const marker = 'about:blank#mc-child-' + nonce;
    const child = nativeOpen.call(window, marker, name, features);
    // noopener/noreferrer deliberately returns null even when a tab is created.
    if (child || /(?:^|,)\s*(?:noopener|noreferrer)(?:\s*=\s*(?:yes|1))?\s*(?:,|$)/i.test(features || '')) {
      window.postMessage({ type: 'mc-open-child', marker, url: destination.href }, '*');
    }
    return child;
  };

  function inheritLink(event) {
    if (event.defaultPrevented || event.altKey || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!anchor || anchor.hasAttribute('download')) return;
    const target = anchor.target || document.querySelector('base[target]')?.target || '_self';
    const modified = event.ctrlKey || event.metaKey || event.button === 1;
    if (!modified && ['_self', '_parent', '_top'].includes(target.toLowerCase())) return;
    if (!/^https?:/.test(anchor.href)) return;
    event.preventDefault();
    const features = anchor.relList.contains('noreferrer') ? 'noreferrer' :
      (target.toLowerCase() === '_blank' || anchor.relList.contains('noopener') ? 'noopener' : '');
    window.open(anchor.href, modified ? '_blank' : target, features);
  }
  window.addEventListener('click', inheritLink);
  window.addEventListener('auxclick', inheritLink);

  console.log('[MC v4.1] FULLY ISOLATED for container:', containerId, '(SW blocked, storage isolated, no fetch intercept)');

})();
