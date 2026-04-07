const { https } = require('follow-redirects'); // Might need to check if follow-redirects is installed or use standard https
const https_std = require('https');
const database = require('./src/db');

// Mocking essentials if needed, but better to import them
// Let's assume we can't easily import from server.js without side effects (like starting the server)
// So I'll copy the escaping functions here for testing

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
        console.log('Error: Telegram token or chatId missing');
        return;
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
                    resolve({ success: true, body });
                }
            });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

async function test() {
    console.log('Starting Telegram Diagnostic...');
    // We'll test a simulated header and a few rows
    const totalSign = '+';
    const totalAbs = '123';
    const singleEmoji = '🟢';
    const totalNetValue = 23876.54;

    let msg = `📊 1D: *${escapeV2(totalSign + '€' + totalAbs)}* ${singleEmoji}         Netto: *${escapeV2('€' + Math.round(totalNetValue).toLocaleString('it-IT'))}* 💰\n\n`;
    
    // Simulating a row
    const rowData = `TDIV     €  52.33     -€20   -0.63%`;
    msg += `📉 \`${escapeCodeV2(rowData)}\` 🔴\n`;

    console.log('Sending message to Telegram...');
    const result = await sendTelegramMessageDiagnostic(msg);
    if (result.success) {
        console.log('SUCCESS! Message sent.');
    } else {
        console.log('FAILED!');
        console.log('Status Code:', result.statusCode);
        console.log('Error Details:', result.error);
        console.log('Raw Message:', msg);
    }
    process.exit(0);
}

test();
