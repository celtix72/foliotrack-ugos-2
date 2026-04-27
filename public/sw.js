'use strict';

/*
 * Service Worker for M2T Push Notifications
 */

self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push Received.');
    
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = {
            title: 'M2T Alert',
            body: event.data.text()
        };
    }

    const title = data.title || 'M2T Alert';
    
    // Dynamic tag to allow different types of alerts to coexist on Apple Watch
    // If data.tag is provided (e.g. 'dividend', 'tp'), use it; otherwise fallback to general
    const notificationTag = data.tag || (data.data && data.data.tag) || 'm2t-general';

    const options = {
        body: data.body || 'New alert from FolioTracker',
        icon: data.icon || '/logo.png',
        badge: data.badge || '/logo_cropped.png',
        vibrate: [200, 100, 200, 100, 200], // More distinct vibration for Watch
        silent: false,
        renotify: true,
        tag: notificationTag,
        timestamp: Date.now(),
        data: {
            url: data.data ? data.data.url : '/dashboard'
        },
        actions: [
            {
                action: 'open',
                title: 'Apri'
            }
        ]
    };

    // Remove actions if simple notification is preferred for watchOS compatibility in some versions
    // but usually 1-2 actions are fine.
    
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click Received.');

    event.notification.close();

    if (event.action === 'close') return;

    const urlToOpen = event.notification.data.url || '/dashboard';

    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then(function(windowClients) {
            // Check if there is already a window open and focus it
            for (let i = 0; i < windowClients.length; i++) {
                let client = windowClients[i];
                if (client.url.includes(urlToOpen) && 'focus' in client) {
                    return client.focus();
                }
            }
            // If no window is open, open a new one
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
