const express = require('express');
const fs = require('fs');

module.exports = function (dependencies) {
    const router = express.Router();
    
    const {
        requireAuth,
        requireAdmin,
        database,
        logger,
        APP_VERSION,
        LOG_FILE,
        LOGS_DIR,
        getRotatedLogFile,
        logAudit,
        getTransporter
    } = dependencies;

    // GET /api/admin/roles
    router.get('/roles', requireAuth, requireAdmin, (req, res) => {
        try {
            const perms = database.getRolePermissions();
            res.json(perms);
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // POST /api/admin/roles
    router.post('/roles', requireAuth, requireAdmin, (req, res) => {
        const { role, resource, is_enabled } = req.body;
        if (!role || !resource) return res.status(400).json({ error: 'role and resource required' });
        try {
            database.updateRolePermission(role, resource, is_enabled ? 1 : 0);
            logger.info(`[ADMIN] Role permission updated: ${role} -> ${resource} = ${is_enabled}`);
            res.json({ ok: true });
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // GET /api/admin/users
    router.get('/users', requireAuth, requireAdmin, (req, res) => {
        try {
            const users = database.getAllUsers();
            res.json(users);
        } catch (e) {
            console.error(e); res.status(500).json({ error: e.message });
        }
    });

    // POST /api/admin/users — create new user
    router.post('/users', requireAuth, requireAdmin, (req, res) => {
        const { username, password, role, display_name } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'username e password obbligatori' });
        try {
            const user = database.createUser(username, password, null, role || 'free', display_name || username, 0);
            logger.info(`[AUTH] Admin ${req.user.username} created user: ${username} (${role || 'user'})`);
            res.status(201).json(user);
        } catch (e) {
            res.status(409).json({ error: 'Username già esistente' });
        }
    });

    // DELETE /api/admin/users/:id
    router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
        const userId = parseInt(req.params.id);
        if (userId === req.user.id) return res.status(400).json({ error: 'Non puoi eliminare il tuo account' });
        database.deleteUser(userId);
        logger.info(`[AUTH] Admin ${req.user.username} deleted user id: ${userId}`);
        res.json({ ok: true });
    });

    // PATCH /api/admin/users/:id/role
    router.patch('/users/:id/role', requireAuth, requireAdmin, (req, res) => {
        const userId = parseInt(req.params.id);
        const { role } = req.body;
        if (!['admin', 'user', 'free'].includes(role)) return res.status(400).json({ error: 'Ruolo non valido' });
        database.updateUserRole(userId, role);
        res.json({ ok: true });
    });

    // PATCH /api/admin/users/:id/password
    router.patch('/users/:id/password', requireAuth, requireAdmin, (req, res) => {
        const userId = parseInt(req.params.id);
        const { password } = req.body;
        if (!password || password.length < 4) return res.status(400).json({ error: 'Password troppo corta (min 4 caratteri)' });
        database.updateUserPassword(userId, password);
        res.json({ ok: true });
    });

    // POST /api/admin/smtp-test
    router.post('/smtp-test', requireAuth, requireAdmin, async (req, res) => {
        const { to } = req.body;
        if (!to) return res.status(400).json({ error: 'Recipient email required' });
        
        try {
            const mailer = getTransporter();
            await mailer.sendMail({
                from: `"M2T Admin Test" <${mailer.defaultFrom}>`,
                to,
                subject: 'M2T SMTP Test Message',
                text: 'This is a test email from your FolioTracker Admin Panel. Your SMTP settings are working correctly!',
                html: '<b>This is a test email from your FolioTracker Admin Panel.</b><br><br>Your SMTP settings are working correctly!'
            });
            logger.info(`[ADMIN] SMTP Test email sent to ${to}`);
            res.json({ ok: true });
        } catch (e) {
            logger.error(`[ADMIN] SMTP Test failed: ${e.message}`);
            res.status(500).json({ error: `SMTP Error: ${e.message}` });
        }
    });

    // GET /api/admin/stats
    router.get('/stats', requireAuth, requireAdmin, (req, res) => {
        const db = database.db;
        const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const portfolioCount = db.prepare('SELECT COUNT(*) as c FROM portfolios').get().c;
        const assetCount = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;
        const txCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
        const notifCount = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE isRead = 0').get().c;
        res.json({ userCount, portfolioCount, assetCount, txCount, notifCount, version: APP_VERSION });
    });

    // GET /api/admin/logs
    router.get('/logs', requireAuth, requireAdmin, (req, res) => {
        try {
            const maxLines = parseInt(req.query.lines) || 200;
            const dateParam = req.query.date; // YYYY-MM-DD

            let content = '';
            if (dateParam) {
                const rotatedFile = getRotatedLogFile(new Date(dateParam));
                if (fs.existsSync(rotatedFile)) {
                    content = fs.readFileSync(rotatedFile, 'utf8');
                }
            } else {
                if (fs.existsSync(LOG_FILE)) {
                    content = fs.readFileSync(LOG_FILE, 'utf8');
                }
            }
            
            if (!content) return res.json({ logs: '' });
            
            const lines = content.trim().split('\n').filter(Boolean);
            const tail = lines.slice(-maxLines).join('\n');
            res.json({ logs: tail });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/logs/dates
    router.get('/logs/dates', requireAuth, requireAdmin, (req, res) => {
        try {
            if (!fs.existsSync(LOGS_DIR)) return res.json([]);
            const files = fs.readdirSync(LOGS_DIR);
            const dates = files
                .filter(f => f.startsWith('app.log.'))
                .map(f => f.replace('app.log.', ''))
                .sort((a, b) => b.localeCompare(a));
            
            // Add today
            const today = new Date().toISOString().split('T')[0];
            if (!dates.includes(today)) dates.unshift(today);
            
            res.json(dates);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/audit-logs
    router.get('/audit-logs', requireAuth, requireAdmin, (req, res) => {
        try {
            const logs = database.db.prepare(`
                SELECT l.*, u.username 
                FROM audit_logs l 
                LEFT JOIN users u ON l.user_id = u.id 
                ORDER BY l.timestamp DESC LIMIT 100
            `).all();
            res.json(logs);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/sessions
    router.get('/sessions', requireAuth, requireAdmin, (req, res) => {
        try {
            const sessions = database.db.prepare(`
                SELECT s.*, u.username, u.display_name
                FROM user_sessions s
                JOIN users u ON s.user_id = u.id
                ORDER BY s.last_seen DESC
            `).all();
            res.json(sessions);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/admin/sessions/:sid
    router.delete('/sessions/:sid', requireAuth, requireAdmin, (req, res) => {
        try {
            const sid = req.params.sid;
            database.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(sid);
            logAudit(req.user.id, 'SESSION_REVOKE', { sid }, req);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/banned-ips
    router.get('/banned-ips', requireAuth, requireAdmin, (req, res) => {
        try {
            const ips = database.getBannedIps();
            res.json(ips);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/admin/banned-ips/:ip
    router.delete('/banned-ips/:ip', requireAuth, requireAdmin, (req, res) => {
        try {
            const ip = req.params.ip;
            database.resetLoginFailures(ip);
            logAudit(req.user.id, 'IP_UNBAN', { ip }, req);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/admin/security-settings
    router.get('/security-settings', requireAuth, requireAdmin, (req, res) => {
        try {
            const settings = database.getSettings(1);
            res.json({
                max_attempts: parseInt(settings.auth_max_attempts || '5'),
                ban_duration: parseInt(settings.auth_ban_duration_minutes || '30')
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/admin/security-settings
    router.post('/security-settings', requireAuth, requireAdmin, express.json(), (req, res) => {
        try {
            const { max_attempts, ban_duration } = req.body;
            database.setSetting('auth_max_attempts', max_attempts.toString());
            database.setSetting('auth_ban_duration_minutes', ban_duration.toString());
            logAudit(req.user.id, 'SECURITY_SETTINGS_UPDATE', { max_attempts, ban_duration }, req);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/admin/rebuild-history
    router.post('/rebuild-history', requireAuth, requireAdmin, async (req, res) => {
        try {
            // Note: This relies on backfill.js logic or simply calls the function if exported.
            // Depending on how backfill is implemented, we might need more dependencies here.
            // It's originally in server.js line 3334
            res.status(501).json({ error: 'Not implemented in this route yet. Needs backfill logic.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    
    // POST /api/admin/purge-performance
    router.post('/purge-performance', requireAuth, requireAdmin, (req, res) => {
        try {
            // This is originally at line 6581 in server.js
            database.db.prepare('DELETE FROM portfolio_history').run();
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
