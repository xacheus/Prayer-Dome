/* ==========================================================================
   Prayer Dome — Premium App Layer (pd-app.js)
   --------------------------------------------------------------------------
   Shared functionality for every page: language selector, live location,
   moving announcements, notification center, scheduled hero banners,
   community statistics, live-stream bridge, news center, splash screen,
   drawer navigation and gospel radio.

   Plain global script. Load AFTER assets/pd-content-data.js and
   assets/pd-motion.js. Every module scans for its own targets and no-ops
   gracefully when the page does not include them.

   Pages that use Firestore register it once:
     PDApp.setFirestore({ db, doc, getDoc, setDoc, addDoc, collection,
                          query, orderBy, limit, getDocs, onSnapshot,
                          serverTimestamp, Timestamp });
   Everything else works fully offline with localStorage + BroadcastChannel.
   ========================================================================== */

(function () {
  'use strict';

  var VERSION = '1.2.0';
  var BRAND_LOGO = '/assets/logo.png'; // official Prayer Dome mark
  var channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('pd-app') : null;
  var fb = null;            // Firestore bindings, set via setFirestore()
  var listeners = [];

  /* ---------------------------------------------------------------- utils */
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* full */ }
  }
  function esc(str) {
    if (str === null || str === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
  /* Icon class for a saved icon value (Lucide name, legacy Font Awesome name
   * or emoji). Admin-edited lists live in localStorage, so values saved before
   * the Lucide migration still arrive here. See assets/pd-icons.js. */
  /* Notification titles saved before the migration may start with an emoji.
   * The panel already shows a type icon, so drop it when rendering. */
  var LEADING_EMOJI = /^(?![\u00A9\u00AE\u2122])(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0F\u200D]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier})*\s*/u;
  function plainTitle(title) {
    return String(title == null ? '' : title).replace(LEADING_EMOJI, '');
  }
  function iconCls(value, fallback) {
    if (window.PDIcons) return window.PDIcons.cls(value, fallback);
    return 'pd-i ' + (/^pd-i-[a-z0-9-]+$/.test(value || '') ? value : fallback);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function toast(message, type) {
    var container = $('#toastContainer') || $('#pdToast');
    if (!container) {
      container = document.createElement('div');
      container.id = 'pdToast';
      container.className = 'pd-toast-container';
      document.body.appendChild(container);
    }
    var t = document.createElement('div');
    t.className = 'pd-toast' + (type === 'error' ? ' pd-toast-error' : '');
    t.innerHTML = '<i class="pd-i ' + (type === 'error' ? 'pd-i-circle-alert' : 'pd-i-circle-check') + '"></i> ' + esc(message);
    container.appendChild(t);
    setTimeout(function () { t.classList.add('pd-toast-out'); setTimeout(function () { t.remove(); }, 400); }, 3400);
  }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function broadcast(type, payload) {
    if (channel) { try { channel.postMessage({ type: type, payload: payload || {} }); } catch (e) {} }
    if (fb && fb.db) {
      var evt = new CustomEvent('pd:' + type, { detail: payload || {} });
      document.dispatchEvent(evt);
    }
  }
  function on(type, fn) { listeners.push([type, fn]); document.addEventListener('pd:' + type, fn); }
  if (channel) {
    channel.onmessage = function (ev) {
      var msg = ev.data || {};
      var evt = new CustomEvent('pd:' + msg.type, { detail: msg.payload || {} });
      document.dispatchEvent(evt);
    };
  }

  /* --------------------------------------------------------- academy nav */
  /* Kept as a named module because pages and older builds reference
     PDApp.academyNav, but it is no longer its own list: the Academy
     destinations live in the one global navigation configuration
     (assets/pd-nav.js) and are rendered with every other group. Injecting a
     second, page-level set of links here was what made the menu change shape
     between Home and the Academy. */
  var academyNav = {
    links: [
      { href: '/lessons', icon: 'pd-i-graduation-cap', label: 'Teachings', match: 'lessons' },
      { href: '/stories', icon: 'pd-i-book-open-text', label: 'Bible Stories', match: 'stories' },
      { href: '/quiz', icon: 'pd-i-star', label: 'Bible Quizzes', match: 'quiz' },
      { href: '/resources', icon: 'pd-i-folder-open', label: 'Study Resources', match: 'resources' }
    ],
    init: function () {
      if (window.PDNav && typeof window.PDNav.init === 'function') {
        try { window.PDNav.init(); } catch (e) { /* the shared menu keeps its markup */ }
      }
    }
  };

  /* ------------------------------------------------------------ Firestore */
  function setFirestore(bindings) {
    if (bindings && bindings.db) {
      fb = bindings;
      // Exposed so feature modules (e.g. the Academy's profile sync) can
      // reach Firestore without each page re-wiring its own handle.
      try { window.PDApp._fb = bindings; } catch (e) {}
    }
  }
  function fsGet(docRef, fallback) {
    if (!fb || !fb.getDoc) return Promise.resolve(fallback);
    return fb.getDoc(docRef).then(function (snap) {
      return snap.exists() ? snap.data() : fallback;
    }).catch(function () { return fallback; });
  }
  function fsSet(docRef, data) {
    if (!fb || !fb.setDoc) return Promise.resolve(false);
    return fb.setDoc(docRef, data, { merge: true }).then(function () { return true; }).catch(function () { return false; });
  }
  function fsAdd(collectionRef, data) {
    if (!fb || !fb.addDoc) return Promise.resolve(null);
    return fb.addDoc(collectionRef, data).then(function (r) { return r.id; }).catch(function () { return null; });
  }
  function fsWatch(docRef, cb) {
    if (!fb || !fb.onSnapshot) return null;
    return fb.onSnapshot(docRef, function (snap) {
      cb(snap.exists() ? snap.data() : null);
    }, function () {});
  }

  /* ---------------------------------------------------------------- roles
   * One answer to "which leadership tools does this account get?" for every
   * page, so an administrator never loses the console to a flicker:
   *
   *   • the durable device session the console (pd_admin_session) and the
   *     finance portal (pd_finance_session) write is read first — a reload, a
   *     new tab or a short outage keeps the tools in place;
   *   • Firestore stays the truth: memberships/<uid> first, then users/<uid>
   *     (the two documents firestore.rules trusts), retried so a flaky
   *     connection is never mistaken for "not an administrator";
   *   • only a definite answer drops a remembered role.
   *
   *   await PDApp.roles.admin(user)   -> 'admin' | 'none' | 'unknown'
   *   await PDApp.roles.finance(user) -> 'finance' | 'admin' | 'none' | 'unknown'
   *   PDApp.roles.remembered(user)    -> 'admin' | 'finance' | null   (no I/O)
   *   PDApp.roles.watch(user, fn)     -> unsubscribe | null
   *   PDApp.roles.forget()            -> forget both remembered roles
   * Each resolution dispatches `pd:role` on document.
   * --------------------------------------------------------------- */
  var roles = (function () {
    var ADMIN_KEY = 'pd_admin_session';
    var FINANCE_KEY = 'pd_finance_session';
    var TTL = 7 * 24 * 60 * 60 * 1000; // same window the console and portal keep
    var LEADERSHIP = { admin: true, finance: true };

    function readSession(key, user) {
      var session = lsGet(key, null);
      if (!session || !session.uid || !LEADERSHIP[session.role]) return null;
      if (user && session.uid !== user.uid) return null;
      var age = Date.now() - Number(session.timestamp || 0);
      if (!isFinite(age) || age > TTL) return null;
      return session;
    }
    /* What this device already proved, without asking Firestore. A
       signed-out visitor has no role on this device, so nothing is kept. */
    function remembered(user) {
      if (!user) return null;
      var session = readSession(ADMIN_KEY, user) || readSession(FINANCE_KEY, user);
      return session ? session.role : null;
    }
    function writeSession(key, version, user, role, source, name) {
      try {
        localStorage.setItem(key, JSON.stringify({
          version: version, uid: user.uid, email: user.email || '',
          name: name || user.displayName || '', role: role, source: source || '',
          timestamp: Date.now(), verifiedAt: Date.now(), seenAt: Date.now()
        }));
      } catch (e) { /* private window or full storage */ }
    }
    function remember(user, role, source, name) {
      if (!user) return;
      if (role === 'admin') writeSession(ADMIN_KEY, 2, user, 'admin', source, name);
      if (role === 'admin' || role === 'finance') writeSession(FINANCE_KEY, 1, user, role, source, name);
    }
    function forget() {
      try { localStorage.removeItem(ADMIN_KEY); } catch (e) {}
      try { localStorage.removeItem(FINANCE_KEY); } catch (e) {}
    }
    function roleFromSnap(snap) {
      var role = snap && snap.exists() ? (snap.data() || {}).role : '';
      return LEADERSHIP[role] ? role : '';
    }
    function refFor(collectionName, uid) {
      try { return fb && fb.doc && fb.db ? fb.doc(fb.db, collectionName, uid) : null; }
      catch (e) { return null; }
    }
    /* { status: 'confirmed' | 'unknown' | 'signed-out', role, source } */
    function readRole(user, attempts) {
      if (!user) return Promise.resolve({ status: 'signed-out', role: '', source: '' });
      var membershipRef = refFor('memberships', user.uid);
      var userRef = refFor('users', user.uid);
      if (!fb || !fb.getDoc || !membershipRef || !userRef) {
        return Promise.resolve({ status: 'unknown', role: '', source: '' });
      }
      var tries = attempts || 3;
      var attempt = 0;
      function once() {
        return Promise.all([fb.getDoc(membershipRef), fb.getDoc(userRef)]).then(function (snaps) {
          var byMembership = roleFromSnap(snaps[0]);
          var byUser = roleFromSnap(snaps[1]);
          return {
            status: 'confirmed', role: byMembership || byUser,
            source: byMembership ? 'memberships' : (byUser ? 'users' : '')
          };
        }, function () {
          attempt += 1;
          if (attempt >= tries) return { status: 'unknown', role: '', source: '' };
          return new Promise(function (resolve) { setTimeout(resolve, 500 * attempt); }).then(once);
        });
      }
      return once();
    }
    function publish(user, answer, wanted) {
      var detail = {
        uid: user ? user.uid : null, role: answer.role, status: answer.status,
        admin: answer.role === 'admin',
        finance: answer.role === 'admin' || answer.role === 'finance',
        source: answer.source,
        granted: answer.role === 'admin' || answer.role === wanted
      };
      try { document.dispatchEvent(new CustomEvent('pd:role', { detail: detail })); } catch (e) {}
      return detail;
    }
    function view(wanted, user, options) {
      options = options || {};
      return readRole(user, options.attempts).then(function (answer) {
        if (answer.status === 'confirmed') {
          if (answer.role) remember(user, answer.role, answer.source, options.name);
          else forget(); // Firestore says this account has no leadership role
        }
        publish(user, answer, wanted);
        if (answer.status === 'signed-out') return 'none';
        if (answer.status !== 'confirmed') return 'unknown';
        if (answer.role === wanted) return wanted;
        if (wanted === 'finance' && answer.role === 'admin') return 'admin';
        return 'none';
      });
    }
    /* Live watch on the membership document: the page hears the moment the
       role is granted or removed. Returns null when listening is unavailable
       (the caller can re-check on focus instead). */
    function watch(user, onChange) {
      if (!user || !fb || !fb.onSnapshot) return null;
      var ref = refFor('memberships', user.uid);
      if (!ref) return null;
      try {
        return fb.onSnapshot(ref, function (snap) {
          var role = roleFromSnap(snap);
          if (role) {
            remember(user, role, 'memberships');
            publish(user, { status: 'confirmed', role: role, source: 'memberships' }, 'admin');
            if (onChange) onChange(role);
            return;
          }
          // memberships no longer grants a role — users/<uid> may still do so,
          // and one missing document must never strip the tools on its own.
          readRole(user, 1).then(function (answer) {
            if (answer.status === 'confirmed') {
              if (answer.role) remember(user, answer.role, answer.source);
              else forget();
            }
            if (onChange) onChange(answer.status === 'confirmed' ? (answer.role || 'none') : 'unknown');
          });
        }, function () { /* offline — the focus re-check covers it */ });
      } catch (e) { return null; }
    }
    return {
      admin: function (user, options) { return view('admin', user, options); },
      finance: function (user, options) { return view('finance', user, options); },
      remembered: remembered,
      watch: watch,
      forget: forget,
      keys: { admin: ADMIN_KEY, finance: FINANCE_KEY },
      ttl: TTL
    };
  })();

  /* ------------------------------------------------------------- storage */
  var store = {
    get: function (key, seedKey) {
      var val = lsGet('pd_' + key, null);
      if (val !== null) return val;
      var seed = (window.PD_CONTENT || {})[seedKey || 'DEFAULT_' + key.toUpperCase()];
      return seed !== undefined ? seed : null;
    },
    set: function (key, value) {
      lsSet('pd_' + key, value);
      broadcast('store:' + key, value);
      return value;
    },
    patch: function (key, patch) {
      var cur = store.get(key) || {};
      if (typeof cur === 'object' && !Array.isArray(cur)) {
        var next = Object.assign({}, cur, patch);
        store.set(key, next);
        return next;
      }
      store.set(key, patch);
      return patch;
    }
  };

  /* ----------------------------------------------------------- theme ui --- */

  /* ------------------------------------------------------------------ theme
   * Automatic appearance management. The OS theme (prefers-color-scheme) is
   * the single source of truth; there is no user-facing toggle. `dark-mode`
   * is derived from the media query on every page load and re-applied the
   * moment the device theme changes, so the app is always in step with the
   * phone. `PDApp.theme` is the public handle pages and tests can read.
   * ---------------------------------------------------------------------- */
  var theme = {
    media: null,
    ensure: function () {
      if (!theme.media && window.matchMedia) {
        try { theme.media = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) { theme.media = null; }
      }
      return theme.media;
    },
    scheme: function () {
      return (theme.ensure() && theme.ensure().matches) ? 'dark' : 'light';
    },
    mode: function () {
      var forced = document.documentElement.getAttribute('data-pd-theme');
      if (forced === 'dark' || forced === 'light') return forced;
      return theme.scheme();
    },
    isDark: function () { return theme.mode() === 'dark'; },
    init: function () {
      if (ui && ui.syncTheme) ui.syncTheme();
    }
  };

  /* ------------------------------------------------------------- branding
   * Prayer Dome ships its own artwork. Nothing in the app may fall back to a
   * third-party placeholder service, a stock-photo host or a stand-in logo.
   * DEFAULT_AVATAR is the branded member silhouette; BRAND_LOGO is the one
   * official mark used for icons, splash screens and every fallback.
   * ---------------------------------------------------------------------- */
  var DEFAULT_AVATAR = '/assets/avatar-default.svg';
  var PLACEHOLDER_HOSTS = /(^|\/\/)(www\.)?(via\.placeholder\.com|placehold\.it|placehold\.co|placekitten\.com|dummyimage\.com|loremflickr\.com)/i;

  /** Resolve any avatar URL to something Prayer Dome actually owns. */
  function avatarUrl(url) {
    if (!url || typeof url !== 'string') return DEFAULT_AVATAR;
    var clean = url.trim();
    if (!clean || PLACEHOLDER_HOSTS.test(clean)) return DEFAULT_AVATAR;
    return clean;
  }

  /**
   * Sweep the page for any image still pointing at a placeholder service —
   * including ones rendered later from stored member records — and swap in
   * the official Prayer Dome avatar. Runs once now, then watches for new
   * nodes so historical data never shows a grey stand-in again.
   */
  function enforceBranding(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var images = scope.querySelectorAll ? scope.querySelectorAll('img[src]') : [];
    for (var i = 0; i < images.length; i++) {
      var src = images[i].getAttribute('src') || '';
      if (PLACEHOLDER_HOSTS.test(src)) images[i].setAttribute('src', DEFAULT_AVATAR);
    }
  }

  function watchBranding() {
    enforceBranding(document);
    if (typeof MutationObserver === 'undefined') return;
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; enforceBranding(document); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  var ui = {
    init: function () {
      ui.drawer();
      ui.splash();
      ui.syncTheme();
      ui.offlineBanner();
      try { watchBranding(); } catch (e) { /* branding sweep is best-effort */ }
      // Auto-show the friendly "Allow notifications?" pop-up once per
      // device, ~6s after the app loads, so members get the OS push
      // experience they expect without hunting for a bell.
      setTimeout(function () {
        if (notifications.canPrompt && notifications.canPrompt() && !localStorage.getItem('pd_notif_pop_dismissed')) {
          notifications.showEnablePop();
        }
      }, 6000);
    },
    /* Professional offline state: never hides the app — it explains what
       still works (downloaded Bible, saved content) and disappears the
       moment connectivity returns. */
    offlineBanner: function () {
      if (document.getElementById('pdOfflineBanner')) return;
      var el = document.createElement('div');
      el.id = 'pdOfflineBanner';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%) translateY(140%);z-index:99990;'
        + 'display:flex;align-items:center;gap:10px;max-width:min(92vw,480px);padding:12px 18px;border-radius:16px;'
        + 'background:#0d1b33;color:#e6eefb;font:600 .8rem/1.45 Inter,system-ui,sans-serif;'
        + 'box-shadow:0 16px 40px rgba(0,0,0,.4);transition:transform .35s cubic-bezier(.2,.9,.3,1.1);';
      el.innerHTML = '<i class="pd-i pd-i-wifi" style="color:#4DA3FF;flex-shrink:0;"></i>'
        + '<span>You’re offline. Some features are unavailable, but your downloaded Bible and saved content are still available.</span>';
      document.body.appendChild(el);
      var show = function () {
        if (!navigator.onLine) el.style.transform = 'translateX(-50%) translateY(0)';
      };
      var hide = function () { el.style.transform = 'translateX(-50%) translateY(140%)'; };
      window.addEventListener('offline', show);
      window.addEventListener('online', hide);
      show();
    },

    drawer: function () {
      /* The drawer is owned by assets/pd-nav.js: one config, one set of
         handlers (click, Escape, focus trap, scroll lock, safe areas). This
         method stays for pages that call PDApp.ui.drawer() directly and for
         builds that ship without pd-nav.js, where the old behaviour is the
         fallback rather than a competing second handler. */
      if (window.PDNav && typeof window.PDNav.init === 'function') {
        window.PDNav.init();
        return;
      }
      var btn = $('#pdMenuBtn');
      var drawer = $('#pdDrawer');
      var overlay = $('#pdDrawerOverlay');
      if (!btn || !drawer) return;
      var toggle = function (open) {
        drawer.classList.toggle('open', open);
        if (overlay) overlay.classList.toggle('open', open);
        document.body.style.overflow = open ? 'hidden' : '';
      };
      btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(!drawer.classList.contains('open')); });
      if (overlay) overlay.addEventListener('click', function () { toggle(false); });
      $$('.pd-drawer-close', drawer).forEach(function (el) {
        el.addEventListener('click', function () { toggle(false); });
      });
      $$('a', drawer).forEach(function (a) {
        a.addEventListener('click', function () { toggle(false); });
      });
    },
    splash: function () {
      var splash = $('#pdSplash');
      if (!splash) return;
      if (sessionStorage.getItem('pd_splash_seen')) { splash.remove(); return; }
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) { sessionStorage.setItem('pd_splash_seen', '1'); splash.remove(); return; }
      splash.classList.add('pd-splash-show');
      var hide = function () {
        splash.classList.remove('pd-splash-show');
        splash.classList.add('pd-splash-hide');
        sessionStorage.setItem('pd_splash_seen', '1');
        setTimeout(function () { splash.remove(); }, 650);
      };
      var t = setTimeout(hide, 2600);
      splash.addEventListener('click', function () { clearTimeout(t); hide(); });
      // Keep the theme verse in sync with the chosen language.
      document.addEventListener('pd:lang', function () { scripture.render($('#pdSplash .pd-splash-verse')); });
    },
    syncTheme: function () {
      // The appearance now follows the device (prefers-color-scheme) with no
      // manual toggle. The resolved mode drives `dark-mode` on <html> and
      // <body> so fixed overlays, cached page styles and the brand layer all
      // stay in step. Detects OS changes instantly — no reload needed.
      var sync = function () {
        var mode = theme.mode();
        var dark = mode === 'dark';
        document.documentElement.classList.toggle('dark-mode', dark);
        document.body.classList.toggle('dark-mode', dark);
        // Refresh pages that kept a legacy moon/sun toggle after this deploy
        // so its icon always reflects the real, system-driven appearance.
        var legacyToggle = document.querySelector('[data-pd-theme-toggle] .pd-i, .theme-toggle-btn .pd-i');
        if (legacyToggle) legacyToggle.className = dark ? 'pd-i pd-i-sun' : 'pd-i pd-i-moon';
        // Keep the legacy localStorage key in step (for older app shells that
        // still read it) but the media query is the single source of truth.
        try { localStorage.setItem('pd-theme', dark ? 'dark' : 'light'); } catch (e) {}
      };
      sync();
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        try {
          var onChg = function () { sync(); };
          if (mq.addEventListener) mq.addEventListener('change', onChg);
          else if (mq.addListener) mq.addListener(onChg);
        } catch (e) { /* older WebViews */ }
      }
      if (window.MutationObserver) {
        new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-pd-theme'] });
      }
      // Adapt the theme-colour chrome of the browser UI to match.
      if (!document.querySelector('meta[name="theme-color"]')) return;
      var themeMeta = document.querySelector('meta[name="theme-color"]');
      if (document.body.classList.contains('dark-mode')) themeMeta.setAttribute('content', '#071a33');
      else themeMeta.setAttribute('content', '#0A4D9B');
    },
    toggleNotifPanel: function (forceOpen) {
      var panel = notifications.panelEl || notifications.ensurePanel();
      if (!panel) return;
      var open = typeof forceOpen === 'boolean' ? forceOpen : !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      var bell = $('#pdNotifBell') || $('#notificationBell') || $('.pd-bell-btn');
      if (bell) bell.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) return;
      // Opening the centre always shows the current list, the right empty
      // state, and the permission strip when alerts are still off.
      notifications.render();
      notifications.syncAlerts();
      notifications.syncBadge();
      var first = panel.querySelector('.pd-notif-alerts:not([hidden]) button, .pd-notif-item, .pd-notif-head-actions button');
      if (first && typeof first.focus === 'function') {
        try { first.focus({ preventScroll: true }); } catch (e) {}
      }
    },
    /* Branded member photo — falls back to the Prayer Dome avatar, never to a
       third-party placeholder image. */
    avatar: avatarUrl,
    defaultAvatar: DEFAULT_AVATAR,
    brandLogo: BRAND_LOGO
  };

  /* --------------------------------------------------------- translations */
  // The public site is presented in English. Older visitors may still carry a
  // saved `pd_lang` from the retired picker; ignore and clear it so nobody is
  // unexpectedly dropped into a part-translated page.
  var lang = 'en';
  try { localStorage.removeItem('pd_lang'); } catch (e) {}
  var i18n = {
    current: function () { return lang; },
    set: function (code) {
      lang = code;
      try { localStorage.setItem('pd_lang', code); } catch (e) {}
      $$('[data-pd-t]').forEach(function (el) {
        var key = el.getAttribute('data-pd-t');
        var txt = i18n.t(key);
        if (txt && txt !== key) el.innerHTML = txt;
      });
      // The public language selector has been retired. Translations can still
      // be applied programmatically (links, installed language packs) but the
      // header never shows a language control.
      // Translate the *whole* page, not only tagged elements. pd-i18n.js walks
      // every text node and readable attribute against the phrase pack.
      if (window.PDI18n) { try { window.PDI18n.apply(code); } catch (e) {} }
      broadcast('lang', { code: code });
    },
    t: function (key) {
      if (window.pdT) {
        try {
          var v = window.pdT(key, lang);
          // pdT returns the key itself when unknown — only accept real hits.
          if (v && v !== key) return v;
        } catch (e) {}
      }
            var table = {
        'nav.home': { en: 'Home', tum: 'Kunyumba', ssw: 'Ekhaya', bem: 'Paŵulu', nya: 'Kunyumba' },
        'nav.bible': { en: 'Bible', tum: 'Baibolo', ssw: 'LiBhayibheli', bem: 'Baibolo', nya: 'Baibulo' },
        'nav.pray': { en: 'Pray', tum: 'Lomba', ssw: 'Thandaza', bem: 'Lomba', nya: 'Pempherani' },
        'nav.sermons': { en: 'Sermons', tum: 'Maupharazgi', ssw: 'Tintshumayelo', bem: 'Icilengo', nya: 'Ulaliki' },
        'nav.assistant': { en: 'Assistant', tum: 'Wovwiri', ssw: 'Umsiti', bem: 'Umwafwilisha', nya: 'Wothandiza' },
        'nav.chat': { en: 'Chat', tum: 'Kudumbiskana', ssw: 'Ingcoco', bem: 'Ukulanshana', nya: 'Kukambirana' },
        'nav.account': { en: 'Account', tum: 'Akaunti', ssw: 'I-akhawunti', bem: 'Akaunti', nya: 'Akaunti' },
        'nav.teaching': { en: 'Teaching', tum: 'Masambiro', ssw: 'Kufundzisa', bem: 'Amasambilo', nya: 'Kuphunzitsa' },
        'nav.stories': { en: 'Stories', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyano', nya: 'Nkhani' },
        'nav.resources': { en: 'Resources', tum: 'Vya Kukhwaska', ssw: 'Tinsita', bem: 'Ifyakubomfya', nya: 'Zothandizira' },
        'nav.quizzes': { en: 'Quizzes', tum: 'Mafumbo', ssw: 'Imibuto', bem: 'Amepusho', nya: 'Mafunso' },
        'nav.live': { en: 'Live', tum: 'Moyo', ssw: 'Bukhoma', bem: 'Ubumi', nya: 'Moyo' },
        'nav.give': { en: 'Give', tum: 'Pereka', ssw: 'Nikela', bem: 'Pela', nya: 'Perekani' },
        'nav.events': { en: 'Events', tum: 'Viphikiro', ssw: 'Imicimbi', bem: 'Ifilonganino', nya: 'Zochitika' },
        'nav.gallery': { en: 'Gallery', tum: 'Vithuzi', ssw: 'Tithombe', bem: 'Ifikope', nya: 'Zithunzi' },
        'nav.media': { en: 'Media', tum: 'Vyakuwona', ssw: 'Imidiya', bem: 'Imediya', nya: 'Media' },
        'nav.news': { en: 'News', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyashi', nya: 'Nkhani' },
        'nav.testimony': { en: 'Testimony', tum: 'Ukwititira', ssw: 'Bufakazi', bem: 'Ubwitness', nya: 'Umboni' },
        'nav.support': { en: 'Support', tum: 'Wovwiri', ssw: 'Sekela', bem: 'Wafwilisha', nya: 'Thandizo' },
        'nav.about': { en: 'About', tum: 'Za ise', ssw: 'Ngatsi', bem: 'Palwa ifwe', nya: 'Za ife' },
        'nav.contact': { en: 'Contact', tum: 'Dumbiranani', ssw: 'Xhumana', bem: 'Tumeni', nya: 'Lumikizanani' },
        'nav.team': { en: 'Team', tum: 'Gulu', ssw: 'Licembu', bem: 'Ikipani', nya: 'Gulu' },
        'app.tagline': {
          en: 'A House of Prayer for All Nations', tum: 'Nyumba ya Malombo ya Mitundu Yose',
          ssw: 'Indlu Yemkhuleko Yato Tonkhe Tive', bem: 'Ing\'anda ya Kupempela ya Mitundu Yonse',
          nya: 'Nyumba ya Pemphero ya Mitundu Yonse'
        },
        'app.welcome': { en: 'Welcome to Prayer Dome', tum: 'Mwakwaniskika ku Prayer Dome', ssw: 'Wemukelekile ku-Prayer Dome', bem: 'Mwaiseni ku Prayer Dome', nya: 'Takulandirani ku Prayer Dome' },
        'verse.of.day': { en: 'Verse of the day', tum: 'Lemba la zuŵa', ssw: 'Livesi lelusuku', bem: 'Lembelo lya lelo', nya: 'Vesi la lero' },
        'action.listen': { en: 'Listen', tum: 'Pulika', ssw: 'Lalela', bem: 'Ufwikisha', nya: 'Mverani' },
        'action.stop': { en: 'Stop', tum: 'Leka', ssw: 'Yima', bem: 'Leka', nya: 'Lekani' },
        'action.copy': { en: 'Copy', tum: 'Kopa', ssw: 'Kopisha', bem: 'Kopa', nya: 'Koperani' },
        'action.share': { en: 'Share', tum: 'Gaŵana', ssw: 'Yabelana', bem: 'Abelana', nya: 'Gawanani' },
        'action.save': { en: 'Save', tum: 'Sunga', ssw: 'Gcina', bem: 'Sunga', nya: 'Sungani' },
        'action.search': { en: 'Search', tum: 'Penja', ssw: 'Sesha', bem: 'Fwaya', nya: 'Fufuzani' },
        'action.pray': { en: 'Pray this', tum: 'Lombani ili', ssw: 'Thandaza loku', bem: 'Lombela ili', nya: 'Pempherani ili' },
        'action.read': { en: 'Read', tum: 'Ŵerengani', ssw: 'Fundza', bem: 'Belenga', nya: 'Werengani' },
        'action.download': { en: 'Download', tum: 'Kufumya', ssw: 'Landa', bem: 'Leta', nya: 'Tsitsani' },
        'action.watch': { en: 'Watch', tum: 'Wonani', ssw: 'Bukela', bem: 'Mona', nya: 'Onani' },
        'label.language': { en: 'Language', tum: 'Chiyowoyero', ssw: 'Lulwimi', bem: 'Ululimi', nya: 'Chilankhulo' },
        'label.scripture': { en: 'Scripture', tum: 'Lemba', ssw: 'UmBhalo', bem: 'Ilembelo', nya: 'Lemba' },
        'label.reference': { en: 'Reference', tum: 'Malemba', ssw: 'Inkhomba', bem: 'Ishimikila', nya: 'Mavesi' },
        'label.topic': { en: 'Topic', tum: 'Mutu', ssw: 'Sihloko', bem: 'Mutu', nya: 'Mutu' },
        'label.draft': { en: 'Community draft — awaiting review by a fluent speaker', tum: 'Ndemetero — likulindilira kuwunikika na munthu wakumanya chiyowoyero', ssw: 'Umculu wekucala — usalindzele kubukwa ngulokhulumako lulwimi', bem: 'Amalembo yasambililo — yalindilila ukubwekwa ku bantu bashimikila ululimi', nya: 'Zolembedwa zoyamba — zikudikirira kuwunikidwa ndi olankhula chinenerocho' },
        'label.all': { en: 'All', tum: 'Vyose', ssw: 'Konkhe', bem: 'Fyonse', nya: 'Zonse' },
        'label.lessons': { en: 'Lessons', tum: 'Masambiro', ssw: 'Tifundvo', bem: 'Amasambilo', nya: 'Maphunziro' },
        'label.stories': { en: 'Stories', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyano', nya: 'Nkhani' },
        'label.resources': { en: 'Resources', tum: 'Vya Kukhwaska', ssw: 'Tinsita', bem: 'Ifyakubomfya', nya: 'Zothandizira' },
        'bible': { en: 'Bible', tum: 'Baibolo', ssw: 'LiBhayibheli', bem: 'Baibolo', nya: 'Baibulo' },
        'assistant': { en: 'Assistant', tum: 'Wovwiri', ssw: 'Umsiti', bem: 'Umwafwilisha', nya: 'Wothandiza' },
        'sermons': { en: 'Sermons', tum: 'Maupharazgi', ssw: 'Tintshumayelo', bem: 'Icilengo', nya: 'Ulaliki' },
        'teaching': { en: 'Teaching', tum: 'Masambiro', ssw: 'Kufundzisa', bem: 'Amasambilo', nya: 'Kuphunzitsa' },
        'stories': { en: 'Stories', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyano', nya: 'Nkhani' },
        'resources': { en: 'Resources', tum: 'Vya Kukhwaska', ssw: 'Tinsita', bem: 'Ifyakubomfya', nya: 'Zothandizira' },
        'translate': { en: 'Translate', tum: 'Sungunula', ssw: 'Humusha', bem: 'Alula', nya: 'Tanthauzirani' },
        'gallery': { en: 'Gallery', tum: 'Vithuzi', ssw: 'Tithombe', bem: 'Ifikope', nya: 'Zithunzi' },
        'give': { en: 'Give', tum: 'Pereka', ssw: 'Nikela', bem: 'Pela', nya: 'Perekani' },
        'live': { en: 'Live', tum: 'Moyo', ssw: 'Bukhoma', bem: 'Ubumi', nya: 'Moyo' },
        'quiz': { en: 'Quiz', tum: 'Mafumbo', ssw: 'Imibuto', bem: 'Amepusho', nya: 'Mafunso' },
        'membership': { en: 'Membership', tum: 'Umbali', ssw: 'Bulunga', bem: 'Bumembala', nya: 'Umembala' },
        'support': { en: 'Support', tum: 'Wovwiri', ssw: 'Sekela', bem: 'Wafwilisha', nya: 'Thandizo' },
        'testimony': { en: 'Testimony', tum: 'Ukwititira', ssw: 'Bufakazi', bem: 'Ubwitness', nya: 'Umboni' },
        'events': { en: 'Events', tum: 'Viphikiro', ssw: 'Imicimbi', bem: 'Ifilonganino', nya: 'Zochitika' },
        'news': { en: 'News', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyashi', nya: 'Nkhani' },
        'media': { en: 'Media', tum: 'Vyakuwona', ssw: 'Imidiya', bem: 'Imediya', nya: 'Media' },
        'about': { en: 'About', tum: 'Za ise', ssw: 'Ngatsi', bem: 'Palwa ifwe', nya: 'Za ife' },
        'contact': { en: 'Contact', tum: 'Dumbiranani', ssw: 'Xhumana', bem: 'Tumeni', nya: 'Lumikizanani' },
        'team': { en: 'Team', tum: 'Gulu', ssw: 'Licembu', bem: 'Ikipani', nya: 'Gulu' },
        'chat': { en: 'Chat', tum: 'Kudumbiskana', ssw: 'Ingcoco', bem: 'Ukulanshana', nya: 'Kukambirana' },
        'academy.title': { en: 'Prayer Dome Academy', tum: 'Sukulu ya Prayer Dome', ssw: 'Sikolo se-Prayer Dome', bem: 'Sukulu ya Prayer Dome', nya: 'Sukulu ya Prayer Dome' },
        'academy.lessons': { en: 'Lessons', tum: 'Masambiro', ssw: 'Tifundvo', bem: 'Amasambilo', nya: 'Maphunziro' },
        'academy.stories': { en: 'Stories', tum: 'Nkhani', ssw: 'Tindzaba', bem: 'Ifyano', nya: 'Nkhani' },
        'academy.quizzes': { en: 'Quizzes', tum: 'Mafumbo', ssw: 'Imibuto', bem: 'Amepusho', nya: 'Mafunso' },
        'academy.resources': { en: 'Resources', tum: 'Vya Kukhwaska', ssw: 'Tinsita', bem: 'Ifyakubomfya', nya: 'Zothandizira' },
        'academy.track.foundations': { en: 'Foundations', tum: 'Maziko', ssw: 'Tisekelo', bem: 'Imilando', nya: 'Maziko' },
        'academy.track.prayer': { en: 'Prayer & Intercession', tum: 'Malombo', ssw: 'Umkhuleko', bem: 'Ukupempela', nya: 'Pemphero' },
        'academy.track.word': { en: 'The Word of God', tum: 'Mazgu gha Chiuta', ssw: 'Livi laNkulunkulu', bem: 'Cebo ca Lesa', nya: 'Mawu a Mulungu' },
        'academy.track.spirit': { en: 'Holy Spirit & Gifts', tum: 'Mzimu Mutuŵa', ssw: 'Moya Longcwele', bem: 'Mupashi wa Mushilo', nya: 'Mzimu Woyera' },
        'academy.track.character': { en: 'Christlike Character', tum: 'Makhalo gha Khristu', ssw: 'Similo saKhristu', bem: 'Mikalile ya kwa Kristu', nya: 'Khalidwe la Khristu' },
        'academy.track.mission': { en: 'Mission & Service', tum: 'Uthenga', ssw: 'Lutshumo', bem: 'Mulimo wa Kutuma', nya: 'Utumiki' },
        'docs.title': { en: 'Document Library', tum: 'Mabuku gha Chisambizgo', ssw: 'Imibhalo Yekufundzisa', bem: 'Mabuku ya Kusambilisha', nya: 'Mabuku Ophunzitsa' },
        'docs.statement': { en: 'Statement of Faith', tum: 'Chipulikano Chithu', ssw: 'Kukholwa Kwethu', bem: 'Icitetekelo Cesu', nya: 'Chikhulupiriro Chathu' },
        'docs.guide.new': { en: 'New Believer’s Growth Guide', tum: 'Kalozgera ka Ŵakupulikana Basi', ssw: 'Umhlahlandlela waLabasha', bem: 'Kalozela ka Bakatetekela Bapya', nya: 'Kalozera wa Okhulupirira Atsopano' },
        'location.title': { en: 'You are worshipping from', tum: 'Mukung’ana kufuma ku', ssw: 'Ukhonta usuka e', bem: 'Mulepela ukufuma ku', nya: 'Mukupemphera kuchokera ku' },
        'location.detect': { en: 'Detecting your location…', tum: 'Kupenja malo ghinu…', ssw: 'Kuthola indzawo yakho…', bem: 'Ukufwaya apa muli…', nya: 'Kufufuza komwe muli…' },
        'announcements.title': { en: 'Announcements', tum: 'Vilapo', ssw: 'Tsimemezelo', bem: 'Amalumbwe', nya: 'Zolengeza' },
        'notifications.title': { en: 'Notifications', tum: 'Vimanyikwiso', ssw: 'Taziso', bem: 'Ifyo mukutiishiba', nya: 'Zidziwitso' },
        'notifications.empty': { en: 'No notifications yet', tum: 'Palibe vimanyikwiso', ssw: 'Kute azange kube netaziso', bem: 'Tapali ifyo mukutiishiba', nya: 'Palibe zidziwitso' },
        'scripture.featured': { en: 'Featured Scripture', tum: 'Lemba Likulutila', ssw: 'UmBhalo Lokhetsekile', bem: 'Ilembelo Lya Patali', nya: 'Lemba Lalikulu' },
        'stat.members': { en: 'Members', tum: 'Ŵabali', ssw: 'Emalunga', bem: 'Abalongo', nya: 'Mamembala' },
        'stat.prayers': { en: 'Prayer Requests', tum: 'Malombo', ssw: 'Ticelo', bem: 'Ukupepela', nya: 'Zopemphera' },
        'stat.testimonies': { en: 'Testimonies', tum: 'Ukwititira', ssw: 'Bufakazi', bem: 'Ubwitness', nya: 'Umboni' },
        'stat.countries': { en: 'Countries Reached', tum: 'Mayiko Ghakafika', ssw: 'Emave Latifikile', bem: 'Ifyalo Ifikilwa', nya: 'Mayiko Ofikiridwa' },
        'stat.live': { en: 'Live Viewers', tum: 'Ŵakuwona Pa Lubali', ssw: 'Babukela Baphilile', bem: 'Abalemona Pa Live', nya: 'Owonera Pa Live' },
        'stat.groups': { en: 'Prayer Groups', tum: 'Magulu gha Malombo', ssw: 'Emacembu Emkhuleko', bem: 'Amapinda ya Kupempela', nya: 'Magulu a Pemphero' },
        'challenge.title': { en: 'Weekly Prayer Challenge', tum: 'Nthowa ya Sabata ya Malombo', ssw: 'Inselele Yemkhuleko Yeviki', bem: 'Amayesho ya Kupempela ya Iciwela', nya: 'Vuto la Pemphero la Sabata' },
        'challenge.prayToday': { en: 'I prayed today', tum: 'Nalomba lelo', ssw: 'Ngithandazile lamuhla', bem: 'Nalomba lelo', nya: 'Ndaph pemphero lero' },
        'devotional.title': { en: 'Daily Devotional', tum: 'Mphambano ya Zuŵa', ssw: 'Kudla Kwalelanga', bem: 'Iciwelo ca Bushiku', nya: 'Mawu a Tsiku' },
        'prayer.wall': { en: 'Prayer Wall', tum: 'Khotolo la Malombo', ssw: 'Ludvonga Lwemkhuleko', bem: 'Cibumba ca Mapempelo', nya: 'Khoma la Pemphero' },
        'bible.center': { en: 'Bible Center', tum: 'Malo gha Baibolo', ssw: 'Sikhungo seLiBhayibheli', bem: 'Cipinda ca Baibolo', nya: 'Malo a Baibulo' },
        'sermon.center': { en: 'Sermon Center', tum: 'Malo gha Maupharazgi', ssw: 'Sikhungo Setintshumayelo', bem: 'Cipinda ca Milumbe', nya: 'Malo a Ulatiki' },
        'footer.rights': { en: 'All Rights Reserved', tum: 'Mazaza Ghose Ghapewa', ssw: 'Onkhe Amalungelo Agodliwe', bem: 'Insambu Shonse Shasungwa', nya: 'Ufulu Wonse Wosungidwa' },
        'footer.verse': { en: 'He does everything blamelessly. — Mark 7:37', tum: 'Wacita vinthu vyose makora. — Maliko 7:37', ssw: 'Wente konkhe kuhle. — Makho 7:37', bem: 'Atenda ifintu fyonse bwino. — Marko 7:37', nya: 'Iye wachita zonse bwino. — Maliko 7:37' }
      };
      var row = table[key];
      if (!row) return key;
      return row[lang] || row.en || key;
    },
    init: function () {
      // The language picker was removed from the public header on purpose:
      // one clear English experience for every visitor. The translation engine
      // remains available to pages that explicitly call it.
      i18n.applyEnabled();
      // Apply strings to any [data-pd-t] elements.
      $$('[data-pd-t]').forEach(function (el) {
        var txt = i18n.t(el.getAttribute('data-pd-t'));
        if (txt) el.innerHTML = txt;
      });
      // Translate the rest of the page and keep watching for content the app
      // renders later (prayer cards, chat messages, admin tables, dialogs).
      if (window.PDI18n) {
        try {
          if (lang !== 'en') window.PDI18n.apply(lang);
          else window.PDI18n.observe();
        } catch (e) {}
      }
      document.dispatchEvent(new CustomEvent('pd:lang', { detail: { code: lang } }));
      on('store:languages', i18n.applyEnabled);
    },
    applyEnabled: function () {
      // There is no selector to filter any more. If an administrator disables
      // the active language, fall back to English so no page is stranded.
      var enabled = store.get('languages', 'DEFAULT_LANGUAGES') || ['en'];
      if (!enabled.length) enabled = ['en'];
      if (enabled.indexOf(lang) < 0) i18n.set('en');
    }
  };

  /* ------------------------------------------------------------------ geo */
  // Real IP-geolocation via free, keyless HTTPS APIs — ipwho.is (rich:
  // flag, region, timezone, local time, ISP) with ipapi.co as fallback.
  // Results are cached for 24h so repeat visits are instant and the free
  // quotas are never stressed.
  var GEO_CACHE_KEY = 'pd_ip_geo';
  var GEO_CACHE_TTL = 24 * 60 * 60 * 1000;
  var geo = {
    // Two-letter ISO country code -> flag emoji (regional indicators).
    flagEmoji: function (code) {
      if (!code || typeof code !== 'string') return '';
      return code.toUpperCase().replace(/./g, function (ch) {
        return String.fromCodePoint(127397 + ch.charCodeAt(0));
      });
    },
    formatLocalTime: function (tz, date) {
      try {
        return new Intl.DateTimeFormat([], {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
        }).format(date || new Date());
      } catch (e) { return ''; }
    },
    // Accepts either the ipwho.is shape or the ipapi.co shape.
    normalize: function (raw, source) {
      if (!raw || raw.success === false) return null;
      var tz = raw.timezone;
      if (tz && typeof tz === 'object') tz = tz.id || null;
      if (!tz) return null;
      var flag = '';
      if (raw.flag && typeof raw.flag === 'object') flag = raw.flag.emoji || '';
      else if (raw.flag && typeof raw.flag === 'string') flag = raw.flag;
      var conn = raw.connection && typeof raw.connection === 'object'
        ? (raw.connection.isp || raw.connection.org || '') : (raw.isp || '');
      var info = {
        source: source,
        timezone: tz,
        city: raw.city || null,
        region: raw.region || raw.regionName || null,
        country: raw.country_name || raw.country || null,
        countryCode: raw.countryCode || raw.country_code || null,
        flag: flag || null,
        lat: raw.latitude != null ? Number(raw.latitude) : null,
        lon: raw.longitude != null ? Number(raw.longitude) : null,
        isp: conn || null,
        localTime: geo.formatLocalTime(tz)
      };
      if (!info.flag && info.countryCode) info.flag = geo.flagEmoji(info.countryCode);
      return info;
    },
    lookupIP: function (force) {
      // 1) Fresh cache wins — instant render, no quota use.
      if (!force) {
        var cached = lsGet(GEO_CACHE_KEY, null);
        if (cached && cached.data && cached.ts && (Date.now() - cached.ts) < GEO_CACHE_TTL) {
          return Promise.resolve(cached.data);
        }
      }
      if (typeof fetch !== 'function') return Promise.resolve(null);
      var endpoints = [
        { url: 'https://ipwho.is/', name: 'ipwho.is' },
        { url: 'https://ipapi.co/json/', name: 'ipapi.co' }
      ];
      var attempt = function (i) {
        if (i >= endpoints.length) return Promise.resolve(null);
        return fetch(endpoints[i].url)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { return geo.normalize(d, endpoints[i].name); })
          .then(function (info) {
            if (!info) return attempt(i + 1);
            lsSet(GEO_CACHE_KEY, { ts: Date.now(), data: info });
            return info;
          })
          .catch(function () { return attempt(i + 1); });
      };
      return attempt(0);
    }
  };

  /* -------------------------------------------------------------- location */
  var location = {
    state: null,
    init: function () {
      var card = $('#pdLocationCard');
      if (!card) return;
      var nameEl = $('#pdLocationName', card);
      var subEl = $('#pdLocationSub', card);
      var textEl = nameEl || subEl;

      // 1. Cached value first (instant render).
      var cached = lsGet('pd_location', null);
      if (cached && textEl) {
        textEl.textContent = plainTitle(cached.name); // older caches start with a flag emoji
        if (subEl) subEl.textContent = cached.coords;
        card.classList.add('pd-loc-found');
      }

      // 2. Ask the browser for a precise fix.
      var done = false;
      var finish = function (result) {
        if (done) return; done = true;
        location.state = result;
        lsSet('pd_location', result);
        if (textEl) {
          textEl.textContent = result.name;
          if (subEl) subEl.textContent = result.coords;
        }
        card.classList.add('pd-loc-found');
        card.classList.remove('pd-loc-loading');
        broadcast('location', result);
      };

      if (!navigator.geolocation) {
        finish({ name: 'Location unavailable', coords: 'This device does not provide GPS location.' });
        return;
      }
      card.classList.add('pd-loc-loading');
      if (nameEl && subEl) { nameEl.textContent = i18n.t('location.detect'); subEl.textContent = '…'; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lng = pos.coords.longitude;
        var fallbackName = lat.toFixed(3) + ', ' + lng.toFixed(3);
        var base = { name: fallbackName, coords: lat.toFixed(3) + '°, ' + lng.toFixed(3) + '°', lat: lat, lng: lng };
        // Reverse geocode (BigDataCloud — free, no key).
        if (typeof fetch !== 'function') { finish(base); return; }
        fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lng + '&localityLanguage=en')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var city = d.city || d.locality || d.principalSubdivision || '';
            var country = d.countryName || '';
            base.name = [city, country].filter(Boolean).join(', ') || fallbackName;
            finish(base);
          })
          .catch(function () { finish(base); });
        // Enrich the sub-line with local time + ISP from the IP API.
        geo.lookupIP().then(function (d) {
          if (!d || !subEl) return;
          var extra = [];
          if (d.localTime) extra.push(d.localTime);
          if (d.isp) extra.push(d.isp);
          if (extra.length) subEl.textContent = base.coords + ' · ' + extra.join(' · ');
        }).catch(function () { /* enrichment is optional */ });
      }, function (error) {
        var message = error && error.code === 1
          ? 'Location permission was denied. Enable it in device settings and retry.'
          : error && error.code === 3
            ? 'GPS timed out. Move to an open area and retry.'
            : 'Unable to read GPS location. Check device settings and retry.';
        finish({ name: 'Location unavailable', coords: message });
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });

      // Retry button.
      var retry = $('#pdLocationRetry', card);
      if (retry) retry.addEventListener('click', function () {
        card.classList.add('pd-loc-loading');
        done = false;
        location.init();
      });
    },
    ipFallback: function (finish) {
      var offline = { name: 'Global Network', coords: 'Online — connecting Zambia, Eswatini & Ireland' };
      if (typeof fetch !== 'function') { finish(offline); return; }
      geo.lookupIP().then(function (d) {
        if (!d || !d.country) { finish(offline); return; }
        var name = [d.city, d.region, d.country].filter(Boolean).join(', ') || 'Global Network';
        var sub = [];
        if (d.lat != null && d.lon != null) sub.push(Number(d.lat).toFixed(2) + '°, ' + Number(d.lon).toFixed(2) + '°');
        if (d.localTime) sub.push(d.localTime);
        if (d.isp) sub.push(d.isp);
        finish({
          name: name,
          coords: sub.join(' · ') || 'Online',
          lat: d.lat, lng: d.lon
        });
      }).catch(function () { finish(offline); });
    }
  };

  /* --------------------------------------------------------- announcements */
  var announcements = {
    init: function () {
      var bar = $('#pdAnnouncementBar');
      if (!bar) return;
      var items = (store.get('announcements', 'DEFAULT_ANNOUNCEMENTS') || []).filter(function (a) { return a && a.active !== false; });
      var track = $('.pd-marquee-track', bar);
      if (!track) return;
      if (!items.length) { bar.style.display = 'none'; return; }
      var render = function () {
        var html = items.map(function (a, i) {
          return '<span class="pd-marquee-item" data-i="' + i + '"><i class="' + iconCls(a.icon, 'pd-i-megaphone') + '" aria-hidden="true"></i> ' + esc(a.text) + '</span>';
        }).join('<i class="pd-i pd-i-latin-cross pd-marquee-sep"></i>');
        // Duplicate for a seamless loop.
        track.innerHTML = '<div class="pd-marquee-group">' + html + '</div><div class="pd-marquee-group" aria-hidden="true">' + html + '</div>';
      };
      render();
      bar.classList.add('pd-marquee-ready');
      // Pause on hover / touch.
      bar.addEventListener('mouseenter', function () { bar.classList.add('pd-marquee-paused'); });
      bar.addEventListener('mouseleave', function () { bar.classList.remove('pd-marquee-paused'); });
      on('store:announcements', function (e) { items = (e.detail || []).filter(function (a) { return a.active !== false; }); render(); });
      on('announcement', function (e) { items = (e.detail || []).filter(function (a) { return a.active !== false; }); render(); });
    }
  };

  /* ---------------------------------------------------------- notifications
     Three problems this module solves:
       1. The permission prompt must read professionally — we show our own
          "Allow Notifications" sheet first, and on the native Android build we
          ask through Capacitor so the browser origin is never displayed.
       2. Notifications must reach the *device* (notification shade / lock
          screen), not just the in-app bell — so we hand them to the service
          worker, which is what Android and installed iOS PWAs require.
       3. Once an item is read it must never come back as new — read state is
          stored per notification id and applied to the Firestore mirror too. */
  var READ_KEY = 'pd_notif_read_ids';
  var READ_SIG_KEY = 'pd_notif_read_sigs';
  var SHOWN_KEY = 'pd_notif_shown_ids';
  var PREF_KEY = 'pd_notif_prefs';
  var PENDING_TOKEN_KEY = 'pd_push_pending';
  var TOPIC_PREF_KEY = 'pd_notif_topic_prefs';

  /* What a member wants on their *device* (lock screen / shade). Everything
     still appears in the bell — these switches only decide what interrupts
     them. The defaults are the useful ones: every category on. */
  var NOTIF_TYPES = {
    verse: 'Daily Bible verse',
    live: 'Live service alerts',
    prayer: 'Prayer and care updates',
    news: 'News and announcements',
    sermon: 'Sermons and devotionals',
    event: 'Events and reminders',
    general: 'Other ministry notices'
  };
  function readPrefs() {
    var saved = lsGet(PREF_KEY, null);
    var prefs = {};
    Object.keys(NOTIF_TYPES).forEach(function (k) { prefs[k] = true; });
    if (saved && typeof saved === 'object') {
      Object.keys(NOTIF_TYPES).forEach(function (k) {
        if (saved[k] === false) prefs[k] = false;
      });
    }
    return prefs;
  }
  function typeAllowed(type) {
    var key = String(type || 'general').toLowerCase();
    if (!NOTIF_TYPES[key]) key = 'general';
    return readPrefs()[key] !== false;
  }

  /* Web-push identity. The VAPID public key is the Web Push certificate from
     the Prayer Dome Firebase project — it is a public value, safe to ship. */
  var VAPID_PUBLIC_KEY = 'BFo6TSo4Urth0PXWZETz6cuPgRlemsFx7LDn8yDlFqCrIELU16X12O4ObOOlnbP2h7PvKqbC0N6a-_vrSsksrnM';
  var FCM_CONFIG = {
    apiKey: 'AIzaSyCxvql0r_aeerphxTA0UUedRppdBxGf7wo',
    authDomain: 'prayer-dome.firebaseapp.com',
    projectId: 'prayer-dome',
    storageBucket: 'prayer-dome.firebasestorage.app',
    messagingSenderId: '198295153196',
    appId: '1:198295153196:web:1222b31948d7974ba3bf89'
  };

  function idList(key) { var v = lsGet(key, []); return Array.isArray(v) ? v : []; }
  function rememberId(key, id, cap) {
    if (!id) return;
    var list = idList(key);
    if (list.indexOf(id) > -1) return;
    list.unshift(id);
    lsSet(key, list.slice(0, cap || 300));
  }
  function signature(n) {
    return [n.type || 'general', (n.title || '').trim(), (n.message || '').trim()].join('|');
  }
  /* Once a member marks something read it must never come back as new — not
     even if the same announcement later arrives under a different id (a local
     push adopted by Firestore, a re-sent broadcast, a second device). So we
     remember both the id and a content signature. */
  function isRead(n) {
    if (!n) return false;
    if (n.id && idList(READ_KEY).indexOf(n.id) > -1) return true;
    return idList(READ_SIG_KEY).indexOf(signature(n)) > -1;
  }
  function rememberRead(n) {
    if (!n) return;
    rememberId(READ_KEY, n.id, 300);
    rememberId(READ_SIG_KEY, signature(n), 300);
  }

  var notifications = {
    items: lsGet('pd_notifications', []),
    badgeEl: null,
    listEl: null,
    panelEl: null,
    listId: 'pdNotifList',
    /**
     * The notification centre must exist on every page that shows a bell.
     *
     * Several pages carried the bell button but not the panel markup, so a tap
     * on the bell ran `toggleNotifPanel()`, found nothing to open, and the
     * member was left looking at a button that does nothing. Any page with a
     * bell now gets the centre built for it, with the same markup, classes and
     * empty state as the home page — the bell always shows something.
     */
    ensurePanel: function () {
      var existing = $('#pdNotifPanel');
      if (existing) {
        notifications.panelEl = existing;
        notifications.listEl = $('#pdNotifList') || existing.querySelector('[data-pd-notif-list]');
        if (notifications.listEl) notifications.listId = notifications.listEl.id || notifications.listId;
        return existing;
      }
      var bell = $('#pdNotifBell') || $('#notificationBell') || $('.pd-bell-btn');
      if (!bell || !document.body) return null;

      var panel = document.createElement('div');
      panel.className = 'pd-notif-panel';
      panel.id = 'pdNotifPanel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panel.setAttribute('aria-label', i18n.t('notifications.title'));
      panel.innerHTML =
        '<div class="pd-notif-head">' +
          '<h3><i class="pd-i pd-i-bell"></i> <span>' + esc(i18n.t('notifications.title')) + '</span></h3>' +
          '<div class="pd-notif-head-actions">' +
            '<button type="button" title="Mark all read" data-pd-notif="read-all"><i class="pd-i pd-i-check-check"></i></button>' +
            '<button type="button" title="Clear" data-pd-notif="clear"><i class="pd-i pd-i-trash"></i></button>' +
            '<button type="button" title="Close" data-pd-notif="close"><i class="pd-i pd-i-x"></i></button>' +
          '</div>' +
        '</div>' +
        '<div class="pd-notif-alerts" data-pd-notif="alerts" hidden>' +
          '<span class="pd-notif-alerts-icon"><i class="pd-i pd-i-bell"></i></span>' +
          '<span class="pd-notif-alerts-text">Turn on device alerts so Prayer Dome can reach you when the page is closed.</span>' +
          '<button type="button" class="pd-notif-alerts-btn" data-pd-notif="enable">Turn on</button>' +
        '</div>' +
        '<div id="' + notifications.listId + '"></div>';
      document.body.appendChild(panel);

      // Role scoped by this page's own panel, so several panels never fight.
      var list = panel.querySelector('#' + notifications.listId);
      panel.addEventListener('click', function (event) {
        var action = event.target && event.target.closest ? event.target.closest('[data-pd-notif]') : null;
        if (!action) return;
        var what = action.getAttribute('data-pd-notif');
        if (what === 'close') ui.toggleNotifPanel(false);
        else if (what === 'clear') notifications.clear();
        else if (what === 'read-all') notifications.markAllRead();
        else if (what === 'enable') notifications.showEnablePop();
      });

      notifications.panelEl = panel;
      notifications.listEl = list;
      return panel;
    },
    /** Show or hide the "turn on device alerts" strip inside the centre. */
    syncAlerts: function () {
      var panel = notifications.panelEl;
      if (!panel) return;
      var strip = panel.querySelector('[data-pd-notif="alerts"]');
      if (!strip) return;
      strip.hidden = !notifications.canPrompt();
    },
    init: function () {
      notifications.badgeEl = $('#pdNotifBadge') || $('.pd-bell-badge') || $('#notifBadge');
      notifications.ensurePanel();
      // Apply stored read state on boot so nothing reappears as "new".
      notifications.items = notifications.items.map(function (n) {
        if (isRead(n)) n.read = true;
        return n;
      });
      if (notifications.listEl) notifications.render();
      notifications.syncBadge();

      // The bell ALWAYS opens the notification centre. It used to open the
      // "allow notifications" sheet instead on the first tap, which — on a
      // page with no panel markup at all — meant the member tapped a bell and
      // saw nothing happen. Permission is now offered inside the open centre
      // by a small strip, and can be dismissed without losing the panel.
      var bell = $('#pdNotifBell') || $('#notificationBell') || $('.pd-bell-btn');
      if (bell) {
        bell.setAttribute('aria-expanded', 'false');
        if (!bell.hasAttribute('aria-haspopup')) bell.setAttribute('aria-haspopup', 'dialog');
        bell.addEventListener('click', function (e) {
          e.stopPropagation();
          ui.toggleNotifPanel();
        });
      }
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') ui.toggleNotifPanel(false);
      });
      document.addEventListener('click', function (e) {
        var panel = notifications.panelEl;
        if (panel && panel.classList.contains('open') &&
            !panel.contains(e.target) && bell && !bell.contains(e.target)) {
          ui.toggleNotifPanel(false);
        }
      });
      // Listen for new pushes from other tabs / the admin dashboard.
      on('notification', function (e) {
        if (e && e.detail) notifications.push(e.detail, { silent: true });
      });
      // If the member already allowed notifications, make sure this device is
      // registered for push so admin announcements actually arrive.
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        setTimeout(function () { notifications.registerDevice(); }, 2500);
      }
      // Settings follow the member across devices. Read them once the session
      // is known; a local-only visitor keeps the switches on this device.
      setTimeout(function () {
        if (fb && fb.auth && fb.auth.currentUser) {
          notifications.loadPreferences();
          notifications.loadReminder();
        }
      }, 3500);
      // Messages from the worker: a dismissed system notification counts as
      // seen, and a push that arrived while the app is open is added to the
      // bell immediately (the worker already drew the notification).
      if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', function (event) {
          var msg = event.data || {};
          if (msg.type === 'pd-notification-dismissed' && msg.id) notifications.markRead(msg.id);
          if (msg.type === 'pd-push-received' && msg.notification) {
            notifications.push(msg.notification, { silent: true, localOnly: true });
          }
        });
      }
      // If a token was issued before sign-in, upload it as soon as we know who
      // this is, and again whenever the app returns to the foreground.
      notifications.flushPendingToken();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) notifications.flushPendingToken();
      });
      document.addEventListener('pd:role', function () {
        // Signing in (or a role arriving late) is the moment the account's
        // saved notification settings become readable.
        notifications.loadPreferences();
        notifications.loadReminder();
        notifications.flushPendingToken();
      });
      setTimeout(function () { notifications.flushPendingToken(); }, 4000);
      // Firestore live mirror: an admin broadcast reaches the bell of every
      // open app within a second, not only the next reload. onSnapshot is used
      // where the page supplied it; older pages fall back to one read.
      if (fb && fb.db && fb.collection && fb.query && fb.orderBy && fb.limit && (fb.onSnapshot || fb.getDocs)) {
        var q = fb.query(fb.collection(fb.db, 'publicNotifications'), fb.orderBy('createdAt', 'desc'), fb.limit(20));
        var applyRemote = function (snap) {
          var remote = [];
          snap.forEach(function (d) {
            var x = d.data();
            // Token-bearing push records are intentionally unreadable to
            // members; a mirror without tokens carries the bell entry. The
            // `latest_alert` state document is not an announcement — skip it
            // and anything that was not explicitly mirrored as in-app.
            if (d.id === 'latest_alert' || x.inApp !== true) return;
            remote.push({
              id: d.id, type: x.type || 'general', title: x.title || 'Update',
              message: x.message || '', link: x.link || null,
              time: x.createdAt ? (x.createdAt.toDate ? x.createdAt.toDate().toISOString() : new Date(x.createdAt).toISOString()) : new Date().toISOString(),
              read: false
            });
          });
          if (remote.length) notifications.merge(remote);
        };
        try {
          if (fb.onSnapshot) {
            notifications._remoteUnsub = fb.onSnapshot(q, applyRemote, function () {});
          } else {
            fb.getDocs(q).then(applyRemote).catch(function () {});
          }
        } catch (e) { /* the in-app centre still works from local state */ }
      }
    },

    /* Merge remote items without duplicating what is already local and without
       resurrecting anything the member already read. */
    merge: function (remote) {
      var seenIds = {};
      var seenSignatures = {};
      var merged = [];

      remote.concat(notifications.items).forEach(function (n) {
        if (!n || !n.id) return;
        var sig = signature(n);
        if (seenIds[n.id] || seenSignatures[sig]) return;
        seenIds[n.id] = true;
        seenSignatures[sig] = true;
        if (isRead(n)) n.read = true;
        merged.push(n);
      });

      merged.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
      notifications.items = merged.slice(0, 40);
      lsSet('pd_notifications', notifications.items);
      notifications.render();
      notifications.syncBadge();

      // Surface genuinely fresh remote items on the device (last 10 minutes).
      var cutoff = Date.now() - 10 * 60 * 1000;
      notifications.items.forEach(function (n) {
        if (!n.read && new Date(n.time).getTime() > cutoff) notifications.notifyDevice(n);
      });
    },

    canPrompt: function () {
      return typeof Notification !== 'undefined' && Notification.permission === 'default';
    },

    /* Our own "Allow Notifications" sheet. Browsers always add their own
       origin line to the *system* prompt (that text cannot be changed by a
       website), so we make the request feel professional by asking first, in
       Prayer Dome's own words, and by using the native permission dialog on the
       installed Android app where no website name is shown at all. */
    showEnablePop: function () {
      if (document.getElementById('pdNotifPop')) return;
      var overlay = document.createElement('div');
      overlay.id = 'pdNotifPop';
      overlay.className = 'pd-notif-pop-overlay';
      overlay.innerHTML =
        '<div class="pd-notif-pop" role="dialog" aria-modal="true" aria-labelledby="pdNotifPopTitle">' +
          '<div class="pd-notif-pop-icon"><img src="' + BRAND_LOGO + '" alt="Prayer Dome" width="44" height="44"></div>' +
          '<h3 id="pdNotifPopTitle">Allow Notifications</h3>' +
          '<p>Prayer Dome would like to send you daily Bible verses, live service alerts and prayer updates. You can turn this off at any time in Settings.</p>' +
          '<div class="pd-notif-pop-actions">' +
            '<button class="pd-notif-pop-btn pd-notif-pop-btn--ghost" data-action="dismiss">Not now</button>' +
            '<button class="pd-notif-pop-btn pd-notif-pop-btn--primary" data-action="enable"><i class="pd-i pd-i-bell"></i> Allow</button>' +
          '</div>' +
          '<small class="pd-notif-pop-hint">Prayer Dome · A House of Prayer for All Nations</small>' +
        '</div>';
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('pd-notif-pop-open'); });
      overlay.addEventListener('click', function (e) {
        var action = e.target && e.target.closest && e.target.closest('[data-action]')
          ? e.target.closest('[data-action]').getAttribute('data-action')
          : (e.target === overlay ? 'dismiss' : null);
        if (!action) return;
        if (action === 'enable') {
          notifications.requestPermission().then(function (perm) {
            if (perm === 'granted') toast('Notifications are on — you will hear from us', 'success');
            else if (perm === 'denied') toast('Notifications are blocked. You can allow them in your device settings.', 'error');
            closePop();
          });
        } else {
          closePop();
          localStorage.setItem('pd_notif_pop_dismissed', new Date().toISOString());
        }
        function closePop() { overlay.classList.remove('pd-notif-pop-open'); setTimeout(function () { overlay.remove(); }, 250); }
      });
    },

    /** Native permission on the packaged app, browser permission on the web. */
    requestPermission: function () {
      var native = window.Capacitor && window.Capacitor.Plugins &&
        (window.Capacitor.Plugins.PushNotifications || window.Capacitor.Plugins.LocalNotifications);
      if (native && native.requestPermissions) {
        return native.requestPermissions()
          .then(function (res) {
            var granted = res && (res.receive === 'granted' || res.display === 'granted');
            if (granted && window.Capacitor.Plugins.PushNotifications) {
              try { window.Capacitor.Plugins.PushNotifications.register(); } catch (e) {}
            }
            if (granted) notifications.registerDevice();
            return granted ? 'granted' : 'denied';
          })
          .catch(function () { return 'denied'; });
      }
      if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
      try {
        return Promise.resolve(Notification.requestPermission()).then(function (perm) {
          if (perm === 'granted') notifications.registerDevice();
          return perm;
        });
      } catch (e) {
        // Some browsers throw if not from a user gesture — fall back to in-app only.
        return Promise.resolve(Notification.permission || 'default');
      }
    },

    /**
     * Register this device with Firebase Cloud Messaging so an announcement
     * published from the Admin Dashboard actually pops on the phone — even
     * with the app closed.
     *
     * Without this the `userTokens` collection stays empty and "Send to all"
     * has nobody to send to. The token is written once per device and only
     * rewritten when Google issues a new one, so this is cheap on every load.
     *
     * On the packaged Android app Capacitor supplies the token instead, so we
     * simply listen for it.
     */
    registerDevice: function (uid) {
      if (notifications._registering) return notifications._registering;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return Promise.resolve(null);

      var member = uid || (fb && fb.auth && fb.auth.currentUser && fb.auth.currentUser.uid) || window.PD_UID || null;

      // Packaged Android app: Capacitor hands us the FCM token.
      var push = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
      if (push && push.addListener) {
        if (!notifications._nativeBound) {
          notifications._nativeBound = true;
          try {
            push.addListener('registration', function (t) {
              notifications.saveToken(t && t.value, member, 'android');
            });
            push.register();
          } catch (e) { /* the plugin is unavailable on this build */ }
        }
        return Promise.resolve(null);
      }

      if (!navigator.serviceWorker || !window.indexedDB) return Promise.resolve(null);

      notifications._registering = (async function () {
        try {
          // Only one worker may own the '/' scope. /sw.js (registered on every
          // page by PDApp.pwa) already renders branded notifications and routes
          // clicks, so reuse whatever registration exists instead of swapping
          // the root worker back and forth — that swap is what used to drop
          // push subscriptions. /firebase-messaging-sw.js is the fallback for
          // devices that have no root worker yet.
          // `ready` waits for the active root worker. getRegistration() can
          // return an installing worker, and getToken() against a registration
          // that is not active is the classic reason a device never receives a
          // background push.
          var reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4500); })
          ]).catch(function () { return null; });
          if (!reg && typeof navigator.serviceWorker.getRegistration === 'function') {
            reg = await navigator.serviceWorker.getRegistration('/');
          }
          if (!reg) reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
          var appMod = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
          var msgMod = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js');
          if (!(await msgMod.isSupported())) return null;
          var app = appMod.getApps().length ? appMod.getApps()[0] : appMod.initializeApp(FCM_CONFIG);
          var messaging = msgMod.getMessaging(app);
          var token = await msgMod.getToken(messaging, { vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
          if (!token) return null;

          // Foreground pushes do not pass through a service worker, so the
          // browser does not show them by itself. Draw the *same* branded
          // notification from the page as well, with the same tag, and mirror
          // it into the bell. localOnly stops a second Firestore record.
          msgMod.onMessage(messaging, function (payload) {
            var note = (payload && payload.notification) || {};
            var data = (payload && payload.data) || {};
            var item = {
              id: data.id || data.tag || note.title || ('push-' + Date.now()),
              type: data.kind || data.type || 'general',
              title: note.title || data.title || 'Prayer Dome',
              message: note.body || data.body || data.message || '',
              link: data.url || data.link || null,
              time: new Date().toISOString()
            };
            notifications.push(item, { localOnly: true, silent: true });
            notifications.notifyDevice(item);
          });

          notifications.saveToken(token, member, 'web');
          notifications.syncPreferences();
          notifications.loadReminder();
          return token;
        } catch (e) {
          return null;   // push is a bonus; the in-app centre still works
        } finally {
          notifications._registering = null;
        }
      })();
      return notifications._registering;
    },

    /** Persist a device token so the Admin Dashboard can reach this device. */
    saveToken: function (token, uid, platform) {
      if (!token) return;
      var member = uid || (fb && fb.auth && fb.auth.currentUser && fb.auth.currentUser.uid) || window.PD_UID || null;
      localStorage.setItem('pd_push_token', token);
      localStorage.setItem('pd_push_token_saved', String(Date.now()));
      localStorage.setItem('pd_push_uid', String(member));

      // The security rules require a signed-in owner, so an anonymous visitor
      // keeps the token on the device and it is uploaded the moment they sign
      // in (flushPendingToken). Losing it here is why some members never
      // received a push: they allowed notifications on the welcome screen,
      // before creating an account.
      if (!member || !fb || !fb.db || !fb.setDoc || !fb.doc) {
        lsSet(PENDING_TOKEN_KEY, { token: token, platform: platform || 'web', at: Date.now() });
        return;
      }
      lsSet(PENDING_TOKEN_KEY, null);

      // One document per *device*, not per member: the same account on a phone
      // and a tablet used to overwrite one token with the other, so only the
      // last device ever received anything. The uid document is kept too for
      // the admin's "test my device" button, which looks it up by uid.
      var hash = 0;
      for (var i = 0; i < token.length; i += 1) hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
      var deviceId = String(member) + '__' + Math.abs(hash).toString(36);
      var record = {
        token: token,
        userId: member,
        platform: platform || 'web',
        active: true,
        installed: !!(window.PDApp && PDApp.app && PDApp.app.installed()),
        userAgent: String(navigator.userAgent || '').slice(0, 180),
        updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
      };
      fsSet(fb.doc(fb.db, 'userTokens', String(member)), record);
      fsSet(fb.doc(fb.db, 'userTokens', deviceId), record);
    },

    /* Show the notification on the device itself. Android and installed iOS
       PWAs only display notifications raised by the service worker, so that is
       the preferred path; the page-level API is the desktop fallback. */
    notifyDevice: function (n) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (idList(SHOWN_KEY).indexOf(n.id) > -1) return;
      // The member's switches are honoured here, before anything reaches the
      // operating system: a muted category never interrupts them.
      if (!typeAllowed(n.type)) return;
      rememberId(SHOWN_KEY, n.id, 200);

      var options = {
        body: n.message || '',
        icon: BRAND_LOGO,
        badge: '/assets/logo-192.png',
        tag: n.id,                 // one entry per item — never a duplicate
        renotify: false,
        requireInteraction: false, // informative, not intrusive
        timestamp: new Date(n.time).getTime() || Date.now(),
        data: { url: n.link || '/index.html', id: n.id, kind: n.type || 'general' }
      };
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready
          .then(function (reg) { return reg.showNotification(n.title, options); })
          .catch(function () {
            try { new Notification(n.title, options); } catch (e) {}
          });
      } else {
        try { new Notification(n.title, options); } catch (e) {}
      }
    },

    push: function (item, opts) {
      opts = opts || {};
      var now = new Date().toISOString();
      var n = {
        id: item.id || uid('notif'),
        type: item.type || 'general',
        title: item.title || 'Prayer Dome Update',
        message: item.message || '',
        link: item.link || null,
        time: item.time || now,
        read: false
      };
      n.read = isRead(n);
      // Never store the same announcement twice (e.g. local push + Firestore mirror).
      var sig = signature(n);
      var duplicate = notifications.items.filter(function (existing) {
        return existing.id === n.id || signature(existing) === sig;
      })[0];
      if (duplicate) return duplicate;

      notifications.items = [n].concat(notifications.items).slice(0, 40);
      lsSet('pd_notifications', notifications.items);
      if (notifications.listEl) notifications.render();
      notifications.syncBadge();

      if (!opts.silent) {
        // Let every other open tab render it instantly (they re-push silently,
        // so this does not loop).
        broadcast('notification', n);
        toast(plainTitle(n.title) + (n.message ? ' — ' + n.message : ''), 'success');
        notifications.notifyDevice(n);
      }
      // Persist to Firestore once (as a broadcast record, without FCM tokens).
      if (!opts.localOnly && fb && fb.db && fb.collection && fb.addDoc && fb.serverTimestamp && !n._persisted) {
        n._persisted = true;
        fb.addDoc(fb.collection(fb.db, 'notifications'), {
          type: n.type, title: n.title, message: n.message, link: n.link || null,
          createdAt: fb.serverTimestamp()
        }).then(function (ref) {
          // Adopt the server id so the mirror does not re-add this as new.
          if (!ref || !ref.id) return;
          var wasRead = n.read;
          n.id = ref.id;
          if (wasRead) rememberRead(n);
          lsSet('pd_notifications', notifications.items);
        }).catch(function () {});
      }
      return n;
    },

    render: function () {
      var list = notifications.listEl;
      if (!list) return;
      if (!notifications.items.length) {
        list.innerHTML = '<div class="pd-notif-empty"><i class="pd-i pd-i-bell-off"></i><p>' + esc(i18n.t('notifications.empty')) + '</p>' +
          '<small>Live services, new sermons, events and prayer updates land here.</small></div>';
        return;
      }
      var icons = {
        live: 'pd-i-radio', sermon: 'pd-i-mic', prayer: 'pd-i-hands-praying',
        event: 'pd-i-calendar', news: 'pd-i-newspaper', scripture: 'pd-i-book-open', urgent: 'pd-i-triangle-alert',
        general: 'pd-i-megaphone'
      };
      list.innerHTML = notifications.items.map(function (n) {
        var when = new Date(n.time);
        var label = isNaN(when) ? '' : when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return '<div class="pd-notif-item' + (n.read ? '' : ' pd-notif-unread') + '" data-id="' + esc(n.id) + '">' +
          '<div class="pd-notif-icon"><i class="pd-i ' + (icons[n.type] || icons.general) + '"></i></div>' +
          '<div class="pd-notif-body"><div class="pd-notif-title">' + esc(plainTitle(n.title)) + '</div>' +
          '<div class="pd-notif-msg">' + esc(n.message) + '</div>' +
          '<div class="pd-notif-time">' + esc(label) + '</div></div>' +
          (n.link ? '<a class="pd-notif-go" href="' + esc(n.link) + '" aria-label="Open"><i class="pd-i pd-i-chevron-right"></i></a>' : '') +
          '</div>';
      }).join('');
      $$('.pd-notif-item', list).forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-id');
          notifications.markRead(id);
          var item = notifications.items.filter(function (n) { return n.id === id; })[0];
          if (item && item.link && item.link !== '#') window.location.href = item.link;
        });
      });
    },

    markRead: function (id) {
      rememberId(READ_KEY, id, 300);
      notifications.items = notifications.items.map(function (n) {
        if (n.id === id) { n.read = true; rememberRead(n); }
        return n;
      });
      lsSet('pd_notifications', notifications.items);
      // Clear it from the device shade too, so it cannot be tapped again later.
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg.active) reg.active.postMessage({ type: 'pd-clear-notification', tag: id });
        }).catch(function () {});
      }
      notifications.render();
      notifications.syncBadge();
    },

    markAllRead: function () {
      notifications.items.forEach(function (n) {
        n.read = true;
        rememberRead(n);
      });
      lsSet('pd_notifications', notifications.items);
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          return reg.getNotifications ? reg.getNotifications() : [];
        }).then(function (list) {
          (list || []).forEach(function (note) { note.close(); });
        }).catch(function () {});
      }
      notifications.render();
      notifications.syncBadge();
    },

    clear: function () {
      // Remember what was cleared so the Firestore mirror cannot resurrect it.
      notifications.items.forEach(function (n) { rememberRead(n); });
      notifications.items = [];
      lsSet('pd_notifications', []);
      notifications.render();
      notifications.syncBadge();
    },

    unread: function () {
      return notifications.items.filter(function (n) { return !n.read; }).length;
    },

    preferences: function () { return readPrefs(); },
    setPreference: function (type, on) {
      var prefs = readPrefs();
      var key = String(type || 'general').toLowerCase();
      if (!NOTIF_TYPES[key]) key = 'general';
      prefs[key] = !!on;
      lsSet(PREF_KEY, prefs);
      broadcast('notif-prefs', prefs);
      try { document.dispatchEvent(new CustomEvent('pd:notif-prefs', { detail: prefs })); } catch (e) {}
      notifications.syncPreferences();
      return prefs;
    },
    /* Server pushes must respect the same switches, otherwise turning "News"
       off would silence the bell but still buzz the phone. The preference
       document is read by the Cloud Function before it sends a category. */
    syncPreferences: function () {
      var current = fb && fb.auth && fb.auth.currentUser;
      var prefs = readPrefs();
      if (!current || !fb || !fb.db || !fb.doc || !fb.setDoc) return Promise.resolve(false);
      return Promise.resolve(fb.setDoc(fb.doc(fb.db, 'userNotificationPrefs', current.uid), {
        uid: current.uid,
        prefs: prefs,
        updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
      }, { merge: true })).then(function () { return true; }).catch(function () { return false; });
    },
    /* Pull the member's category switches back from Firestore so a phone and
       a tablet show the same notification settings. Local defaults stay in
       place for anything the document does not mention. */
    loadPreferences: function () {
      var current = fb && fb.auth && fb.auth.currentUser;
      if (!current || !fb || !fb.db || !fb.doc || !fb.getDoc) return Promise.resolve(false);
      return Promise.resolve(fb.getDoc(fb.doc(fb.db, 'userNotificationPrefs', current.uid)))
        .then(function (snap) {
          var stored = snap && snap.exists && snap.exists() ? (snap.data() || {}).prefs : null;
          if (!stored || typeof stored !== 'object') return false;
          var prefs = readPrefs();
          Object.keys(NOTIF_TYPES).forEach(function (key) {
            if (stored[key] === false) prefs[key] = false;
            else if (stored[key] === true) prefs[key] = true;
          });
          lsSet(PREF_KEY, prefs);
          broadcast('notif-prefs', prefs);
          try { document.dispatchEvent(new CustomEvent('pd:notif-prefs', { detail: prefs })); } catch (e) {}
          return prefs;
        })
        .catch(function () { return false; });
    },
    reminder: function () {
      try {
        var raw = JSON.parse(localStorage.getItem('pd_prayer_reminder') || '{}');
        return { time: raw.time || '', on: !!raw.on };
      } catch (e) { return { time: '', on: false }; }
    },
    /* The daily reminder is also stored server-side so a closed phone still
       gets it. Load that row on sign-in so a new device shows the same time. */
    loadReminder: function () {
      var current = fb && fb.auth && fb.auth.currentUser;
      if (!current || !fb || !fb.db || !fb.doc || !fb.getDoc) return Promise.resolve(false);
      return Promise.resolve(fb.getDoc(fb.doc(fb.db, 'userReminders', current.uid)))
        .then(function (snap) {
          if (!snap || !snap.exists || !snap.exists()) return false;
          var row = snap.data() || {};
          if (!row.reminderTime && !row.notifications) return false;
          var value = { time: /^\d{2}:\d{2}$/.test(String(row.reminderTime || '')) ? row.reminderTime : '', on: !!row.notifications && !!row.reminderTime };
          lsSet('pd_prayer_reminder', value);
          broadcast('notif-reminder', value);
          try { document.dispatchEvent(new CustomEvent('pd:notif-reminder', { detail: value })); } catch (e) {}
          return value;
        })
        .catch(function () { return false; });
    },
    /* Daily prayer reminder. The preference lives in localStorage so the
       service worker can read it offline, and in userReminders so the
       scheduled Cloud Function can reach a closed phone. */
    setReminder: function (time, on) {
      var clean = /^\d{2}:\d{2}$/.test(String(time || '')) ? String(time) : '';
      var value = { time: clean, on: !!on && !!clean };
      try { localStorage.setItem('pd_prayer_reminder', JSON.stringify(value)); } catch (e) {}
      broadcast('notif-reminder', value);
      notifications.syncReminder();
      return value;
    },
    syncReminder: function () {
      var current = fb && fb.auth && fb.auth.currentUser;
      var value = notifications.reminder();
      if (!current || !fb || !fb.db || !fb.doc || !fb.setDoc) return Promise.resolve(false);
      return Promise.resolve(fb.setDoc(fb.doc(fb.db, 'userReminders', current.uid), {
        userId: current.uid,
        reminderTime: value.on ? value.time : '',
        notifications: value.on,
        platform: 'web',
        timeZone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lusaka'; } catch (e) { return 'Africa/Lusaka'; } })(),
        updatedAt: fb.serverTimestamp ? fb.serverTimestamp() : new Date().toISOString()
      }, { merge: true })).then(function () { return true; }).catch(function () { return false; });
    },
    types: function () { return NOTIF_TYPES; },

    /* A single, honest answer to "why am I not getting notifications?".
       Shown on the account page, so a member can fix it themselves. */
    diagnostics: function () {
      var mode = (window.PDApp && PDApp.app) ? PDApp.app.mode() : 'browser';
      var permission = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
      var out = {
        permission: permission,
        supported: typeof Notification !== 'undefined' && !!navigator.serviceWorker,
        installed: mode === 'standalone' || mode === 'fullscreen' || mode === 'minimal-ui' || mode === 'native',
        displayMode: mode,
        token: localStorage.getItem('pd_push_token') || '',
        tokenSavedAt: Number(localStorage.getItem('pd_push_token_saved') || 0),
        pendingToken: !!localStorage.getItem(PENDING_TOKEN_KEY),
        serviceWorker: 'unknown',
        platform: 'web'
      };
      try {
        if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) out.platform = 'android';
        else if (/iPad|iPhone|iPod/.test(navigator.userAgent || '')) out.platform = 'ios';
      } catch (e) {}
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          out.serviceWorker = reg.active ? 'active' : 'installing';
          out.scope = reg.scope || '';
          document.dispatchEvent(new CustomEvent('pd:notif-diagnostics', { detail: out }));
        }).catch(function () { out.serviceWorker = 'unavailable'; });
      }
      return out;
    },

    /** A real notification on this device, so the member can prove it works. */
    testDevice: function () {
      if (typeof Notification === 'undefined') return Promise.resolve(false);
      var ask = Notification.permission === 'granted'
        ? Promise.resolve('granted')
        : notifications.requestPermission();
      return Promise.resolve(ask).then(function (perm) {
        if (perm !== 'granted') return false;
        var n = {
          id: 'test-' + Date.now(),
          type: 'general',
          title: 'Prayer Dome notifications are on',
          message: 'This is how a verse, live alert or prayer update will appear.',
          link: '/account.html',
          time: new Date().toISOString()
        };
        notifications.notifyDevice(n);
        return true;
      });
    },

    /** Try again to upload a token that was issued before sign-in. */
    flushPendingToken: function () {
      var pending = lsGet(PENDING_TOKEN_KEY, null);
      if (!pending || !pending.token) return Promise.resolve(false);
      var current = fb && fb.auth && fb.auth.currentUser;
      if (!current) return Promise.resolve(false);
      notifications.saveToken(pending.token, current.uid, pending.platform || 'web');
      // A member who allowed notifications before signing in now has a real
      // account: adopt the settings that account already saved elsewhere.
      notifications.loadPreferences();
      notifications.loadReminder();
      return Promise.resolve(true);
    },

    syncBadge: function () {
      var n = notifications.unread();
      var legacy = 0;
      var legacyBadge = $('#notifBadge');
      if (legacyBadge && legacyBadge !== notifications.badgeEl &&
          legacyBadge.style.display !== 'none' && legacyBadge.textContent) {
        legacy = parseInt(legacyBadge.textContent, 10) || 0;
      }
      var total = n + legacy;
      var badge = notifications.badgeEl;
      // Keep the app icon badge (installed PWA) in step with the bell.
      if (navigator.setAppBadge) {
        if (total > 0) navigator.setAppBadge(total).catch(function () {});
        else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
      }
      if (!badge) return;
      if (total > 0) {
        badge.style.display = 'flex';
        badge.textContent = total > 9 ? '9+' : total;
      } else {
        badge.style.display = 'none';
      }
    }
  };

  /* --------------------------------------------------------------- banners */
  var banners = {
    init: function () {
      var hero = $('[data-pd-hero]');
      if (!hero) return;
      var list = (store.get('banners', 'DEFAULT_BANNERS') || []).filter(function (b) { return b && b.active; });
      var now = Date.now();
      var banner = null;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var start = b.scheduleStart ? new Date(b.scheduleStart).getTime() : 0;
        var end = b.scheduleEnd ? new Date(b.scheduleEnd).getTime() : Infinity;
        if (now >= start && now <= end) { banner = b; break; }
      }
      if (!banner) return; // page keeps its static hero
      banners.render(hero, banner);
      on('store:banners', function (e) {
        var next = (e.detail || []).filter(function (b) { return b && b.active; });
        for (var j = 0; j < next.length; j++) {
          var bb = next[j];
          var s = bb.scheduleStart ? new Date(bb.scheduleStart).getTime() : 0;
          var en = bb.scheduleEnd ? new Date(bb.scheduleEnd).getTime() : Infinity;
          if (now >= s && now <= en) { banners.render(hero, bb); return; }
        }
      });
    },
    render: function (hero, banner) {
      var video = banner.type === 'video' && banner.mediaUrl;
      var media = video
        ? '<video class="pd-hero-video" autoplay muted loop playsinline preload="auto" poster="' + esc(banner.poster || '/assets/hero-worship.jpg') + '">' +
          '<source src="' + esc(banner.mediaUrl) + '" type="video/mp4"></video>'
        : '<img class="pd-hero-img pd-kenburns" src="' + esc(banner.mediaUrl || '/assets/hero-worship.jpg') + '" alt="' + esc(banner.headline || 'Prayer Dome') + '">';
      hero.classList.add('pd-hero-managed');
      hero.innerHTML =
        media +
        '<div class="pd-hero-shade"></div>' +
        '<div class="pd-hero-content">' +
          '<img class="pd-hero-logo" src="' + BRAND_LOGO + '" alt="Prayer Dome logo" loading="lazy" onerror="this.remove()">' +
          (banner.badge ? '<span class="pd-hero-badge">' + esc(banner.badge) + '</span>' : '') +
          '<p class="pd-hero-eyebrow pd-brand-mark">Prayer Dome</p>' +
          '<h1 class="pd-hero-headline">' + esc(banner.headline || 'Welcome to Prayer Dome') + '</h1>' +
          (banner.subtext ? '<p class="pd-hero-subtext">' + esc(banner.subtext) + '</p>' : '') +
          (banner.ctaLabel ? '<a class="pd-btn ' + (banner.ctaStyle === 'gold' ? 'pd-btn-gold' : 'pd-btn-dawn') + '" href="' + esc(banner.ctaUrl || '#') + '">' + esc(banner.ctaLabel) + '</a>' : '') +
        '</div>' +
        '<div class="pd-hero-live" id="pdHeroLive" style="display:none"><span class="pd-live-dot"></span> LIVE NOW — Watch</div>';
      // If a live stream is active, show the live pill linking to /live.html
      var st = live.getStatus();
      var isLiveNow = !!(st && (st.isLive || st.live));
      if (isLiveNow) {
        var pill = $('#pdHeroLive', hero);
        if (pill) {
          pill.style.display = 'flex';
          pill.addEventListener('click', function () { window.location.href = '/live.html'; });
        }
      }
    }
  };

  /* ---------------------------------------------------------------- stats */
  var stats = {
    init: function () {
      var els = $$('[data-pd-stat]');
      if (!els.length) return;
      var render = function () {
        var data = store.get('stats', 'DEFAULT_STATS') || {};
        els.forEach(function (el) {
          var key = el.getAttribute('data-pd-stat');
          var map = {
            members: data.members, prayerRequests: data.prayerRequests, testimonies: data.testimonies,
            countriesReached: data.countriesReached, liveViewers: data.liveViewers, prayerGroups: data.prayerGroups
          };
          if (map[key] === undefined) return;
          var target = Number(map[key]) || 0;
          var suffix = el.getAttribute('data-pd-suffix') || '';
          stats.countUp(el, target, suffix);
        });
      };
      render();
      on('store:stats', render);
      on('live', function () { render(); });
      if (fb && fb.db && fb.doc && fb.getDoc) {
        fsGet(fb.doc(fb.db, 'communityStats', 'current'), null).then(function (d) {
          if (d) { store.set('stats', Object.assign(store.get('stats', 'DEFAULT_STATS') || {}, d)); render(); }
        });
      }
    },
    bump: function (key, delta) {
      var data = store.get('stats', 'DEFAULT_STATS') || {};
      data[key] = (Number(data[key]) || 0) + (delta || 1);
      store.set('stats', data);
      if (fb && fb.db && fb.doc && fb.setDoc) {
        var patch = {}; patch[key] = data[key];
        fsSet(fb.doc(fb.db, 'communityStats', 'current'), patch);
      }
      return data[key];
    },
    countUp: function (el, target, suffix) {
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced || !window.requestAnimationFrame) { el.textContent = Number(target).toLocaleString() + suffix; return; }
      var dur = 1100, start = performance.now(), from = 0;
      var step = function (t) {
        var p = Math.min(1, (t - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (target - from) * eased).toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  };

  /* ----------------------------------------------------------------- live */
  var live = {
    _status: lsGet('pd_live_status', null),
    _viewerId: null,
    init: function () {
      // Watch Firestore live status so viewers see admin broadcasts.
      if (fb && fb.db && fb.doc) {
        fsWatch(fb.doc(fb.db, 'liveStatus', 'current'), function (d) {
          if (d) {
            // Normalize: accept both `isLive` (new WebRTC control room) and `live` (legacy)
            if (typeof d.isLive === 'boolean' && typeof d.live !== 'boolean') d.live = d.isLive;
            if (typeof d.live === 'boolean' && typeof d.isLive !== 'boolean') d.isLive = d.live;
            live._status = d; lsSet('pd_live_status', d); broadcast('live', d);
          }
        });
      }
      // Join as a viewer once per tab session.
      live._viewerId = sessionStorage.getItem('pd_viewer_id') || uid('vw');
      sessionStorage.setItem('pd_viewer_id', live._viewerId);
      var s0 = live.getStatus();
      if (s0 && (s0.isLive || s0.live)) live.joinViewer();
      window.addEventListener('beforeunload', function () { live.leaveViewer(); });
      // Keep the viewer count honest: refresh presence and counts every 15s.
      setInterval(function () {
        var sc = live.getStatus();
        if (sc && (sc.isLive || sc.live)) {
          live.ping();
          live.syncViewerCount();
        }
      }, 15000);
    },
    getStatus: function () {
      return live._status;
    },
    setStatus: function (status) {
      live._status = status;
      lsSet('pd_live_status', status);
      if (fb && fb.db && fb.doc && fb.setDoc) {
        var payload = Object.assign({}, status);
        delete payload.viewers;
        fsSet(fb.doc(fb.db, 'liveStatus', 'current'), payload);
      }
      broadcast('live', status);
      return status;
    },
    joinViewer: function () {
      var s = live._status;
      if (!s || (!s.live && !s.isLive)) return;
      var viewers = lsGet('pd_live_viewers', {});
      if (viewers[live._viewerId]) return;
      viewers[live._viewerId] = Date.now();
      lsSet('pd_live_viewers', viewers);
      live.syncViewerCount();
      live.ping();
    },
    leaveViewer: function () {
      var viewers = lsGet('pd_live_viewers', {});
      if (viewers[live._viewerId]) { delete viewers[live._viewerId]; lsSet('pd_live_viewers', viewers); live.syncViewerCount(); }
    },
    syncViewerCount: function () {
      var s = live._status;
      if (!s) return;
      var viewers = lsGet('pd_live_viewers', {});
      // Drop stale entries (> 60s) — keeps the count honest.
      var now = Date.now(), keep = {};
      Object.keys(viewers).forEach(function (k) { if (now - viewers[k] < 60000) keep[k] = viewers[k]; });
      lsSet('pd_live_viewers', keep);
      var count = Object.keys(keep).length;
      var el = $('#pdLiveViewers');
      if (el) el.textContent = count;
      if (fb && fb.db && fb.doc && fb.updateDoc) {
        fb.updateDoc(fb.doc(fb.db, 'liveStatus', 'current'), { viewers: count }).catch(function () {});
      }
      // Emit so the whole app can show it.
      broadcast('viewers', { count: count });
      return count;
    },
    ping: function () {
      var viewers = lsGet('pd_live_viewers', {});
      viewers[live._viewerId] = Date.now();
      lsSet('pd_live_viewers', viewers);
    },
    comments: function () { return lsGet('pd_live_comments', []); },
    addComment: function (name, text) {
      var c = { id: uid('c'), name: name || 'Guest', text: text, time: new Date().toISOString() };
      var list = live.comments();
      list.push(c);
      lsSet('pd_live_comments', list.slice(-200));
      broadcast('live:comment', c);
      if (fb && fb.db && fb.collection && fb.addDoc && fb.serverTimestamp) {
        fb.addDoc(fb.collection(fb.db, 'liveChat'), Object.assign({}, c, { createdAt: fb.serverTimestamp() })).catch(function () {});
      }
      return c;
    },
    reactions: function () { return lsGet('pd_live_reactions', {}); },
    addReaction: function (emoji) {
      var r = live.reactions();
      r[emoji] = (r[emoji] || 0) + 1;
      lsSet('pd_live_reactions', r);
      broadcast('live:reaction', { emoji: emoji });
      return r;
    },
    addPrayerRequest: function (text) {
      var p = { id: uid('pray'), text: text, time: new Date().toISOString() };
      var list = live.prayerRequests();
      list.push(p);
      lsSet('pd_live_prayers', list.slice(-100));
      broadcast('live:prayer', p);
      if (fb && fb.db && fb.collection && fb.addDoc && fb.serverTimestamp) {
        fb.addDoc(fb.collection(fb.db, 'livePrayers'), Object.assign({}, p, { createdAt: fb.serverTimestamp() })).catch(function () {});
      }
      return p;
    },
    prayerRequests: function () { return lsGet('pd_live_prayers', []); },
    schedule: function () { return lsGet('pd_live_schedule', []); },
    addScheduled: function (item) {
      var list = live.schedule();
      list.push(Object.assign({ id: uid('sched') }, item));
      lsSet('pd_live_schedule', list);
      broadcast('live:schedule', list);
      return list;
    },
    /* Replays are cloud recordings only. Any legacy `blob:` entry (a replay
       that lived in the browser's memory on one device) is dropped so members
       never see a broken "Play" that only worked for the person who recorded
       it — every recording now streams from Prayer Dome cloud storage. */
    isCloudUrl: function (url) {
      return typeof url === 'string' && /^https?:\/\//i.test(url) && !/^blob:/i.test(url);
    },
    replays: function () {
      var list = lsGet('pd_live_replays', []);
      var cloudOnly = list.filter(function (r) {
        return r && (live.isCloudUrl(r.url) || live.isCloudUrl(r.playbackUrl) ||
          (Array.isArray(r.parts) && r.parts.length && live.isCloudUrl(r.parts[0] && r.parts[0].url)));
      });
      if (cloudOnly.length !== list.length) lsSet('pd_live_replays', cloudOnly);
      return cloudOnly;
    },
    addReplay: function (item) {
      item = item || {};
      var url = item.url || item.playbackUrl ||
        (Array.isArray(item.parts) && item.parts[0] ? item.parts[0].url : null);
      if (!live.isCloudUrl(url)) {
        // Refuse device-local recordings — they must be uploaded to the cloud.
        console.warn('[PDApp] Ignoring a non-cloud replay URL; recordings must live in cloud storage.');
        return live.replays();
      }
      var list = live.replays();
      list.unshift(Object.assign({ id: uid('rec'), storage: 'cloud' }, item, { url: url }));
      lsSet('pd_live_replays', list.slice(0, 30));
      broadcast('live:replay', list);
      return list;
    }
  };

  /* ------------------------------------------------------------------ news */
  var news = {
    list: function () {
      return (store.get('news', 'DEFAULT_NEWS') || [])
        .filter(function (n) { return n && n.published; })
        .slice()
        .sort(function (a, b) {
          var at = new Date(a.date || a.createdAt || 0).getTime() || 0;
          var bt = new Date(b.date || b.createdAt || 0).getTime() || 0;
          return bt - at;   // newest first, every page
        });
    },
    get: function (id) {
      var all = store.get('news', 'DEFAULT_NEWS') || [];
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return null;
    },
    publish: function (item) {
      var all = store.get('news', 'DEFAULT_NEWS') || [];
      var n = Object.assign({ id: item.id || uid('news'), date: item.date || new Date().toISOString(), published: true }, item);
      var idx = -1;
      for (var i = 0; i < all.length; i++) if (all[i].id === n.id) idx = i;
      if (idx >= 0) all[idx] = n; else all.unshift(n);
      store.set('news', all);
      var write = Promise.resolve(false);
      if (fb && fb.db && fb.collection && fb.serverTimestamp) {
        var payload = Object.assign({}, n, {
          id: n.id,
          featuredImage: n.featuredImage || n.image || '',
          socialImage: n.socialImage || n.featuredImage || n.image || '',
          updatedAt: fb.serverTimestamp()
        });
        delete payload.sync;
        if (fb.setDoc && fb.doc) {
          if (!payload.createdAt) payload.createdAt = fb.serverTimestamp();
          write = fb.setDoc(fb.doc(fb.db, 'news', n.id), payload, { merge: true })
            .then(function () { return true; }).catch(function () { return false; });
        } else if (fb.addDoc) {
          payload.createdAt = fb.serverTimestamp();
          write = fb.addDoc(fb.collection(fb.db, 'news'), payload)
            .then(function () { return true; }).catch(function () { return false; });
        }
      }
      // A non-enumerable handle lets the admin console wait for the Firestore
      // write before it re-reads the collection (otherwise a fast refresh can
      // show the old title for a second). It is invisible to JSON/storage.
      try { Object.defineProperty(n, 'sync', { value: write, enumerable: false, configurable: true }); } catch (e) {}
      broadcast('news', n);
      return n;
    },
    update: function (id, patch) {
      var existing = news.get(id);
      if (!existing) return null;
      return news.publish(Object.assign({}, existing, patch || {}, { id: id }));
    },
    remove: function (id) {
      var all = store.get('news', 'DEFAULT_NEWS') || [];
      store.set('news', all.filter(function (n) { return n.id !== id; }));
      // Deleting the card locally is not enough: the News Centre listens to the
      // Firestore collection, so without this the story came straight back on
      // the next snapshot. Use deleteDoc when the page supplied it.
      if (fb && fb.db && fb.doc && fb.deleteDoc) {
        try { fb.deleteDoc(fb.doc(fb.db, 'news', id)).catch(function () {}); } catch (e) {}
      }
      broadcast('news:remove', { id: id });
    }
  };

  /* ------------------------------------------------------------- scripture */
  var scripture = {
    render: function (el) {
      if (!el) return;
      var theme = (window.PD_CONTENT || {}).THEME_SCRIPTURE || {};
      var v = theme.versions && theme.versions[lang];
      var ref = v ? v.verse : (theme.verse || 'Mark 7:37');
      var text = v ? v.theme : (theme.theme || '');
      var cls = el.getAttribute('data-pd-scripture-style') || 'default';
      if (cls === 'bare') {
        el.innerHTML = '<span class="pd-scripture-text">"' + esc(text) + '"</span><span class="pd-scripture-ref">' + esc(ref) + '</span>';
        return;
      }
      el.innerHTML =
        '<div class="pd-scripture-card">' +
          '<div class="pd-scripture-icon"><i class="pd-i pd-i-book"></i></div>' +
          '<p class="pd-scripture-kicker">' + esc(i18n.t('scripture.featured')) + '</p>' +
          '<blockquote class="pd-scripture-text">“' + esc(text) + '”</blockquote>' +
          '<p class="pd-scripture-ref">— ' + esc(ref) + '</p>' +
          '<p class="pd-scripture-verse">' + esc(theme.text || '') + '</p>' +
        '</div>';
    },
    init: function () {
      $$('[data-pd-scripture]').forEach(function (el) { scripture.render(el); });
      document.addEventListener('pd:lang', function () {
        $$('[data-pd-scripture]').forEach(function (el) { scripture.render(el); });
      });
    }
  };

  /* ---------------------------------------------------------------- radio */
  var radio = {
    audio: null,
    playing: false,
    _bound: false,
    init: function () {
      if (!radio._bound) {
        // Delegated binding — safe to re-render the grid and call init() again.
        document.addEventListener('click', function (e) {
          var btn = e.target.closest ? e.target.closest('[data-pd-radio]') : null;
          if (!btn) return;
          var url = btn.getAttribute('data-pd-radio');
          var name = btn.getAttribute('data-pd-radio-name') || 'Prayer Dome Radio';
          radio.toggle(url, name, btn);
        });
        radio._bound = true;
      }
      document.addEventListener('pd:radio', function (e) {
        var d = e.detail || {};
        var btn = $('[data-pd-radio="' + d.url + '"]');
        radio.toggle(d.url, d.name || 'Prayer Dome Radio', btn);
      });
    },
    toggle: function (url, name, btn) {
      if (!radio.audio) radio.audio = new Audio();
      if (radio.playing && radio.audio.src.split('?')[0] === url.split('?')[0]) {
        radio.audio.pause();
        radio.playing = false;
        if (btn) btn.classList.remove('pd-radio-playing');
        var icon = btn && btn.querySelector('i');
        if (icon) icon.className = 'pd-i pd-i-play';
        var indicator = $('#pdRadioNow');
        if (indicator) indicator.style.display = 'none';
        broadcast('radio:stopped', { url: url });
        return;
      }
      radio.audio.src = url;
      radio.audio.play().then(function () {
        radio.playing = true;
        $$('[data-pd-radio]').forEach(function (b) {
          b.classList.remove('pd-radio-playing');
          var ic = b.querySelector('i');
          if (ic) ic.className = 'pd-i pd-i-play';
        });
        if (btn) {
          btn.classList.add('pd-radio-playing');
          var icon2 = btn.querySelector('i');
          if (icon2) icon2.className = 'pd-i pd-i-pause';
        }
        var indicator = $('#pdRadioNow');
        if (indicator) {
          indicator.style.display = 'flex';
          indicator.innerHTML = '<span class="pd-live-dot"></span> Now playing: ' + esc(name);
        }
        broadcast('radio:playing', { url: url, name: name });
      }).catch(function () {
        toast('Unable to play this stream. Check the station URL in the Admin Dashboard.', 'error');
      });
    },
    stop: function () {
      if (radio.audio) radio.audio.pause();
      radio.playing = false;
      var indicator = $('#pdRadioNow');
      if (indicator) indicator.style.display = 'none';
    }
  };

  /* ----------------------------------------------------------------- share
   * Social sharing that always carries the featured image, the content title,
   * a short description and Prayer Dome branding.
   *
   * Every shared link points at /share/<type>/<id>, which is answered by the
   * share function (functions/share.js). That endpoint renders real Open Graph
   * tags — og:image, og:title, og:description, og:site_name — then forwards a
   * human straight to the page. WhatsApp, Facebook, X, Telegram and iMessage
   * all read those tags, so the preview card is correct everywhere.
   * ---------------------------------------------------------------------- */
  var SHARE_ORIGIN = 'https://prayerdome.net';
  var SHARE_TYPES = {
    news: 'news', story: 'news', article: 'news',
    testimony: 'testimony', testimonies: 'testimony',
    sermon: 'sermon', sermons: 'sermon',
    devotional: 'devotional', devotionals: 'devotional',
    prayer: 'prayer', prayers: 'prayer',
    event: 'event', events: 'event',
    video: 'video', aivideo: 'video'
  };

  var share = {
    /** Canonical, preview-friendly link for a piece of content. */
    url: function (type, id) {
      var kind = SHARE_TYPES[String(type || '').toLowerCase()] || 'news';
      if (!id) return SHARE_ORIGIN + '/';
      return SHARE_ORIGIN + '/share/' + kind + '/' + encodeURIComponent(String(id));
    },

    /** A short branded blurb to accompany the link. */
    text: function (opts) {
      opts = opts || {};
      var title = String(opts.title || 'Prayer Dome').trim();
      var desc = String(opts.description || '').replace(/\s+/g, ' ').trim();
      if (desc.length > 160) desc = desc.slice(0, 159).trim() + '…';
      return desc ? (title + '\n\n' + desc + '\n\n— Prayer Dome') : (title + '\n\n— Prayer Dome');
    },

    /**
     * Share a piece of content. Uses the device share sheet when available
     * (Android/iOS/Chrome), otherwise falls back to copying the link.
     */
    open: function (opts) {
      opts = opts || {};
      var link = opts.url || share.url(opts.type, opts.id);
      var body = share.text(opts);
      if (navigator.share) {
        return navigator.share({ title: opts.title || 'Prayer Dome', text: body, url: link })
          .catch(function () { /* the member dismissed the sheet */ });
      }
      return share.copy(link);
    },

    /** Copy a link to the clipboard and confirm it quietly. */
    copy: function (link) {
      var done = function () { toast('Link copied — it will preview with the image and title.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(link).then(done).catch(function () { window.prompt('Copy this link', link); });
      }
      window.prompt('Copy this link', link);
      return Promise.resolve();
    },

    /** Per-network share links, for pages that render their own buttons. */
    links: function (opts) {
      opts = opts || {};
      var link = opts.url || share.url(opts.type, opts.id);
      var body = share.text(opts);
      var u = encodeURIComponent(link);
      var t = encodeURIComponent(body);
      return {
        url: link,
        whatsapp: 'https://wa.me/?text=' + encodeURIComponent(body + '\n' + link),
        facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u,
        x: 'https://twitter.com/intent/tweet?text=' + t + '&url=' + u,
        telegram: 'https://t.me/share/url?url=' + u + '&text=' + t,
        email: 'mailto:?subject=' + encodeURIComponent(opts.title || 'Prayer Dome') + '&body=' + encodeURIComponent(body + '\n\n' + link)
      };
    },

    /** Render a consistent row of share buttons into a container. */
    buttons: function (container, opts) {
      var host = (typeof container === 'string') ? $(container) : container;
      if (!host) return;
      var l = share.links(opts);
      host.classList.add('pd-share-row');
      host.innerHTML =
        '<a class="pd-share-btn pd-share-wa" target="_blank" rel="noopener" href="' + l.whatsapp + '"><i class="pd-i pd-i-brand-whatsapp"></i> WhatsApp</a>' +
        '<a class="pd-share-btn pd-share-fb" target="_blank" rel="noopener" href="' + l.facebook + '"><i class="pd-i pd-i-brand-facebook"></i> Facebook</a>' +
        '<a class="pd-share-btn pd-share-x" target="_blank" rel="noopener" href="' + l.x + '"><i class="pd-i pd-i-brand-x"></i> X</a>' +
        '<a class="pd-share-btn pd-share-tg" target="_blank" rel="noopener" href="' + l.telegram + '"><i class="pd-i pd-i-brand-telegram"></i> Telegram</a>' +
        '<button type="button" class="pd-share-btn pd-share-copy"><i class="pd-i pd-i-link"></i> Copy link</button>';
      var copyBtn = host.querySelector('.pd-share-copy');
      if (copyBtn) copyBtn.addEventListener('click', function () { share.copy(l.url); });
    }
  };

  /* -------------------------------------------------------------- founder
   * The founder's official signature/name/title used on every certificate.
   * Source of truth: Firestore `settings/founder` (admin-managed). Fallbacks:
   * localStorage cache → window.PD_FOUNDER (page-injected) → defaults.
   */
  var founder = {
    DOC: 'settings/founder',
    getLocal: function () {
      return lsGet('pd_founder', null);
    },
    setLocal: function (data) {
      lsSet('pd_founder', data || null);
      try {
        var meta = document.querySelector('meta[name="pd-founder-signature"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'pd-founder-signature';
          document.head.appendChild(meta);
        }
        meta.content = (data && data.signatureUrl) || '';
      } catch (e) {}
      broadcast('founder:update', data);
      return data;
    },
    get: function () {
      var local = founder.getLocal();
      if (local && (local.signatureUrl || local.founderName)) return local;
      var inj = window.PD_FOUNDER;
      if (inj && (inj.signatureUrl || inj.founderName)) return inj;
      return { signatureUrl: '', founderName: '', founderTitle: 'Founder' };
    },
    refresh: function () {
      return founder.fetch().then(function (d) {
        if (d && d.signatureUrl) founder.setLocal(d);
        return founder.get();
      });
    },
    fetch: function () {
      if (!fb || !fb.doc || !fb.getDoc) return Promise.resolve(null);
      try {
        var ref = fb.doc(fb.db, 'settings', 'founder');
        return fb.getDoc(ref).then(function (snap) {
          return (snap && snap.exists && snap.exists()) ? snap.data() : null;
        }).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    save: function (data) {
      founder.setLocal(data);
      if (fb && fb.doc && fb.setDoc) {
        try {
          var ref = fb.doc(fb.db, 'settings', 'founder');
          fb.setDoc(ref, {
            founderName: data.founderName || '',
            founderTitle: data.founderTitle || 'Founder',
            signatureUrl: data.signatureUrl || '',
            updatedAt: new Date().toISOString(),
            updatedBy: (fb.auth && fb.auth.currentUser && fb.auth.currentUser.email) || ''
          }, { merge: true }).catch(function () {});
        } catch (e) {}
      }
      return data;
    },
    loadFounderSignature: function () {
      // Called by the certificate renderer: resolve the best-known signature
      // data, refreshing from Firestore when signed in. Never throws.
      return new Promise(function (resolve) {
        try {
          if (fb && fb.auth && fb.auth.currentUser) {
            founder.fetch().then(function (d) {
              if (d && d.signatureUrl) founder.setLocal(d);
              resolve(founder.get());
            }).catch(function () { resolve(founder.get()); });
            return;
          }
        } catch (e) {}
        resolve(founder.get());
      });
    }
  };

  /* ------------------------------------------------- consistent header/footer
   * Every page must share the same premium Prayer Dome header and footer.
   * This module auto-injects a consistent topbar/drawer/footer if missing,
   * and normalizes the navigation so the structure is identical across all pages.
   * Keeps brand colors #0A4D9B / #d4af37 and the official logo only.
   * --------------------------------------------------------------- */
  var layout = {
    HEADER_HTML: ''
      + '<button class="pd-menu-btn" id="pdMenuBtn" aria-label="Open menu"><i class="pd-i pd-i-menu"></i></button>'
      + '<a href="/" class="pd-topbar-center" aria-label="PrayerDome home"><div class="pd-topbar-logo"><img src="/assets/logo.png" alt="PrayerDome logo"></div></a>'
      + '<div class="pd-topbar-right">'
      + '<button class="pd-bell-btn" id="pdNotifBell" aria-label="Notifications"><i class="pd-i pd-i-bell"></i><span class="pd-bell-badge" id="pdNotifBadge" style="display:none;">0</span></button>'
      + '</div>',
    /* The global menu itself is NOT defined here any more: it lives in
       assets/pd-nav.js so there is exactly one list to maintain. `d` is a thin
       reader so older call sites (and the footer) keep working. */
    drawerLinks: function () {
      if (window.PDNav && window.PDNav.all) {
        return window.PDNav.all().map(function (item) {
          return { href: item.href, icon: 'pd-i-' + item.icon, label: item.label };
        });
      }
      return [];
    },
    /* The footer repeats the primary destinations, read from the same config
       as the bottom bar so the two can never disagree. */
    FOOTER_LINKS_HTML: function () {
      var items = (window.PDNav && window.PDNav.BOTTOM) || [];
      if (!items.length) return '';
      return items.map(function (item) {
        return '<a href="' + item.href + '">' + esc(item.label) + '</a>';
      }).join('');
    },
    FOOTER_HTML: ''
      + '<div class="pd-footer-logo"><img src="/assets/logo.png" alt="Prayer Dome"><span class="pd-footer-brand">PRAYER DOME</span></div>'
      + '<div class="pd-footer-nav"><a href="/">Home</a><a href="/bible">Bible</a><a href="/lessons">Teachings</a><a href="/game">Play with Domey</a><a href="/quiz">Quizzes</a><a href="/prayer">Prayer Wall</a><a href="/account">My Account</a></div>'
      + '<p class="pd-footer-copy">© 2018 PRAYER DOME MINISTRY. ALL RIGHTS RESERVED. · A House of Prayer for All Nations</p>',
    /* Full-screen application shells run their own chrome.
     *
     * The admin console is a horizontal flex row (`body { display:flex }`:
     * sidebar + content). Injecting the marketing header/drawer/footer there
     * added a second navigation column and a second hamburger menu, which
     * pushed the console content off-screen and made menu clicks land on the
     * wrong menu. Any such shell opts out with <html data-pd-layout="none">
     * (`data-pd-sw="off"` skips only the service worker) and the shared layer
     * stays out of its way. Marketing pages keep the header, drawer and footer
     * they always had. */
    enabled: function(){
      try {
        var root = document.documentElement;
        var body = document.body;
        if (root && root.getAttribute('data-pd-layout') === 'none') return false;
        if (body && body.getAttribute('data-pd-layout') === 'none') return false;
        if (body && body.classList.contains('pd-app-shell')) return false;
        // Defensive path check: /admin and /admin.html are the console.
        if (/\/admin(\.html)?$/i.test((window.location.pathname || '').replace(/\/+$/, ''))) return false;
      } catch (e) {}
      return true;
    },
    ensure: function(){
      if (!layout.enabled()) return;
      try {
        // Ensure topbar exists
        var topbar = document.querySelector('.pd-topbar');
        if(!topbar){
          topbar = document.createElement('header');
          topbar.className='pd-topbar';
          topbar.innerHTML = layout.HEADER_HTML;
          document.body.insertBefore(topbar, document.body.firstChild);
        } else {
          // Normalize existing topbar content: notifications only. Any stale
          // language picker is removed so no page can resurrect it.
          var staleLang = topbar.querySelector('.pd-lang-select');
          if (staleLang && staleLang.parentNode) staleLang.parentNode.removeChild(staleLang);
          if(!topbar.querySelector('#pdNotifBell')){
            // Keep existing but ensure the right side has the bell.
            var right = topbar.querySelector('.pd-topbar-right');
            if(!right){
              right=document.createElement('div'); right.className='pd-topbar-right'; topbar.appendChild(right);
            }
            if(!right.querySelector('#pdNotifBell')){
              var bell=document.createElement('button'); bell.className='pd-bell-btn'; bell.id='pdNotifBell'; bell.setAttribute('aria-label','Notifications');
              bell.innerHTML='<i class="pd-i pd-i-bell"></i><span class="pd-bell-badge" id="pdNotifBadge" style="display:none;">0</span>';
              right.appendChild(bell);
            }
          }
        }
        // The drawer is rendered by assets/pd-nav.js from the one menu config.
        // This layer only guarantees the element exists, so a page that was
        // added without one still gets the same menu as every other route.
        var drawer = document.getElementById('pdDrawer') || document.querySelector('.pd-drawer');
        if(!drawer){
          var overlay = document.getElementById('pdDrawerOverlay');
          drawer=document.createElement('aside'); drawer.className='pd-drawer'; drawer.id='pdDrawer';
          drawer.setAttribute('aria-label','Main menu');
          if (overlay) document.body.insertBefore(drawer, overlay.nextSibling);
          else document.body.insertBefore(drawer, document.body.firstChild);
        }
        if (window.PDNav) {
          try { window.PDNav.hydrateDrawer(drawer); window.PDNav.hydrateBottomNav(); } catch (e) { /* keep page markup */ }
        }
        // Ensure footer exists
        var footer = document.querySelector('.pd-footer');
        if(!footer){
          footer=document.createElement('footer'); footer.className='pd-footer';
          footer.innerHTML = layout.FOOTER_HTML;
          var freshNav = footer.querySelector('.pd-footer-nav');
          if (freshNav && layout.FOOTER_LINKS_HTML()) freshNav.innerHTML = layout.FOOTER_LINKS_HTML();
          document.body.appendChild(footer);
        } else {
          // The footer repeats the primary destinations; keep it in step with
          // the one navigation config instead of a second hand-written list.
          var navF = footer.querySelector('.pd-footer-nav');
          if(navF){
            navF.innerHTML = layout.FOOTER_LINKS_HTML();
          }
        }
      } catch(e){}
    },
    init: function(){ layout.ensure(); }
  };

  /* ------------------------------------------------------- installed app shell
   * The difference between "a website in a browser tab" and "the Prayer Dome
   * app" is almost entirely chrome: the URL bar, the browser's own splash, the
   * rubber-band scroll and the white flash between pages. None of that can be
   * scripted away inside a tab — browsers forbid it — but every one of them is
   * gone the moment the app is opened from the home screen in standalone mode.
   * This module makes that installed experience feel like one native app:
   *
   *   • the app's own name, icon, status-bar colour and splash, never Chrome's;
   *   • no rubber-band / pull-to-refresh bounce, no scrollbars, no tap delays;
   *   • safe-area padding on notched phones (the header clears the notch);
   *   • an optional true full-screen mode for members who want zero system UI;
   *   • one clear, branded install invitation for anyone still in a tab.
   *
   * It is deliberately inert in the admin console (which runs its own shell)
   * and on browsers without the APIs — the page always works.
   * --------------------------------------------------------------- */
  var appShell = {
    CSS: ''
      + '@supports (padding: max(0px)){body.pd-app-mode{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}}'
      + 'html.pd-app-mode{overscroll-behavior-y:none;background:#07244d;}'
      + 'body.pd-app-mode{overscroll-behavior-y:none;-webkit-overflow-scrolling:touch;}'
      + 'body.pd-app-mode ::-webkit-scrollbar{width:0;height:0;}'
      + 'body.pd-app-mode .pd-topbar{padding-top:max(10px,env(safe-area-inset-top));}'
      + 'body.pd-app-mode .pd-drawer{padding-top:max(18px,env(safe-area-inset-top));}'
      + 'body.pd-app-mode .pd-footer{padding-bottom:max(20px,env(safe-area-inset-bottom));}'
      + 'body.pd-app-mode a,body.pd-app-mode button,body.pd-app-mode [role="button"]{touch-action:manipulation;}'
      + 'body.pd-app-mode .pd-topbar,body.pd-app-mode .pd-drawer,body.pd-app-mode .pd-footer{-webkit-user-select:none;user-select:none;}'
      + 'body.pd-fullscreen .pd-topbar{padding-top:max(8px,env(safe-area-inset-top));}'
      + '#pdAppSplash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;gap:18px;background:radial-gradient(ellipse 80% 60% at 50% 38%,rgba(212,175,55,.24),transparent 58%),linear-gradient(160deg,#0a3d7a 0%,#0A4D9B 48%,#07244d 100%);'
      + 'color:#fff;transition:opacity .42s ease,visibility .42s ease;font-family:Poppins,Inter,sans-serif;text-align:center;padding:32px;}'
      + '#pdAppSplash.pd-splash-out{opacity:0;visibility:hidden;pointer-events:none;}'
      + '#pdAppSplash img{width:104px;height:104px;border-radius:26px;background:rgba(255,255,255,.96);padding:10px;box-shadow:0 18px 50px rgba(0,0,0,.34);}'
      + '#pdAppSplash .pd-splash-name{font-size:1.18rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;}'
      + '#pdAppSplash .pd-splash-tag{font-size:.78rem;color:rgba(255,255,255,.78);letter-spacing:.04em;margin-top:-8px;}'
      + '#pdAppSplash .pd-splash-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#d4af37;margin:0 4px;animation:pdSplashPulse 1.25s ease-in-out infinite;}'
      + '#pdAppSplash .pd-splash-dot:nth-child(2){animation-delay:.16s}#pdAppSplash .pd-splash-dot:nth-child(3){animation-delay:.32s}'
      + '@keyframes pdSplashPulse{0%,80%,100%{opacity:.28;transform:translateY(0)}40%{opacity:1;transform:translateY(-4px)}}'
      + 'body.pd-installed .pd-install-only{display:none!important;}'
      + '@media (prefers-reduced-motion:reduce){#pdAppSplash .pd-splash-dot{animation:none;opacity:.8}}',
    mode: function () {
      try {
        if (pwa && pwa.isNativeApp()) return 'native';
        var modes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
        for (var i = 0; i < modes.length; i += 1) {
          if (window.matchMedia && window.matchMedia('(display-mode: ' + modes[i] + ')').matches) return modes[i];
        }
        if (navigator.standalone === true) return 'standalone';
      } catch (e) {}
      return 'browser';
    },
    installed: function () {
      var mode = appShell.mode();
      return mode === 'standalone' || mode === 'fullscreen' || mode === 'minimal-ui' || mode === 'native';
    },
    ensureMeta: function () {
      var metas = {
        'application-name': 'Prayer Dome',
        'mobile-web-app-capable': 'yes',
        'apple-mobile-web-app-capable': 'yes',
        'apple-mobile-web-app-title': 'Prayer Dome',
        'apple-mobile-web-app-status-bar-style': 'black-translucent',
        'format-detection': 'telephone=no',
        'theme-color': '#0A4D9B'
      };
      Object.keys(metas).forEach(function (name) {
        var el = document.querySelector('meta[name="' + name + '"]');
        if (!el) {
          el = document.createElement('meta');
          el.setAttribute('name', name);
          document.head.appendChild(el);
        }
        if (!el.getAttribute('content')) el.setAttribute('content', metas[name]);
      });
      var touch = document.querySelector('link[rel="apple-touch-icon"]');
      if (!touch) {
        touch = document.createElement('link');
        touch.rel = 'apple-touch-icon';
        document.head.appendChild(touch);
      }
      // An apple-touch-icon has to be same-origin to be picked up by iOS when
      // the app is added to the home screen. Old pages pointed at the live host.
      try { touch.href = '/assets/logo.png'; } catch (e) {}
    },
    injectStyles: function () {
      if (document.getElementById('pdAppShellStyles')) return;
      var style = document.createElement('style');
      style.id = 'pdAppShellStyles';
      style.textContent = appShell.CSS;
      document.head.appendChild(style);
    },
    splash: function () {
      if (!appShell.installed()) return;
      if (document.getElementById('pdAppSplash')) return;
      try {
        if (sessionStorage.getItem('pd_splash_seen') === '1') return;
        sessionStorage.setItem('pd_splash_seen', '1');
      } catch (e) {}
      var el = document.createElement('div');
      el.id = 'pdAppSplash';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-label', 'Prayer Dome is opening');
      el.innerHTML = '<img src="' + BRAND_LOGO + '" alt="" width="104" height="104">'
        + '<div class="pd-splash-name">Prayer Dome</div>'
        + '<div class="pd-splash-tag">A House of Prayer for All Nations</div>'
        + '<div aria-hidden="true"><span class="pd-splash-dot"></span><span class="pd-splash-dot"></span><span class="pd-splash-dot"></span></div>';
      document.body.appendChild(el);
      var hide = function () {
        if (!el || el.classList.contains('pd-splash-out')) return;
        el.classList.add('pd-splash-out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 460);
      };
      window.addEventListener('load', function () { setTimeout(hide, 260); });
      setTimeout(hide, 2600);
    },
    setBadge: function (count) {
      try {
        if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count);
        else if (navigator.clearAppBadge) navigator.clearAppBadge();
      } catch (e) {}
    },
    fullscreenSupported: function () {
      try {
        var el = document.documentElement;
        return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen);
      } catch (e) { return false; }
    },
    isFullscreen: function () {
      try { return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement); }
      catch (e) { return false; }
    },
    enterFullscreen: function () {
      var el = document.documentElement;
      var request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (!request) return Promise.resolve(false);
      try {
        var result = request.call(el, { navigationUI: 'hide' });
        return Promise.resolve(result).then(function () { return true; }).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    },
    exitFullscreen: function () {
      var exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (!exit) return Promise.resolve(false);
      try { return Promise.resolve(exit.call(document)).then(function () { return true; }).catch(function () { return false; }); }
      catch (e) { return Promise.resolve(false); }
    },
    toggleFullscreen: function () {
      return appShell.isFullscreen() ? appShell.exitFullscreen() : appShell.enterFullscreen();
    },
    init: function () {
      try {
        appShell.ensureMeta();
        if (layout.enabled()) appShell.injectStyles();
        var mode = appShell.mode();
        var root = document.documentElement;
        root.setAttribute('data-pd-display', mode);
        if (appShell.installed()) {
          document.body.classList.add('pd-app-mode');
          document.body.classList.add('pd-installed');
          if (mode === 'fullscreen') document.body.classList.add('pd-fullscreen');
          appShell.splash();
        }
        // A member who installed the app should hear about it exactly once.
        window.addEventListener('appinstalled', function () {
          document.body.classList.add('pd-installed');
          document.dispatchEvent(new CustomEvent('pd:installed'));
        });
        // Keep the standalone styling correct when a tab is promoted to the
        // app (Chrome applies the display mode without a reload in some flows).
        if (window.matchMedia) {
          ['(display-mode: standalone)', '(display-mode: fullscreen)'].forEach(function (query) {
            try {
              var mq = window.matchMedia(query);
              var apply = function () { if (mq.matches) document.body.classList.add('pd-app-mode', 'pd-installed'); };
              apply();
              if (mq.addEventListener) mq.addEventListener('change', apply);
              else if (mq.addListener) mq.addListener(apply);
            } catch (e) {}
          });
        }
      } catch (e) { /* the page must never break because of the shell */ }
    }
  };

  /* --------------------------------------------------------------- PWA glue
   * One place that keeps the installable-app contract working on *every*
   * page (the marketing pages, the member account and the admin console):
   *   • registers the offline worker (/sw.js) that precaches the shell,
   *   • caches the install prompt so a page can offer "Install app",
   *   • reports the installed state so pages can hide install buttons.
   * Registration is idempotent and harmless when service workers, the install
   * prompt or the whole API are unavailable (older WebViews, jsdom, private
   * windows). Pages can opt out with <html data-pd-sw="off">.
   * --------------------------------------------------------------- */
  var pwa = {
    _deferred: null,
    supported: function () {
      try { return typeof navigator !== 'undefined' && 'serviceWorker' in navigator; }
      catch (e) { return false; }
    },
    // The packaged Android app already ships every asset locally, so it has
    // nothing to gain from a worker — and a worker must never sit between the
    // WebView and the Capacitor bridge.
    isNativeApp: function () {
      try {
        var cap = window.Capacitor;
        if (!cap) return false;
        if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
        return cap.isNative === true || (cap.platform && cap.platform !== 'web');
      } catch (e) { return false; }
    },
    installed: function () {
      try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.matchMedia && window.matchMedia('(display-mode: minimal-ui)').matches) return true;
        if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
        return navigator.standalone === true;
      } catch (e) { return false; }
    },
    register: function () {
      try {
        if (!pwa.supported()) return Promise.resolve(null);
        var root = document.documentElement;
        if (root && root.getAttribute('data-pd-sw') === 'off') return Promise.resolve(null);
        if (pwa.isNativeApp()) return Promise.resolve(null);
        // Only http(s) origins can own a service worker (file:// cannot).
        // Use window.location: the local `location` module below shadows the
        // global inside this closure (a bug that silently disabled the worker).
        if (!/^https?:$/.test(window.location.protocol)) return Promise.resolve(null);
        return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
          // Ask for a fresh worker on every load (and when the app returns to
          // the foreground) so a merged deploy is picked up without waiting for
          // the browser's own 24-hour check. The worker calls skipWaiting(), so
          // an update activates as soon as it is downloaded.
          var check = function () { try { reg.update(); } catch (e) {} };
          setTimeout(check, 2500);
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) check();
          });
          pwa.watchUpdate(reg);
          return reg;
        }).catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    },
    /* A small, dismissible bar instead of a silent stale screen. It only
       appears when a *new* worker is waiting behind the running one. */
    watchUpdate: function (reg) {
      if (!reg) return;
      var offer = function (worker) {
        if (!worker || !navigator.serviceWorker.controller) return;
        if (document.getElementById('pdUpdateBar')) return;
        var bar = document.createElement('div');
        bar.id = 'pdUpdateBar';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:12px;max-width:560px;margin:0 auto;padding:12px 14px;border-radius:16px;background:#07244d;color:#fff;box-shadow:0 18px 42px rgba(7,36,77,.35);font:600 13px/1.4 system-ui,sans-serif;';
        bar.innerHTML = '<i class="pd-i pd-i-refresh-cw" style="color:#f6df8a;font-size:18px;" aria-hidden="true"></i>' +
          '<span style="flex:1;">A new Prayer Dome update is ready.</span>' +
          '<button type="button" style="border:0;border-radius:10px;padding:8px 13px;background:#f6df8a;color:#07244d;font:800 12px system-ui,sans-serif;cursor:pointer;">Refresh</button>' +
          '<button type="button" aria-label="Dismiss" style="border:0;background:transparent;color:#cbd5e1;font-size:18px;cursor:pointer;padding:0 2px;">&times;</button>';
        var buttons = bar.querySelectorAll('button');
        buttons[0].addEventListener('click', function () {
          buttons[0].textContent = 'Updating…';
          buttons[0].disabled = true;
          try { worker.postMessage('SKIP_WAITING'); } catch (e) {}
          // controllerchange reloads; this is a safety net for browsers that
          // do not fire it promptly.
          setTimeout(function () { window.location.reload(); }, 1800);
        });
        buttons[1].addEventListener('click', function () { bar.remove(); });
        document.body.appendChild(bar);
      };
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function () {
          if (worker.state === 'installed') offer(worker);
        });
      });
      // Do not reload on our own: a member may be mid-prayer or mid-form. The
      // bar's Refresh button reloads once the new worker has taken over.
    },
    installPrompt: function () { return pwa._deferred; },
    /* A dismissible "Add Prayer Dome to your home screen" card for pages that
       reserve the slot with <div data-pd-install-banner></div>. Chrome, Edge
       and Android offer an install prompt; iOS Safari never does, so the
       Share → Add to Home Screen step is explained there instead. Dismissing
       the card is remembered on the device and an installed app never shows
       it, so a first visit is the only time it asks. */
    installBanner: function () {
      var mount = $('[data-pd-install-banner]');
      if (!mount || mount.dataset.pdInstallBanner === 'ready') return;
      mount.dataset.pdInstallBanner = 'ready';
      var DISMISS_KEY = 'pd_install_banner_dismissed';
      function dismissed() { return lsGet(DISMISS_KEY, false) === true; }
      function isIOS() {
        try {
          return /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
            (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
        } catch (e) { return false; }
      }
      function hide() { mount.style.display = 'none'; mount.innerHTML = ''; mount.dataset.pdInstallShown = ''; }
      function dismiss() { lsSet(DISMISS_KEY, true); hide(); }
      function render() {
        if (pwa.installed() || dismissed()) { hide(); return; }
        var deferred = pwa.installPrompt();
        var ios = isIOS();
        var mode = deferred ? 'prompt' : (ios ? 'ios' : '');
        if (!mode) { hide(); return; }
        if (mount.dataset.pdInstallShown === mode) { mount.style.display = ''; return; }
        mount.dataset.pdInstallShown = mode;
        mount.style.display = '';
        var hint = deferred
          ? 'One-tap access, offline Bible reading and prayer reminders — right from your home screen.'
          : 'On iPhone or iPad: tap the Share button, then “Add to Home Screen”.';
        mount.innerHTML = '<div id="pdInstallCard" role="note" style="display:flex;align-items:center;gap:14px;'
          + 'flex-wrap:wrap;margin:18px 16px 0;padding:14px 16px;border-radius:18px;'
          + 'border:1px solid var(--border-color,#e2e8f0);background:linear-gradient(135deg,rgba(10,77,155,.08),rgba(212,175,55,.14));'
          + 'box-shadow:var(--shadow,0 10px 30px rgba(0,0,0,.05));">'
          + '<img src="' + BRAND_LOGO + '" alt="" width="40" height="40" style="border-radius:12px;background:#fff;padding:4px;flex-shrink:0;">'
          + '<div style="flex:1;min-width:170px;"><strong style="display:block;font-weight:700;font-size:.92rem;line-height:1.35;font-family:Poppins,Inter,sans-serif;">'
          + 'Install the Prayer Dome app</strong><small style="color:var(--text-sub,#64748b);font-size:.76rem;">'
          + esc(hint) + '</small></div></div>';
        var card = mount.firstChild;
        if (deferred) {
          var install = document.createElement('button');
          install.type = 'button';
          install.id = 'pdInstallBtn';
          install.style.cssText = 'width:auto;padding:10px 18px;border-radius:30px;border:none;cursor:pointer;'
            + 'background:var(--accent-green,#0A4D9B);color:#fff;font-weight:700;font-size:.8rem;font-family:Inter,sans-serif;';
          install.innerHTML = '<i class="pd-i pd-i-download"></i> Install app';
          install.addEventListener('click', function () {
            pwa.promptInstall().then(function (accepted) {
              if (accepted) { hide(); toast('Installing Prayer Dome — look for the icon on your home screen.', 'success'); }
              else { toast('Install cancelled — you can add it any time from your browser menu.', 'info'); }
            });
          });
          card.appendChild(install);
        }
        var later = document.createElement('button');
        later.type = 'button';
        later.id = 'pdInstallDismiss';
        later.style.cssText = 'background:none;border:none;cursor:pointer;padding:8px;color:var(--text-sub,#64748b);'
          + 'font-weight:600;font-size:.78rem;font-family:Inter,sans-serif;';
        later.textContent = 'Not now';
        later.addEventListener('click', dismiss);
        card.appendChild(later);
      }
      render();
      document.addEventListener('pd:installready', render);
      document.addEventListener('pd:installed', render);
      window.addEventListener('load', render);
    },
    promptInstall: function () {
      var deferred = pwa._deferred;
      if (!deferred) return Promise.resolve(false);
      pwa._deferred = null;
      try {
        deferred.prompt();
        return deferred.userChoice.then(function (choice) {
          return !!(choice && choice.outcome === 'accepted');
        }).catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    },
    init: function () {
      pwa.register();
      try {
        window.addEventListener('beforeinstallprompt', function (e) {
          e.preventDefault();
          pwa._deferred = e;
          document.dispatchEvent(new CustomEvent('pd:installready'));
        });
        window.addEventListener('appinstalled', function () {
          pwa._deferred = null;
          document.dispatchEvent(new CustomEvent('pd:installed'));
        });
      } catch (e) {}
      pwa.installBanner();
    }
  };

  /* ---------------------------------------------------------------- public */
  window.PDApp = {
    version: VERSION,
    setFirestore: setFirestore,
    founder: founder,
    store: store,
    ui: ui,
    theme: theme,
    i18n: i18n,
    geo: geo,
    location: location,
    announcements: announcements,
    notifications: notifications,
    banners: banners,
    stats: stats,
    live: live,
    news: news,
    layout: layout,
    app: appShell,
    pwa: pwa,
    roles: roles,
    academyNav: academyNav,
    scripture: scripture,
    radio: radio,
    share: share,
    toast: toast,
    broadcast: broadcast,
    on: on,
    init: function () {
      // Each module is isolated: one failure must never break the rest.
      var modules = [
        ['layout', layout.init],
        ['appShell', appShell.init],
        ['pwa', pwa.init],
        ['ui', ui.init], ['i18n', i18n.init], ['location', location.init],
        ['announcements', announcements.init], ['notifications', notifications.init],
        ['banners', banners.init], ['stats', stats.init], ['live', live.init],
        ['scripture', scripture.init], ['radio', radio.init], ['academyNav', academyNav.init]
      ];
      modules.forEach(function (m) {
        try { m[1](); } catch (e) { /* module failed — continue */ }
      });
      // Broadcast that the app layer is ready (pages may hook here).
      document.dispatchEvent(new CustomEvent('pd:ready', { detail: { version: VERSION } }));
    }
  };

  // Auto-init after DOM ready (defensive: pages that need a hook can call PDApp.init() again).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.PDApp.init(); });
  } else {
    window.PDApp.init();
  }
})();
