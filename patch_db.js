const fs = require('fs');
let code = fs.readFileSync('src/db.js', 'utf8');

const oldDbSettings = `        geminiApiKey: '',
        aiAssetPrompt: '',
        aiPortfolioPrompt: '',
        aiTokensUsedToday: '0',
        aiTokensDate: new Date().toISOString().split('T')[0]`;

const newDbSettings = `        geminiApiKey: '',
        geminiApiKeyFree: '',
        geminiApiKeyPay: '',
        qwenApiKeyFree: '',
        qwenApiKeyPay: '',
        openaiApiKeyFree: '',
        openaiApiKeyPay: '',
        agnesApiKeyFree: '',
        agnesApiKeyPay: '',
        aiAssetPrompt: '',
        aiPortfolioPrompt: '',
        aiTokensUsedToday: '0',
        aiTokensDate: new Date().toISOString().split('T')[0]`;

code = code.replace(oldDbSettings, newDbSettings);

fs.writeFileSync('src/db.js', code, 'utf8');
console.log('Patched db.js');
