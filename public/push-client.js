'use strict';

/**
 * Push Notification Manager for FolioTrack
 */
const ftPush = {
    swRegistration: null,
    isSubscribed: false,

    async init() {
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            console.warn('Push Notifications require HTTPS or localhost');
        }

        if (!('serviceWorker' in navigator)) {
            console.warn('Service Workers are not supported in this browser');
            return false;
        }

        if (!('PushManager' in window)) {
            console.warn('Push Manager is not supported in this browser');
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
                    let msg = 'Push non supportato su questo browser o connessione non sicura (richiede HTTPS o localhost).';
                    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                        msg += ' ATTENZIONE: Stai usando HTTP, le notifiche push dei browser richiedono HTTPS.';
                    }
                    throw new Error(msg);
                }
            }

            if ('Notification' in window) {
                if (Notification.permission === 'denied') {
                    throw new Error('Permesso di notifica bloccato nel browser. Abilita i permessi nelle impostazioni del sito nel tuo browser.');
                }
                if (Notification.permission !== 'granted') {
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted') {
                        throw new Error('Permesso di notifica non concesso.');
                    }
                }
            }

            const response = await fetch('/api/push/vapid-public-key');
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(`Server API Error: ${response.status} ${errData.error || ''}`);
            }
            const { publicKey } = await response.json();
            if (!publicKey) throw new Error('VAPID Public Key mancante dalla risposta del server');
            
            const applicationServerKey = this.urlB64ToUint8Array(publicKey);
            
            // Clean up existing subscription if any to re-bind cleanly
            try {
                const existingSub = await this.swRegistration.pushManager.getSubscription();
                if (existingSub) {
                    await existingSub.unsubscribe();
                }
            } catch (unsubErr) {
                console.warn('Could not unsubscribe old sub:', unsubErr);
            }

            const subscription = await this.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            console.log('User is subscribed:', subscription);
            const saveRes = await this.updateSubscriptionOnServer(subscription);
            if (!saveRes.ok) {
                const saveErr = await saveRes.json().catch(() => ({}));
                throw new Error(saveErr.error || 'Errore salvataggio sottoscrizione sul server');
            }
            
            this.isSubscribed = true;
            return { success: true };
        } catch (err) {
            console.error('Failed to subscribe the user: ', err);
            return { success: false, error: err.message };
        }
    },

    async unsubscribeUser() {
        try {
            if (!this.swRegistration) await this.init();
            if (this.swRegistration) {
                const subscription = await this.swRegistration.pushManager.getSubscription();
                if (subscription) {
                    await subscription.unsubscribe();
                    await this.removeSubscriptionFromServer(subscription);
                }
            }
            this.isSubscribed = false;
            return true;
        } catch (error) {
            console.error('Error unsubscribing', error);
            return false;
        }
    },

    async updateSubscriptionOnServer(subscription) {
        const subData = subscription.toJSON ? subscription.toJSON() : subscription;
        return fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                subscription: subData,
                device_name: navigator.userAgent
            })
        });
    },

    async removeSubscriptionFromServer(subscription) {
        const subData = subscription.toJSON ? subscription.toJSON() : subscription;
        return fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: subData })
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
