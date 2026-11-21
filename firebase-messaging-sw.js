// firebase-messaging-sw.js
// Background push delivery for Prayer Dome (Firebase Cloud Messaging).
//
// /sw.js is the root worker on every page, and PDApp.notifications hands that
// registration to getToken(), so in normal use this file is the *fallback* for
// a device that has no root worker yet. It still has to behave exactly like the
// real app: Prayer Dome branding, one stable notification per message, a deep
// link that reopens the installed app (never a Chrome tab), and an in-app bell
// that updates while the app is open.
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyCxvql0r_aeerphxTA0UUedRppdBxGf7wo",
    authDomain: "prayer-dome.firebaseapp.com",
    projectId: "prayer-dome",
    storageBucket: "prayer-dome.firebasestorage.app",
    messagingSenderId: "198295153196",
    appId: "1:198295153196:web:1222b31948d7974ba3bf89"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

const LOGO = '/assets/logo-192.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function targetFor(data, action) {
    if (action === 'read') {
        return data.reference
            ? '/bible.html?verse=' + encodeURIComponent(data.reference)
            : '/bible.html';
    }
    if (action === 'pray') return '/prayer.html';
    if (data.url) return data.url;
    if (data.link) return data.link;
    if (data.screen) return '/' + String(data.screen).replace(/^\/+/, '').replace(/\.html$/i, '') + '.html';
    if (data.kind === 'live') return '/live.html';
    if (data.kind === 'news') return '/news.html';
    if (data.kind === 'prayer') return '/prayer.html';
    return '/index.html';
}

// Handle background messages. Registering this handler means *this* code draws
// the notification (the FCM SDK no longer draws a second copy), which is what
// keeps the icon, tag and deep link under our control.
messaging.onBackgroundMessage((payload) => {
    const note = (payload && payload.notification) || {};
    const data = (payload && payload.data) || {};
    const isVerse = data.kind === 'verse' || data.type === 'verse';

    const title = note.title || data.title || 'Prayer Dome';
    const link = (payload && payload.fcmOptions && payload.fcmOptions.link) || targetFor(data);
    const options = {
        body: note.body || data.body || data.message || 'A new word from Prayer Dome',
        icon: LOGO,
        badge: LOGO,
        image: note.image || data.image || undefined,
        // A stable tag per message keeps the shade tidy and replaces a re-sent
        // broadcast instead of stacking a second copy on the lock screen.
        tag: data.tag || ('pd-' + (data.id || (link || 'update').replace(/[^a-z0-9]+/gi, '-').slice(0, 48))),
        renotify: false,
        requireInteraction: false,
        silent: false,
        vibrate: [180, 90, 180],
        timestamp: Date.now(),
        data: {
            url: link,
            id: data.id || null,
            kind: data.kind || data.type || 'general',
            reference: data.reference || null
        },
        actions: [{ action: 'open', title: 'Open Prayer Dome' }]
    };

    if (isVerse) {
        options.actions = [
            { action: 'read', title: 'Read in Bible' },
            { action: 'pray', title: 'Pray now' }
        ];
    }

    return Promise.all([
        self.registration.showNotification(title, options),
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            list.forEach((client) => client.postMessage({
                type: 'pd-push-received',
                notification: {
                    id: data.id || options.tag,
                    type: data.kind || data.type || 'general',
                    title,
                    message: options.body,
                    link,
                    time: new Date().toISOString()
                }
            }));
        }).catch(() => {})
    ]);
});

// Handle notification clicks. Reuse a window that is already open (and focus
// it) rather than opening a browser tab beside the installed app.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    let urlToOpen = targetFor(data, event.action);
    if (urlToOpen.startsWith('/') && urlToOpen.indexOf('source=') === -1) {
        urlToOpen += (urlToOpen.indexOf('?') === -1 ? '?' : '&') + 'source=notification';
    }
    const base = urlToOpen.split('?')[0];

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url.includes(base) && 'focus' in client) return client.focus();
            }
            if (windowClients.length && 'navigate' in windowClients[0]) {
                return windowClients[0].navigate(urlToOpen).then((c) => c && c.focus());
            }
            if (self.clients.openWindow) return self.clients.openWindow(urlToOpen);
            return null;
        })
    );
});
