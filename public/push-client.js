'use strict';

/**
 * Push Notification Manager for M2T
 */
const ftPush = {
    swRegistration: null,
    isSubscribed: false,

    async init() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('Push messaging is not supported');
            return false;
        }

        try {
            this.swRegistration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker is registered', this.swRegistration);
            
            // Check if already subscribed
            const subscription = await this.swRegistration.pushManager.getSubscription();
            this.isSubscribed = !(subscription === null);
            
            if (this.isSubscribed) {
                console.log('User IS subscribed.');
            } else {
                console.log('User is NOT subscribed.');
            }
            return true;
        } catch (error) {
            console.error('Service Worker Error', error);
            return false;
        }
    },

    async subscribeUser() {
        try {
            const response = await fetch('/api/push/vapid-public-key');
            const { publicKey } = await response.json();
            const applicationServerKey = this.urlB64ToUint8Array(publicKey);
            
            const subscription = await this.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            console.log('User is subscribed:', subscription);
            await this.updateSubscriptionOnServer(subscription);
            this.isSubscribed = true;
            return true;
        } catch (err) {
            console.error('Failed to subscribe the user: ', err);
            return false;
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
