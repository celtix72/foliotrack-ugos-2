const https_std = require('https');
const database = require('./src/db');
const path = require('path');

// Initialize the database to get real settings
database.initDb();

function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

async function sendTelegramMessageDiagnostic(text) {
    const settings = database.getSettings();
    const token = settings.telegramBotToken;
    const chatId = settings.telegramChatId;

    if (!token || !chatId) {
        throw new Error('Telegram token or chatId missing in settings');
    }

    const data = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'MarkdownV2'
    });

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https_std.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    resolve({ success: false, statusCode: res.statusCode, error: body });
                } else {
                    resolve({ success: true, body: JSON.parse(body) });
                }
            });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

async function test() {
    console.log('Starting Corrected Telegram Diagnostic...');
    try {
        const totalSign = '-';
        const totalAbs = '510';
        const singleEmoji = '🔴';
        const totalNetValue = 483410.12;

        let msg = `📊 1D: *${escapeV2(totalSign + '€' + totalAbs)}* ${singleEmoji}         Netto: *${escapeV2('€' + Math.round(totalNetValue).toLocaleString('it-IT'))}* 💰\n\n`;
        
        // Simulating a real category and row
        msg += `\`${escapeCodeV2('🟢 ETF AZ           ')}\` ${escapeV2('-€185')}\n`;
        const rowData = `TDIV     €  52.33     -€20   -0.63%`;
        msg += `📉 \`${escapeCodeV2(rowData)}\` 🔴\n`;

        console.log('Sending message to Telegram...');
        const result = await sendTelegramMessageDiagnostic(msg);
        if (result.success) {
            console.log('SUCCESS! Diagnostic message sent to Telegram.');
        } else {
            console.log('FAILED!');
            console.log('Status Code:', result.statusCode);
            console.log('Error Details:', result.error);
            console.log('Final Message attempted:');
            console.log('---');
            console.log(msg);
            console.log('---');
        }
    } catch (err) {
        console.error('Fatal Test Error:', err.message);
    }
    process.exit(0);
}

test();
