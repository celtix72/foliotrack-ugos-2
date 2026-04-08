const { sendMarketStatusTelegram } = require('./src/server.js');

async function test() {
    console.log('Testing Telegram Market Status Notification (Fixing escaping)...');
    try {
        await sendMarketStatusTelegram();
        console.log('Notification call completed.');
    } catch (err) {
        console.error('Test failed:', err);
    }
}

test();
