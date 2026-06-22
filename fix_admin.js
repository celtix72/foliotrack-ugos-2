const fs = require('fs');
const file = '/Users/mauro/Documents/FolioTrack3/src/server.js';

let content = fs.readFileSync(file, 'utf8');

const startMarker = '// ─── Admin API Routes ────────────────────────────────────────────────────────';
const endMarker = '// GET /api/app-version (public)';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf('// ─── CACHING LAYER ──────────────────────────────────────────────────────────');

if (startIdx === -1 || endIdx === -1) {
    console.error('Markers not found!');
    process.exit(1);
}

const beforeBlock = content.slice(0, startIdx);
const afterBlock = content.slice(endIdx);

const newBlock = `
// ─── Extracted Admin & Settings Routes ───────────────────────────────────────
app.use('/api/admin', require('./routes/admin')({
    requireAuth, requireAdmin, database, logger, APP_VERSION, LOG_FILE, LOGS_DIR, getRotatedLogFile, logAudit, getTransporter
}));

app.use('/api', require('./routes/settings')({
    requireAuth, requireAdmin, database, logger, resetTransporter
}));

// GET /api/app-version (public)
app.get('/api/app-version', (req, res) => {
    res.json({ version: APP_VERSION });
});

`;

let newContent = beforeBlock + newBlock + afterBlock;

// Add getRotatedLogFile and resetTransporter
if (!newContent.includes('resetTransporter')) {
    newContent = newContent.replace("const { getTransporter } = require('./utils/mailer');", "const { getTransporter, resetTransporter } = require('./utils/mailer');");
}
if (!newContent.includes('getRotatedLogFile')) {
    newContent = newContent.replace("const { logger, telegramLogger, getLastLogLines, LOG_FILE, LOGS_DIR, TELEGRAM_LOG_FILE } = require('./utils/logger');", "const { logger, telegramLogger, getLastLogLines, LOG_FILE, LOGS_DIR, TELEGRAM_LOG_FILE, getRotatedLogFile } = require('./utils/logger');");
}

fs.writeFileSync(file, newContent);
console.log('Fixed correctly! Length: ', newContent.split('\\n').length);
