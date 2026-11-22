// Prayer Dome Service Worker
// Also delivers the Daily Bible Verse to the device (lock screen / notification
// shade) even when the app is closed — see /assets/pd-verse-data.js.
try { importScripts('/assets/pd-verse-data.js'); } catch (e) { /* verses unavailable offline */ }

// ---------------------------------------------------------------------------
// Firebase Cloud Messaging inside the *root* worker.
//
// PDApp.notifications hands this exact registration to getToken(), so every
// FCM push is delivered here. FCM payloads are encrypted for the push
// subscription; only the Messaging SDK can decrypt them. Without these two
// imports the old raw `push` handler saw ciphertext — the reason pushes could
// arrive but show no usable notification when the app was closed.
//
// The SDK displays the notification itself when the payload contains a
// `notification` block (ours always does). We only draw a card for a data-only
// message, which the SDK never displays; calling showNotification for both
// is what produced duplicate cards.
// ---------------------------------------------------------------------------
const FCM_CONFIG = {
    apiKey: 'AIzaSyCxvql0r_aeerphxTA0UUedRppdBxGf7wo',
    authDomain: 'prayer-dome.firebaseapp.com',
    projectId: 'prayer-dome',
    storageBucket: 'prayer-dome.firebasestorage.app',
    messagingSenderId: '198295153196',
    appId: '1:198295153196:web:1222b31948d7974ba3bf89'
};
let pdMessaging = null;
try {
    importScripts('/assets/vendor/firebase-app-compat.js');
    importScripts('/assets/vendor/firebase-messaging-compat.js');
    if (self.firebase && firebase.messaging) {
        if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FCM_CONFIG);
        pdMessaging = firebase.messaging();
        pdMessaging.onBackgroundMessage((payload) => {
            const note = (payload && payload.notification) || {};
            const data = (payload && payload.data) || {};
            const link = (payload && payload.fcmOptions && payload.fcmOptions.link) || data.link || data.url || '';
            // A notification payload is drawn by the Messaging SDK itself. A
            // data-only message is not, so draw the same branded card here.
            // Without this branch data-only pushes reached the bell but never
            // appeared on the lock screen.
            let drawn = Promise.resolve();
            if (!(payload && payload.notification)) {
                const fallback = {
                    title: data.title || 'Prayer Dome',
                    body: data.body || data.message || 'A new word from Prayer Dome',
                    icon: data.icon || '/assets/logo-192.png',
                    image: data.image || undefined,
                    tag: data.tag || ('pd-' + (data.id || Date.now())),
                    kind: String(data.kind || data.type || 'general').toLowerCase(),
                    link: link,
                    id: data.id || null,
                    reference: data.reference || null
                };
                drawn = self.registration.showNotification(fallback.title, notificationOptions(fallback)).catch(() => {});
            }
            return Promise.all([
                drawn,
                // Tell any open window so the in-app bell updates in the same second.
                self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then((list) => list.forEach((client) => client.postMessage({
                        type: 'pd-push-received',
                        notification: {
                            id: data.id || data.tag || note.title,
                            type: data.kind || data.type || 'general',
                            title: note.title || data.title || 'Prayer Dome',
                            message: note.body || data.body || data.message || '',
                            link: link || null,
                            time: new Date().toISOString()
                        }
                    })))
                    .catch(() => {})
            ]);
        });
    }
} catch (e) { /* offline install: the raw push handler still covers plain JSON */ }

// Bump CACHE_NAME whenever the precache list changes.
// v41 — the shared stylesheet and the app layer changed (document scrolling,
// the notification-diagnostics loop and the loading-overlay guard). A new
// name makes the worker re-precache the fixed files at once, so a returning
// visitor is not left on the old, frozen copy.
// v43 — branch locations, the public card-verification page and the grouped
// admin console shipped. A new cache name retires the previous shell so a
// returning member gets the new navigation and card pages immediately.
// v44 — the support page gained information sections and the Brevo update
// form. The form script is precached so the page's markup and behaviour stay
// in step after an upgrade.
const CACHE_NAME = 'prayer-dome-v45';

// Shell assets worth having available offline.
const PRECACHE = [
    '/',
    '/index.html',
    // The dedicated offline shell shown when a navigation cannot be served at
    // all — far friendlier than falling back to a half-empty home page.
    '/offline.html',
    '/devotional-data.js',
    '/bible.html',
    '/prayer.html',
    '/ai-prayer.html',
    '/ai-prayer-data.js',
    '/sermons.html',
    '/sermons-data.js',
    '/translate.html',
    '/translation-data.js',
    '/assets/pd-brand.css',
    '/assets/pd-responsive-fix.css',
    // Icon system (Lucide SVG icons); needed by every page, including offline.
    '/assets/pd-icons.css',
    '/assets/pd-icons.js',
    '/assets/pd-motion.js',
    '/live.html',
    '/gallery.html',
    '/give.html',
    '/video.html',
    '/quiz.html',
    '/membership.html',
    '/locations.html',
    '/verify.html',
    '/assets/pd-locations-data.js',
    '/assets/pd-locations.js',
    '/support.html',
    '/team.html',
    '/account.html',
    '/manifest.json',
    '/assets/logo.png',
    '/assets/logo-192.png',
    '/news.html',
    '/radio.html',
    '/lessons.html',
    '/lesson.html',
    '/lesson-pdf.html',
    '/lesson-audio.html',
    '/lesson-quiz.html',
    '/game.html',
    '/stories.html',
    '/resources.html',
    '/resource-view.html',
    '/documents/statement-of-faith.pdf',
    '/documents/new-believers-guide.pdf',
    '/documents/prayer-watch-guide.pdf',
    '/documents/serving-teams-handbook.pdf',
    '/documents/small-group-guide.pdf',
    '/Prayer-Dome-User-Guide.pdf',
    '/assets/pd-academy-data.js',
    '/assets/pd-academy-questions.js',
    '/assets/pd-academy.js',
    '/assets/pd-certificate.js',
    '/assets/pd-quiz-session.js',
    '/assets/pd-nav.js',
    '/assets/pd-app.js',
    '/assets/pd-newsletter.js',
    '/assets/pd-sfx.js',
    '/assets/pd-team-data.js',
    '/assets/pd-team-store.js',
    '/assets/pd-cloud-video.js',
    // Domey, the talking hostess used by the game and the Live lounge.
    '/assets/pd-mascot.css',
    '/assets/pd-mascot.js',
    // Domey herself (the semi-realistic hostess, modelled in code so she needs
    // no download), her 3D engine (three.js r165, vendored so it works
    // offline) and the question bank she plays from — 1,248 questions across
    // 14 topics.
    '/assets/pd-domey3d.js',
    '/assets/pd-domey-lady.js',
    '/assets/three.module.min.js',
    '/assets/pd-domey-questions.js',
    // Domey's real photograph — the talking host on the chat and quiz pages.
    '/assets/domey/domey-real.jpg',
    // The live Domey companion on the AI assistant page. The widget itself is
    // hosted on three.ws and needs the network; this loader shows the helpful
    // offline/error panel instead of a blank frame.
    '/assets/pd-domey-widget.js',
    '/assets/pd-upload.js',
    '/assets/pd-verse-data.js',
    '/assets/pd-verse-alerts.js',
    // The lock-screen verse studio and its native widget bridge — a member
    // who installs the app from the website should find them offline too.
    '/widgets.html',
    '/assets/pd-widget.js',
    '/assets/pd-content-data.js',
    '/assets/hero-worship.jpg',
    '/assets/testimonies/hero-praise.jpg',
    '/assets/avatar-default.svg',
    '/assets/og-image.png'
];

// ---------------------------------------------------------------------------
// Install — precache the shell. Individual failures must not abort the install,
// so each request is added on a best-effort basis.
// ---------------------------------------------------------------------------
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(
                PRECACHE.map(url =>
                    cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
                )
            )
        )
    );
});

// ---------------------------------------------------------------------------
// Activate — drop caches from previous versions.
// ---------------------------------------------------------------------------
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ---------------------------------------------------------------------------
// Fetch strategy
//   * Navigations / HTML  -> network first, fall back to cache (then offline shell).
//     This is what makes deploys visible immediately instead of serving a stale
//     page forever, which the previous cache-first worker did.
//   * Firebase & APIs     -> always network; never cached.
//   * Everything else     -> stale-while-revalidate.
// ---------------------------------------------------------------------------
/* The administrator console must always come from the network. It is never
 * precached, never stored and never replayed from the cache: a role change or a
 * sign-out has to be visible on the very next load, and an offline console is
 * useless anyway (every panel reads Firestore). */
const NETWORK_ONLY_PATHS = ['/admin', '/admin.html'];
function isNetworkOnlyPage(url) {
    if (url.origin !== self.location.origin) return false;
    const path = (url.pathname || '/').replace(/\/+$/, '') || '/';
    return NETWORK_ONLY_PATHS.includes(path);
}

// Do not fill the phone's storage with one-off large files (the 10 MB rigged
// character model, long media). They are still served from the network and, for
// the character, from the browser's own HTTP cache.
const MAX_CACHE_BYTES = 6 * 1024 * 1024;
function cacheableResponse(res) {
    if (!res || res.status !== 200 || res.type === 'opaque') return false;
    const size = Number(res.headers.get('content-length') || 0);
    return !(size > MAX_CACHE_BYTES);
}

const NEVER_CACHE = [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'fcmregistrations.googleapis.com',
    'www.googleapis.com',
    'api.cloudinary.com',
    'res.cloudinary.com'
];

self.addEventListener('fetch', event => {
    const req = event.request;

    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (NEVER_CACHE.some(host => url.hostname.includes(host))) return;
    if (isNetworkOnlyPage(url)) return;
    // Range requests (audio/video seeking) must go straight to the network.
    if (req.headers.has('range')) return;

    const isHTML = req.mode === 'navigate' ||
                   (req.headers.get('accept') || '').includes('text/html');

    // Code updates must show on the very first load after a deploy. Stale-
    // while-revalidate would hand the page the previous pd-app.js once, so a
    // member could reopen the app and still see the old build. Fetch fresh
    // JavaScript/CSS, fall back to the cached copy only when offline.
    const isCode = url.origin === self.location.origin && /\.(?:js|css)$/i.test(url.pathname);
    if (isCode) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    if (cacheableResponse(res)) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => caches.match(req))
        );
        return;
    }

    if (isHTML) {
        event.respondWith(
            fetch(req)
                .then(res => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
                    return res;
                })
                .catch(() =>
                    caches.match(req)
                        .then(hit => hit || caches.match('/offline.html'))
                        .then(hit => hit || caches.match('/index.html'))
                        .then(hit => hit || new Response(
                            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
                            '<p style="font:16px system-ui;padding:24px">Prayer Dome is offline.</p>',
                            { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
                        ))
                )
        );
        return;
    }

    event.respondWith(
        caches.match(req).then(hit => {
            const network = fetch(req)
                .then(res => {
                    if (cacheableResponse(res)) {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => hit);
            return hit || network;
        })
    );
});

// ---------------------------------------------------------------------------
// Daily Bible Verse — background delivery
// The worker keeps its own copy of the member's verse settings (the Cache API
// is the only storage a service worker can use synchronously across wake-ups).
// ---------------------------------------------------------------------------
const SETTINGS_CACHE = 'pd-settings';
const SETTINGS_URL = '/__pd/verse-settings.json';

async function readVerseSettings() {
    try {
        const cache = await caches.open(SETTINGS_CACHE);
        const hit = await cache.match(SETTINGS_URL);
        if (!hit) return null;
        return await hit.json();
    } catch (e) { return null; }
}

async function writeVerseSettings(settings) {
    try {
        const cache = await caches.open(SETTINGS_CACHE);
        await cache.put(SETTINGS_URL, new Response(JSON.stringify(settings), {
            headers: { 'Content-Type': 'application/json' }
        }));
    } catch (e) { /* storage unavailable */ }
}

function todayStamp() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

function minutesOf(hhmm) {
    const parts = String(hhmm || '00:00').split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
}

async function specialVerseForToday() {
    try {
        const res = await fetch(
            'https://firestore.googleapis.com/v1/projects/prayer-dome/databases/(default)/documents/verseSchedule/' +
            todayStamp(), { headers: { accept: 'application/json' } });
        if (!res.ok) return null;
        const doc = await res.json();
        const f = doc.fields || {};
        const text = f.text && f.text.stringValue;
        const reference = f.reference && f.reference.stringValue;
        if (!text || !reference) return null;
        return {
            text, reference,
            title: (f.title && f.title.stringValue) || null,
            slots: (f.slots && f.slots.stringValue) || 'all',
            translation: (f.translation && f.translation.stringValue) || 'NIV'
        };
    } catch (e) { return null; }
}

async function showVerseNotification(verse) {
    const title = (verse.slotLabel || 'Daily Verse') + ' \u00b7 Prayer Dome';
    return self.registration.showNotification(title, {
        body: '\u201C' + verse.text + '\u201D\n\u2014 ' + verse.reference +
              ' (' + (verse.translation || 'NIV') + ')',
        icon: '/assets/logo-192.png',
        badge: '/assets/logo-192.png',
        tag: 'pd-verse-' + verse.slot + '-' + todayStamp(),
        renotify: false,
        data: {
            url: '/bible.html?verse=' + encodeURIComponent(verse.reference),
            kind: 'verse',
            slot: verse.slot
        },
        actions: [
            { action: 'read', title: 'Read in Bible' },
            { action: 'pray', title: 'Pray now' }
        ]
    });
}

/** Deliver any verse that is due today and has not been sent yet. */
async function deliverDueVerses(force) {
    if (!self.PD_VERSES) return;
    const settings = await readVerseSettings();
    if (!settings || !settings.enabled) return;

    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const stamp = todayStamp();
    const special = await specialVerseForToday();
    let changed = false;
    settings.lastSent = settings.lastSent || {};

    for (const slot of self.PD_VERSES.SLOTS) {
        const conf = (settings.slots || {})[slot.id];
        if (!conf || conf.on === false) continue;
        if (settings.lastSent[slot.id] === stamp && !force) continue;
        const due = minutesOf(conf.time);
        if (!force && (minutes < due || minutes - due > 180)) continue;

        let verse = self.PD_VERSES.verseFor(slot.id);
        if (special && (special.slots === 'all' || String(special.slots).includes(slot.id))) {
            verse = Object.assign({}, verse, {
                text: special.text,
                reference: special.reference,
                translation: special.translation,
                slotLabel: special.title || verse.slotLabel
            });
        }
        await showVerseNotification(verse);
        settings.lastSent[slot.id] = stamp;
        changed = true;
    }
    if (changed) await writeVerseSettings(settings);
}

// Periodic background sync (installed PWA on Android/Chrome).
self.addEventListener('periodicsync', event => {
    if (event.tag === 'pd-verse-alerts') event.waitUntil(deliverDueVerses(false));
});

// One-off background sync fallback.
self.addEventListener('sync', event => {
    if (event.tag === 'pd-verse-alerts') event.waitUntil(deliverDueVerses(false));
});

// ---------------------------------------------------------------------------
// Push — server-sent verses, live alerts and ministry notices.
//
// This worker owns the root scope, so it is also the worker Firebase Cloud
// Messaging delivers to (PDApp.notifications passes this registration to
// getToken). The payload may therefore arrive in any of the shapes FCM uses:
//
//   { notification: { title, body, icon, image }, data: {...}, fcmOptions }
//   { title, body, ... }                       (a plain web-push payload)
//   { data: { ... } }                          (data-only message)
//
// All of them are normalised here, so a message never falls through and never
// appears twice. The notification is drawn with Prayer Dome branding, a stable
// tag and the right deep link, then the open app is told so its bell updates
// without waiting for a reload.
// ---------------------------------------------------------------------------
function pushPayload(event) {
    var payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        // Encrypted FCM ciphertext is handled by the Messaging SDK above.
        // Never turn raw bytes into a gibberish notification.
        return null;
    }
    if (!payload || typeof payload !== 'object') payload = {};
    var note = payload.notification || payload;
    var data = payload.data || payload.notification && payload.notification.data || {};
    // FCM serialises every data value as a string; keep the ones we read tidy.
    var flat = {};
    Object.keys(data || {}).forEach(function (k) {
        var v = data[k];
        flat[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v;
    });
    var link = (payload.fcmOptions && payload.fcmOptions.link) || flat.url || flat.link || flat.click_action || '';
    return {
        title: note.title || flat.title || 'Prayer Dome',
        body: note.body || note.message || flat.body || flat.message || 'A new word from Prayer Dome',
        icon: note.icon || flat.icon || '/assets/logo-192.png',
        image: note.image || flat.image || undefined,
        tag: flat.tag || ('pd-' + (flat.id || (link ? link.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) : Date.now()))),
        kind: String(flat.kind || flat.type || 'general').toLowerCase(),
        link: link,
        id: flat.id || null,
        reference: flat.reference || null,
        data: flat
    };
}

function targetForPush(note) {
    if (note.link) {
        if (/^https?:\/\//i.test(note.link)) {
            try {
                var url = new URL(note.link);
                if (url.origin === self.location.origin) return url.pathname + url.search + url.hash;
            } catch (e) {}
            return note.link;
        }
        return note.link.charAt(0) === '/' ? note.link : '/' + note.link;
    }
    if (note.reference) return '/bible.html?verse=' + encodeURIComponent(note.reference);
    if (note.kind === 'live') return '/live.html';
    if (note.kind === 'news') return '/news.html';
    if (note.kind === 'prayer') return '/prayer.html';
    if (note.kind === 'verse' || note.kind === 'scripture') return '/bible.html';
    if (note.kind === 'sermon' || note.kind === 'devotional') return '/sermons.html';
    if (note.kind === 'event') return '/events.html';
    return '/index.html';
}

function notificationOptions(note) {
    var options = {
        body: note.body,
        icon: note.icon || '/assets/logo-192.png',
        badge: '/assets/logo-192.png',
        image: note.image || undefined,
        // A stable tag means a re-sent broadcast replaces the old card instead
        // of stacking duplicates on the lock screen.
        tag: note.tag,
        renotify: false,
        requireInteraction: false,
        silent: false,
        vibrate: [180, 90, 180],
        timestamp: Date.now(),
        data: {
            url: targetForPush(note),
            id: note.id,
            kind: note.kind,
            reference: note.reference
        },
        actions: [
            { action: 'open', title: 'Open Prayer Dome' }
        ]
    };
    if (note.kind === 'verse' || note.kind === 'scripture') {
        options.actions = [
            { action: 'read', title: 'Read in Bible' },
            { action: 'pray', title: 'Pray now' }
        ];
    }
    return options;
}

self.addEventListener('push', event => {
    // When the FCM SDK loaded, it owns every push event: it draws notification
    // payloads, routes foreground messages to the page and calls the data-only
    // handler above. A second showNotification here is what used to produce a
    // duplicate card on the lock screen.
    if (pdMessaging) return;
    var note = pushPayload(event);
    if (!note) return;
    event.waitUntil(
        Promise.all([
            self.registration.showNotification(note.title, notificationOptions(note)),
            // Keep the in-app bell in step when the app happens to be open.
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
                list.forEach(client => {
                    client.postMessage({
                        type: 'pd-push-received',
                        notification: {
                            id: note.id || note.tag,
                            type: note.kind,
                            title: note.title,
                            message: note.body,
                            link: targetForPush(note),
                            time: new Date().toISOString()
                        }
                    });
                });
            }).catch(() => {})
        ])
    );
});

// Some browsers rotate a push subscription on their own. Re-subscribe quietly
// with the same VAPID key so a member is never silently dropped.
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil((async () => {
        try {
            const old = event.oldSubscription;
            if (!old) return;
            const key = old.options && old.options.applicationServerKey;
            const fresh = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key
            });
            const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
            list.forEach(client => client.postMessage({
                type: 'pd-push-subscription-changed',
                subscription: fresh && fresh.toJSON ? fresh.toJSON() : null
            }));
        } catch (e) { /* the app re-registers on its next load */ }
    })());
});

// ---------------------------------------------------------------------------
// Notification click — route to the page the notification came from.
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', event => {
    // Notifications drawn by the Firebase Messaging SDK carry FCM_MSG and are
    // routed by the SDK itself. Handling them here too could open two windows.
    if (event.notification.data && event.notification.data.FCM_MSG) return;
    event.notification.close();

    const data = event.notification.data || {};
    let target = data.url || data.screen || '/index.html';
    if (event.action === 'read') target = data.reference
        ? '/bible.html?verse=' + encodeURIComponent(data.reference)
        : '/bible.html';
    if (event.action === 'pray') target = '/prayer.html';

    let path;
    if (/^https?:\/\//i.test(target)) path = target;
    else if (target.startsWith('/')) path = target;
    else path = '/' + target.replace(/^\.?\/+/, '') + (/\.html($|\?)/.test(target) ? '' : '.html');
    // A deep link stays a deep link; add the source only for analytics-free
    // routing inside the app, never rewrite an external URL.
    if (path.startsWith('/') && path.indexOf('source=') === -1) {
        path += (path.indexOf('?') === -1 ? '?' : '&') + 'source=notification';
    }
    const base = path.split('?')[0];

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const client of list) {
                if (client.url.includes(base) && 'focus' in client) return client.focus();
            }
            // Nothing matching open — reuse any window if we can, else open one.
            if (list.length && 'navigate' in list[0]) {
                return list[0].navigate(path).then(c => c && c.focus());
            }
            return clients.openWindow(path);
        })
    );
});

// Let the app tell the worker when a notification was read, so the same item is
// never surfaced again as if it were new.
self.addEventListener('notificationclose', event => {
    const data = event.notification.data || {};
    if (!data.id) return;
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            list.forEach(c => c.postMessage({ type: 'pd-notification-dismissed', id: data.id }));
        })
    );
});

// Messages from the app: verse settings, immediate checks, worker updates.
self.addEventListener('message', event => {
    const msg = event.data;
    if (msg === 'SKIP_WAITING') { self.skipWaiting(); return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pd-verse-settings') {
        event.waitUntil(writeVerseSettings(msg.settings || {}));
    } else if (msg.type === 'pd-verse-check') {
        event.waitUntil(deliverDueVerses(!!msg.force));
    } else if (msg.type === 'pd-clear-notification' && msg.tag) {
        event.waitUntil(
            self.registration.getNotifications({ tag: msg.tag })
                .then(list => list.forEach(n => n.close()))
        );
    }
});

// Catch-up: whenever the worker wakes for a navigation, quietly check whether a
// verse was due while the device was asleep (throttled to once every 30 min).
let lastCatchUp = 0;
self.addEventListener('fetch', event => {
    if (event.request.mode !== 'navigate') return;
    const now = Date.now();
    if (now - lastCatchUp < 30 * 60 * 1000) return;
    lastCatchUp = now;
    event.waitUntil(deliverDueVerses(false).catch(() => {}));
});
