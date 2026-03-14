'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('./database');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'foliotrack.db');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Creates a backup of the current database.
 */
async function createBackup(isScheduled = false) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}${isScheduled ? '-auto' : '-manual'}.db`;
    const filepath = path.join(BACKUP_DIR, filename);
    const metaPath = filepath + '.json';

    try {
        // SQLite Hot Backup
        await db.backup(filepath);

        // Get current version from db
        const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get();
        const schemaVersion = versionRow ? versionRow.value : '1.0';

        const metadata = {
            filename,
            timestamp: new Date().toISOString(),
            isScheduled,
            schemaVersion,
            size: fs.statSync(filepath).size
        };

        fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
        console.log(`Backup created: ${filename}`);

        // Apply retention if scheduled
        if (isScheduled) {
            await applyRetention();
        }

        return metadata;
    } catch (err) {
        console.error('Backup failed:', err);
        throw err;
    }
}

/**
 * Lists all available backups.
 */
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.db.json'))
        .map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
            } catch (e) {
                return null;
            }
        })
        .filter(b => b !== null)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Deletes a backup by filename.
 */
function deleteBackup(filename) {
    const dbPath = path.join(BACKUP_DIR, filename);
    const metaPath = dbPath + '.json';
    
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

/**
 * Prunes old automatic backups based on retention setting.
 */
async function applyRetention() {
    const settings = require('./database').getSettings();
    const limit = parseInt(settings.backupRetention || 5);
    
    const backups = listBackups()
        .filter(b => b.isScheduled);

    if (backups.length > limit) {
        const toDelete = backups.slice(limit);
        for (const b of toDelete) {
            console.log(`Pruning old backup: ${b.filename}`);
            deleteBackup(b.filename);
        }
    }
}

/**
 * Restores the database from a backup file.
 * WARNING: This is destructive.
 */
async function restoreBackup(filename) {
    const backupPath = path.join(BACKUP_DIR, filename);
    const metaPath = backupPath + '.json';

    if (!fs.existsSync(backupPath) || !fs.existsSync(metaPath)) {
        throw new Error('Backup file not found');
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const currentVersionRow = db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get();
    const currentVersion = currentVersionRow ? currentVersionRow.value : '1.0';

    // Basic compatibility check (major version match)
    const backupMajor = metadata.schemaVersion.split('.')[0];
    const currentMajor = currentVersion.split('.')[0];

    if (backupMajor !== currentMajor) {
        throw new Error(`Incompatible backup version: ${metadata.schemaVersion} (Current: ${currentVersion})`);
    }

    console.log(`Restoring from ${filename}...`);

    // In better-sqlite3, we can't easily "hot swap" the main file while open
    // without potentially corrupting other queries. 
    // The safest way is to close the current DB, swap files, and let the caller restart the app.
    // However, for this implementation, we will use the backup API in reverse if possible,
    // or just copy the file. copying is easier if we manage the process.
    
    // Actually, SQLite backup() can also be used to RESTORE (dest to source)
    // but better-sqlite3 backup() only goes source -> dest.
    
    // Safer approach: 
    // 1. Close DB
    // 2. Copy backup to DB_PATH
    // 3. Exit process (shell/docker will restart)
    
    db.close();
    fs.copyFileSync(backupPath, DB_PATH);
    
    console.log('Restore complete. Restarting application...');
    process.exit(0);
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    restoreBackup
};
