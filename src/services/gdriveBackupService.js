'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { db, getSettings } = require('../db');
const { createZipBuffer } = require('../utils/zip');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'foliotrack.db');

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Base64URL encoding helper
 */
function base64url(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Resolve settings for GDrive, falling back to the first available admin or user.
 */
function resolveSettings(userSettings = null) {
    if (userSettings && typeof userSettings === 'object' && Object.keys(userSettings).length > 0) {
        return userSettings;
    }
    try {
        const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
        if (admin) return getSettings(admin.id);
        const firstUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
        if (firstUser) return getSettings(firstUser.id);
    } catch (e) {}
    return getSettings(1);
}

/**
 * Obtain Google OAuth2 Access Token via Service Account JWT or Refresh Token.
 */
async function getAccessToken(userSettings = null) {
    const settings = resolveSettings(userSettings);

    const clientEmail = (settings.gdrive_client_email || '').trim();
    let privateKey    = (settings.gdrive_private_key || '').trim();
    const clientId    = (settings.gdrive_client_id || '').trim();
    const clientSecret= (settings.gdrive_client_secret || '').trim();
    const refreshToken= (settings.gdrive_refresh_token || '').trim();

    // Option A: Service Account JWT
    if (clientEmail && privateKey) {
        // Fix formatted newlines in private key if entered as single line
        if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
            privateKey = privateKey.replace(/\\n/g, '\n');
        }

        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claimSet = {
            iss: clientEmail,
            scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        };

        const unsignedToken = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(unsignedToken);
        const signature = signer.sign(privateKey, 'base64url');
        const jwt = `${unsignedToken}.${signature}`;

        const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        return res.data.access_token;
    }

    // Option B: OAuth2 Refresh Token
    if (clientId && clientSecret && refreshToken) {
        const res = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        return res.data.access_token;
    }

    throw new Error('Credenziali Google Drive non configurate. Configura Service Account o OAuth2 in Impostazioni.');
}

/**
 * List files in the configured Google Drive folder.
 */
async function listRemoteBackups(userSettings = null) {
    const settings = resolveSettings(userSettings);
    const folderId = (settings.gdrive_folder_id || '').trim();
    if (!folderId) throw new Error('ID cartella Google Drive non specificato.');

    const token = await getAccessToken(settings);
    const q = `'${folderId}' in parents and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,size,mimeType)&orderBy=createdTime desc`;

    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.files || [];
}

/**
 * Upload a zip buffer to Google Drive.
 */
async function uploadToDrive(zipBuffer, filename, userSettings = null) {
    const settings = resolveSettings(userSettings);
    const folderId = (settings.gdrive_folder_id || '').trim();
    if (!folderId) throw new Error('ID cartella Google Drive non specificato.');

    const token = await getAccessToken(settings);

    const metadata = {
        name: filename,
        parents: [folderId],
        mimeType: 'application/zip'
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metaPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
    const fileHeader = `${delimiter}Content-Type: application/zip\r\n\r\n`;

    const bodyBuffer = Buffer.concat([
        Buffer.from(metaPart, 'utf8'),
        Buffer.from(fileHeader, 'utf8'),
        zipBuffer,
        Buffer.from(closeDelimiter, 'utf8')
    ]);

    const res = await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        bodyBuffer,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': bodyBuffer.length
            }
        }
    );

    return res.data;
}

/**
 * Delete a file from Google Drive by file ID.
 */
async function deleteRemoteFile(fileId, userSettings = null) {
    const settings = resolveSettings(userSettings);
    const token = await getAccessToken(settings);
    await axios.delete(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
}

/**
 * Smart Retention Policy Calculator.
 * - 1 backup per day for up to 7 days (Daily retention window)
 * - 1 backup per week for up to 4 weeks (Weekly retention window)
 * Returns arrays: { keepers: [...], toDelete: [...] }
 */
function evaluateRetentionPolicy(fileList) {
    // Sort files descending by created date
    const sorted = [...fileList].sort((a, b) => new Date(b.createdTime || b.name) - new Date(a.createdTime || a.name));

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const keepers = new Set();
    const toDelete = [];

    // Helper: format YYYY-MM-DD
    const toDayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    
    // Helper: ISO Week key YYYY-Www
    const toWeekKey = d => {
        const date = new Date(d.getTime());
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
        const week1 = new Date(date.getFullYear(), 0, 4);
        const weekNum = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
        return `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    };

    // 1. Daily Retention Window: Last 7 days (day 0 to day 6)
    const dailyKeys = new Set();
    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dailyKeys.add(toDayKey(d));
    }

    // 2. Weekly Retention Window: Last 4 weeks (week 1 to week 4)
    const weeklyKeys = new Set();
    for (let i = 0; i < 4; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - (7 * i));
        weeklyKeys.add(toWeekKey(d));
    }

    const seenDays = new Set();
    const seenWeeks = new Set();

    for (const item of sorted) {
        const itemDate = new Date(item.createdTime || Date.now());
        const dayKey = toDayKey(itemDate);
        const weekKey = toWeekKey(itemDate);

        let keep = false;

        // Is it within the 7-day daily window?
        if (dailyKeys.has(dayKey)) {
            if (!seenDays.has(dayKey)) {
                seenDays.add(dayKey);
                keep = true;
            }
        }
        // Is it within the 4-week weekly window?
        else if (weeklyKeys.has(weekKey)) {
            if (!seenWeeks.has(weekKey)) {
                seenWeeks.add(weekKey);
                keep = true;
            }
        }

        if (keep) {
            keepers.add(item.id || item.name);
        } else {
            toDelete.push(item);
        }
    }

    return {
        keepers: sorted.filter(f => keepers.has(f.id || f.name)),
        toDelete
    };
}

/**
 * Apply retention policy on Google Drive and local backups.
 */
async function applySmartRetention(userSettings = null) {
    const settings = resolveSettings(userSettings);

    // Remote retention
    try {
        const remoteFiles = await listRemoteBackups(settings);
        const gdriveBackups = remoteFiles.filter(f => f.name.startsWith('foliotrack_backup_') && f.name.endsWith('.zip'));
        const { toDelete } = evaluateRetentionPolicy(gdriveBackups);

        for (const file of toDelete) {
            try {
                console.log(`[GDrive Retention] Deleting old remote backup: ${file.name} (${file.id})`);
                await deleteRemoteFile(file.id, settings);
            } catch (e) {
                console.error(`[GDrive Retention] Failed to delete remote file ${file.name}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[GDrive Retention] Remote retention error:', e.message);
    }

    // Local retention
    try {
        const localFiles = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('foliotrack_backup_') && f.endsWith('.zip'))
            .map(name => {
                const stat = fs.statSync(path.join(BACKUP_DIR, name));
                return { name, id: name, createdTime: stat.mtime.toISOString() };
            });

        const { toDelete } = evaluateRetentionPolicy(localFiles);
        for (const file of toDelete) {
            const fullPath = path.join(BACKUP_DIR, file.name);
            const metaPath = fullPath + '.json';
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
            console.log(`[Local Retention] Deleted old local backup: ${file.name}`);
        }
    } catch (e) {
        console.error('[Local Retention] Error:', e.message);
    }
}

/**
 * Execute a complete zipped backup (local + Google Drive upload + smart retention).
 */
async function runGDriveBackup(isScheduled = false, userSettings = null) {
    const settings = resolveSettings(userSettings);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipName = `foliotrack_backup_${timestamp}${isScheduled ? '-auto' : '-manual'}.zip`;
    const tempDbPath = path.join(BACKUP_DIR, `temp_${Date.now()}.db`);
    const localZipPath = path.join(BACKUP_DIR, zipName);

    try {
        // 1. Perform SQLite hot backup
        await db.backup(tempDbPath);

        // 2. Build metadata
        const versionRow = db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").get();
        const schemaVersion = versionRow ? versionRow.value : '1.0';

        const metadata = {
            filename: zipName,
            timestamp: new Date().toISOString(),
            isScheduled,
            schemaVersion,
            app: 'FolioTrack',
            created: new Date().toLocaleString('it-IT')
        };

        // 3. Create zip buffer with SQLite DB + Metadata JSON
        const filesToZip = [
            { name: 'foliotrack.db', path: tempDbPath },
            { name: 'metadata.json', data: JSON.stringify(metadata, null, 2) }
        ];

        const zipFiles = filesToZip.map(item => {
            const data = item.path ? fs.readFileSync(item.path) : Buffer.from(item.data, 'utf8');
            return { name: item.name, data };
        });

        const zipBuf = createZipBuffer(zipFiles);

        // 4. Save local copy
        fs.writeFileSync(localZipPath, zipBuf);
        fs.writeFileSync(localZipPath + '.json', JSON.stringify({ ...metadata, size: zipBuf.length }, null, 2));

        // Clean up temp db
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);

        // 5. Upload to Google Drive if credentials exist
        let driveResult = null;
        const gdriveEnabled = (settings.gdrive_enabled === 'true' || settings.gdrive_enabled === true);
        if (gdriveEnabled || !isScheduled) {
            console.log(`[GDrive Backup] Uploading ${zipName} to Google Drive...`);
            driveResult = await uploadToDrive(zipBuf, zipName, settings);
            console.log(`[GDrive Backup] Upload successful. ID: ${driveResult.id}`);

            // Apply smart retention policy
            await applySmartRetention(settings);
        }

        return {
            success: true,
            zipName,
            size: zipBuf.length,
            driveResult,
            timestamp: metadata.timestamp
        };
    } catch (err) {
        if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
        console.error('[GDrive Backup] Failed:', err);
        throw err;
    }
}

/**
 * Test Google Drive connection and folder access.
 */
async function testGDriveConnection(userSettings = null) {
    try {
        const settings = resolveSettings(userSettings);
        const files = await listRemoteBackups(settings);
        return {
            success: true,
            fileCount: files.length,
            message: `Connessione a Google Drive riuscita. ${files.length} file trovati nella cartella.`
        };
    } catch (err) {
        return {
            success: false,
            error: err.response?.data?.error?.message || err.message
        };
    }
}

module.exports = {
    getAccessToken,
    listRemoteBackups,
    uploadToDrive,
    deleteRemoteFile,
    evaluateRetentionPolicy,
    applySmartRetention,
    runGDriveBackup,
    testGDriveConnection
};
