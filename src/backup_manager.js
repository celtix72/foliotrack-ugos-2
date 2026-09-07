'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

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
    
    const allFiles = fs.readdirSync(BACKUP_DIR);
    const backupFiles = allFiles.filter(f => f.match(/^(?:backup-[\w.-]+-(?:auto|manual)\.db|foliotrack_backup_[\w.-]+\.zip)$/));
    
    const results = [];
    for (const filename of backupFiles) {
        const fullPath = path.join(BACKUP_DIR, filename);
        const metaPath = fullPath + '.json';
        let meta = null;
        if (fs.existsSync(metaPath)) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            } catch (e) {}
        }
        if (!meta) {
            try {
                const stat = fs.statSync(fullPath);
                meta = {
                    filename,
                    timestamp: stat.mtime.toISOString(),
                    isScheduled: filename.includes('-auto'),
                    schemaVersion: '1.0',
                    size: stat.size
                };
            } catch (e) {}
        }
        if (meta) results.push(meta);
    }

    return results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Deletes a backup by filename.
 */
function deleteBackup(filename) {
    // Sanitize: accept only the basename, no directory traversal
    const safeName = path.basename(filename);
    if (!safeName.match(/^(?:backup-[\w.-]+-(?:auto|manual)\.db|foliotrack_backup_[\w.-]+\.zip)$/)) {
        throw new Error('Nome backup non valido');
    }
    const dbPath = path.join(BACKUP_DIR, safeName);
    const metaPath = dbPath + '.json';
    
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

/**
 * Prunes old automatic backups based on retention setting.
 */
async function applyRetention() {
    const settings = require('./db').getSettings(1);
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
    // Sanitize: accept only the basename, no directory traversal
    const safeName = path.basename(filename);
    if (!safeName.match(/^backup-[\w.-]+-(?:auto|manual)\.db$/)) {
        throw new Error('Nome backup non valido');
    }
    const backupPath = path.join(BACKUP_DIR, safeName);
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

    const dbStore = require('./db');
    
    // 1. Close current connection via dbStore.initDb (it handles closing)
    // Actually, we must close it first to release the file lock on Windows/Mac
    dbStore.db.close();
    
    try {
        // 2. Overwrite live DB with backup
        fs.copyFileSync(backupPath, DB_PATH);
        
        // 3. Re-initialize DB connection
        dbStore.initDb();
        
        console.log('Hot Restore complete. Database re-initialized.');
        return true;
    } catch (err) {
        console.error('File swap failed during restore:', err);
        // Try to recover connection to old state if copy failed
        dbStore.initDb();
        throw err;
    }
}

module.exports = {
    createBackup,
    listBackups,
    deleteBackup,
    restoreBackup
};
