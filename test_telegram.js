const { sendMarketStatusTelegram } = require('./src/server.js');

async function test() {
    console.log('Verifying v33.1 Layout Restoration...');
    try {
        await sendMarketStatusTelegram();
        console.log('Test call finished.');
    } catch (err) {
        console.error('Test error:', err.message);
    }
}

test();
