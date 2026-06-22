const database = require('../db');
const { logger } = require('./logger');

function logAudit(userId, action, details, req) {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ua = req.headers['user-agent'];
        database.db.prepare(`
            INSERT INTO audit_logs (user_id, action, details, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?)
        `).run(userId, action, typeof details === 'string' ? details : JSON.stringify(details), ip, ua);
    } catch (e) {
        logger.error(`[AUDIT] Failed to log ${action}: ${e.message}`);
    }
}

module.exports = {
    logAudit
};
