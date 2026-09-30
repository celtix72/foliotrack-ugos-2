'use strict';

/*
 * Service Worker for M2T Push Notifications
 */

self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push Received.');
    
    let data = {};
    if (event && event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            try {
                data = {
                    title: 'FolioTracker Alert',
                    body: event.data.text()
                };
            } catch (err2) {
                data = {
                    title: 'FolioTracker Alert',
                    body: 'Nuovo aggiornamento disponibile'
                };
            }
        }
    } else {
        data = {
            title: 'FolioTracker Alert',
            body: 'Nuovo aggiornamento disponibile'
        };
    }

    const title = (data.title !== undefined && data.title !== null) ? data.title : 'FolioTracker Alert';
    
    // Dynamic tag to allow different types of alerts to coexist on Apple Watch and phone lockscreen
    const notificationTag = data.tag || (data.data && data.data.tag) || 'foliotrack-alert';

    const options = {
        body: data.body || 'Nuovo aggiornamento disponibile',
        icon: data.icon || '/logo.png',
        badge: data.badge || '/logo_cropped.png',
        vibrate: [200, 100, 200, 100, 200],
        silent: false,
        renotify: true,
        tag: notificationTag,
        timestamp: Date.now(),
        data: {
            url: (data.data && data.data.url) ? data.data.url : '/dashboard'
        },
        actions: [
            {
                action: 'open',
                title: 'Apri'
            }
        ]
    };
    
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click Received.');

    event.notification.close();

    if (event.action === 'close') return;

    const urlToOpen = (event.notification && event.notification.data && event.notification.data.url) || '/dashboard';

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
