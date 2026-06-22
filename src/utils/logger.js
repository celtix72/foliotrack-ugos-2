const fs = require('fs');
const path = require('path');

// __dirname is now src/utils, so logs is ../../logs
const LOGS_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOGS_DIR, 'app.log');
const TELEGRAM_LOG_FILE = path.join(LOGS_DIR, 'telegram.log');

// Daily-rotating log helper
function getRotatedLogFile(date) {
    const d = date || new Date();
    const key = d.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(LOGS_DIR, `app-${key}.log`);
}

function writeLog(level, msg) {
    const ts = new Date();
    const line = `${ts.toISOString()} [${level}] ${msg}\n`;
    // Write to today's rotated file
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        fs.appendFileSync(getRotatedLogFile(ts), line);
        fs.appendFileSync(LOG_FILE, line);
        // Trim master log to last 50000 lines to avoid unbounded growth
        try {
            const raw = fs.readFileSync(LOG_FILE, 'utf8');
            const lines = raw.split('\n');
            if (lines.length > 50000) {
                fs.writeFileSync(LOG_FILE, lines.slice(-40000).join('\n') + '\n');
            }
        } catch(_) {}
    } catch(e) { /* ignore if fs not available */ }
}

const logger = {
    info: (msg) => {
        const line = `${new Date().toISOString()} [INFO] ${msg}\n`;
        process.stdout.write(line);
        writeLog('INFO', msg);
    },
    error: (msg, err) => {
        let errStr = err;
        if (err) {
            if (err.message) errStr = err.message;
            else if (typeof err === 'object') {
                try { errStr = JSON.stringify(err); } catch(e) { errStr = String(err); }
            }
        }
        const errMsg = errStr ? ` - ${errStr}` : '';
        const line = `${new Date().toISOString()} [ERROR] ${msg}${errMsg}\n`;
        process.stderr.write(line);
        writeLog('ERROR', `${msg}${errMsg}`);
    },
    warn: (msg) => {
        const line = `${new Date().toISOString()} [WARN] ${msg}\n`;
        process.stdout.write(line);
        writeLog('WARN', msg);
    }
};

const telegramLogger = {
    log: (msg) => {
        const ts = new Date().toISOString();
        const line = `${ts} ${msg}\n`;
        try {
            if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
            fs.appendFileSync(TELEGRAM_LOG_FILE, line);
            // Limit to 5000 lines
            const raw = fs.readFileSync(TELEGRAM_LOG_FILE, 'utf8');
            const lines = raw.split('\n');
            if (lines.length > 5000) {
                fs.writeFileSync(TELEGRAM_LOG_FILE, lines.slice(-4000).join('\n') + '\n');
            }
        } catch (e) { /* ignore */ }
    }
};

/**
 * Efficiently reads the last N lines from a file.
 */
function getLastLogLines(filePath, lineCount = 100) {
    try {
        if (!fs.existsSync(filePath)) return `File non trovato: ${filePath}`;
        const stats = fs.statSync(filePath);
        const bufferSize = 1024 * 64; // 64KB chunks
        const buffer = Buffer.alloc(bufferSize);
        let lines = [];
        let pos = stats.size;
        let fd = fs.openSync(filePath, 'r');

        try {
            while (pos > 0 && lines.length <= lineCount) {
                const readSize = Math.min(pos, bufferSize);
                pos -= readSize;
                fs.readSync(fd, buffer, 0, readSize, pos);
                const chunk = buffer.slice(0, readSize).toString('utf8');
                const chunkLines = chunk.split('\n');
                
                if (lines.length > 0 && chunk[chunk.length - 1] !== '\n') {
                    // Prepend first line of 'lines' to the last line of 'chunkLines'
                    chunkLines[chunkLines.length - 1] += lines[0];
                    lines.shift();
                }
                lines = chunkLines.concat(lines);
            }
        } finally {
            fs.closeSync(fd);
        }

        return lines.slice(-(lineCount + 1)).join('\n').trim();
    } catch (e) {
        return `Errore durante la lettura dei log: ${e.message}`;
    }
}

module.exports = {
    logger,
    telegramLogger,
    getLastLogLines,
    LOG_FILE,
    LOGS_DIR,
    TELEGRAM_LOG_FILE,
    getRotatedLogFile
};
