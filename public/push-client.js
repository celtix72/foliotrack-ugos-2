'use strict';

/**
 * Push Notification Manager for M2T
 */
const ftPush = {
    swRegistration: null,
    isSubscribed: false,

    async init() {
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            console.warn('Push Notifications require HTTPS');
            // We don't alert here yet, but we'll return false
        }

        if (!('serviceWorker' in navigator)) {
            console.warn('Service Workers are not supported');
            return false;
        }

        if (!('PushManager' in window)) {
            console.warn('Push Manager is not supported');
            return false;
        }

        try {
            this.swRegistration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker is registered', this.swRegistration);
            
            // Check if already subscribed
            const subscription = await this.swRegistration.pushManager.getSubscription();
            this.isSubscribed = !(subscription === null);
            
            return true;
        } catch (error) {
            console.error('Service Worker Error', error);
            return false;
        }
    },

    async subscribeUser() {
        try {
            if (!this.swRegistration) {
                const supported = await this.init();
                if (!supported || !this.swRegistration) {
                    let msg = 'Push non supportato su questo browser o connessione non sicura (richiede HTTPS).';
                    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
                        msg += ' ATTENZIONE: Stai usando HTTP, le notifiche richiedono HTTPS.';
                    }
                    throw new Error(msg);
                }
            }

            const response = await fetch('/api/push/vapid-public-key');
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(`Server API Error: ${response.status} ${errData.error || ''}`);
            }
            const { publicKey } = await response.json();
            if (!publicKey) throw new Error('VAPID Public Key missing from server response');
            
            const applicationServerKey = this.urlB64ToUint8Array(publicKey);
            
            const subscription = await this.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            console.log('User is subscribed:', subscription);
            const saveRes = await this.updateSubscriptionOnServer(subscription);
            if (!saveRes.ok) throw new Error('Failed to save subscription on server');
            
            this.isSubscribed = true;
            return { success: true };
        } catch (err) {
            console.error('Failed to subscribe the user: ', err);
            return { success: false, error: err.message };
        }
    },

    async unsubscribeUser() {
        try {
            const subscription = await this.swRegistration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
                await this.removeSubscriptionFromServer(subscription);
            }
            this.isSubscribed = false;
            return true;
        } catch (error) {
            console.error('Error unsubscribing', error);
            return false;
        }
    },

    async updateSubscriptionOnServer(subscription) {
        return fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription })
        });
    },

    async removeSubscriptionFromServer(subscription) {
        return fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription })
        });
    },

    urlB64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');

        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
};

window.ftPush = ftPush;
