// firebase-messaging-sw.js
// Background push delivery for Prayer Dome (Firebase Cloud Messaging).
//
// /sw.js is the root worker on every page and now imports the Messaging SDK
// itself, so in normal use FCM is delivered there. This file remains the
// fallback for a device whose root worker is missing, and it behaves the same
// way: Firebase draws the branded notification from the `notification` block,
// and this handler only mirrors the message into the in-app bell. Calling
// showNotification here as well would draw every push twice.
importScripts('/assets/vendor/firebase-app-compat.js');
importScripts('/assets/vendor/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyCxvql0r_aeerphxTA0UUedRppdBxGf7wo",
    authDomain: "prayer-dome.firebaseapp.com",
    projectId: "prayer-dome",
    messagingSenderId: "198295153196",
    appId: "1:198295153196:web:1222b31948d7974ba3bf89"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

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
    if (data.kind === 'sermon') return '/sermons.html';
    if (data.kind === 'event') return '/events.html';
    return '/index.html';
}

// Mirror every background message into an open app window. The SDK owns the
// actual system notification (title, body, icon, tag and deep link).
messaging.onBackgroundMessage((payload) => {
    const note = (payload && payload.notification) || {};
    const data = (payload && payload.data) || {};
    const link = (payload && payload.fcmOptions && payload.fcmOptions.link) || targetFor(data);
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((client) => client.postMessage({
            type: 'pd-push-received',
            notification: {
                id: data.id || data.tag || note.title,
                type: data.kind || data.type || 'general',
                title: note.title || data.title || 'Prayer Dome',
                message: note.body || data.body || data.message || '',
                link,
                time: new Date().toISOString()
            }
        })))
        .catch(() => {});
});

// Handle notification clicks. Reuse a window that is already open (and focus
// it) rather than opening a browser tab beside the installed app.
self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};
    // Notifications drawn by the Messaging SDK carry their payload here and
    // are already routed by the SDK's own click handler. Handling them again
    // would open the same page twice.
    if (data.FCM_MSG) return;
    event.notification.close();
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
