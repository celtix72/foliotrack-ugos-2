// Telegram service - Safe no-op stubs (Telegram notifications removed)

function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

async function sendTelegramMessage() {
    return Promise.resolve();
}

async function startTelegramPolling() {
    return Promise.resolve();
}

module.exports = {
    sendTelegramMessage,
    startTelegramPolling,
    escapeV2,
    escapeCodeV2
};
