const fs = require('fs');

const file = '/Users/mauro/Documents/FolioTrack3/src/server.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove the old routes block
const startPattern = '// ─── Admin API Routes ────────────────────────────────────────────────────────';
const endPattern = '// ─── CACHING LAYER ──────────────────────────────────────────────────────────';

const startIdx = content.indexOf(startPattern);
const endIdx = content.indexOf(endPattern);

if (startIdx === -1 || endIdx === -1) {
    console.error("Could not find start/end patterns!");
    process.exit(1);
}

const beforeBlock = content.slice(0, startIdx);
const afterBlock = content.slice(endIdx);

// We want to keep /api/app-version so let's extract it or rewrite it.
const extraBlock = `
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

let newContent = beforeBlock + extraBlock + afterBlock;

// Also remove the two other admin endpoints later in the file:
// rebuild-history and purge-performance and logs
const patternsToRemove = [
    "app.post('/api/admin/rebuild-history', requireAuth, requireAdmin",
    "app.get('/api/logs', requireAuth, requireAdmin",
    "app.get('/api/logs/dates', requireAuth, requireAdmin",
    "app.post('/api/admin/purge-performance', requireAuth"
];

let lines = newContent.split('\n');
let finalLines = [];
let i = 0;

while (i < lines.length) {
    let match = patternsToRemove.find(r => lines[i].includes(r));
    if (match) {
        let braceCount = 0;
        let started = false;
        while (i < lines.length) {
            let line = lines[i];
            braceCount += (line.match(/\\{/g) || []).length;
            braceCount -= (line.match(/\\}/g) || []).length;
            if (braceCount > 0) started = true;
            i++;
            if (started && braceCount === 0) {
                if (lines[i-1].includes('});') || lines[i-1].trim() === '});') {
                    break;
                } else if (i < lines.length && (lines[i].includes('});') || lines[i].trim() === '});')) {
                    i++;
                    break;
                }
                break;
            }
        }
    } else {
        finalLines.push(lines[i]);
        i++;
    }
}

newContent = finalLines.join('\n');

// Make sure resetTransporter and getRotatedLogFile are imported
if (!newContent.includes('resetTransporter')) {
    newContent = newContent.replace("const { getTransporter } = require('./utils/mailer');", "const { getTransporter, resetTransporter } = require('./utils/mailer');");
}
if (!newContent.includes('getRotatedLogFile')) {
    newContent = newContent.replace("const { logger, telegramLogger, getLastLogLines, LOG_FILE, LOGS_DIR, TELEGRAM_LOG_FILE } = require('./utils/logger');", "const { logger, telegramLogger, getLastLogLines, LOG_FILE, LOGS_DIR, TELEGRAM_LOG_FILE, getRotatedLogFile } = require('./utils/logger');");
}

fs.writeFileSync(file, newContent);
console.log('Server refactored successfully!');
