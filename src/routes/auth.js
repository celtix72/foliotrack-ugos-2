const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const database = require('../db');
const { logger } = require('../utils/logger');
const { logAudit } = require('../utils/audit');
const { getTransporter } = require('../utils/mailer');
const { JWT_SECRET, JWT_COOKIE, JWT_EXPIRY } = require('../config');
const { requireAuth } = require('../middlewares/authMiddleware');
const { authLimiter, registerLimiter } = require('../middlewares/securityMiddleware');

const router = express.Router();

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username e password obbligatori' });
    }
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Brute force protection
    const settings = database.getSettings(1);
    const maxAttempts = parseInt(settings.auth_max_attempts || '5');
    const banMinutes = parseInt(settings.auth_ban_duration_minutes || '30');
    
    const failures = database.getLoginFailures(ip);
    if (failures.banned_until && new Date(failures.banned_until) > new Date()) {
        return res.status(403).json({ error: `Troppi tentativi falliti. IP bannato fino a: ${new Date(failures.banned_until).toLocaleString()}` });
    }

    const user = database.verifyUser(username, password);
    if (!user) {
        database.recordLoginFailure(ip, maxAttempts, banMinutes);
        logAudit(null, 'LOGIN_FAIL', { username }, req);
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Success: reset failures
    database.resetLoginFailures(ip);

    if (user.must_change_password === 1) {
        return res.json({ ok: false, require_password_change: true, user_id: user.id });
    }

    // Create session
    const sid = crypto.randomBytes(16).toString('hex');
    const ua = req.headers['user-agent'];
    database.db.prepare('INSERT INTO user_sessions (user_id, session_id, ip_address, user_agent) VALUES (?, ?, ?, ?)').run(user.id, sid, ip, ua);

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, display_name: user.display_name, sid: sid },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
    res.cookie(JWT_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
    });
    
    logAudit(user.id, 'LOGIN_SUCCESS', { role: user.role }, req);
    logger.info(`[AUTH] Login: ${user.username} (${user.role})`);
    return res.json({ ok: true, user: { username: user.username, email: user.email, role: user.role, display_name: user.display_name } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    const token = req.cookies[JWT_COOKIE];
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.sid) {
                database.db.prepare('DELETE FROM user_sessions WHERE session_id = ?').run(decoded.sid);
            }
        } catch (e) {}
    }
    res.clearCookie(JWT_COOKIE);
    return res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
    const dbUser = database.db.prepare('SELECT id, username, email, role, display_name, must_change_password FROM users WHERE id = ?').get(req.user.id);
    if (!dbUser) return res.status(404).json({ error: 'Utente non trovato' });
    return res.json({ user: dbUser });
});

// GET /api/auth/permissions
router.get('/permissions', requireAuth, (req, res) => {
    try {
        const perms = database.getUserPermissions(req.user.role);
        res.json({ permissions: perms });
    } catch (e) {
        logger.error(`[AUTH] Error fetching permissions: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username ed email obbligatori' });
    
    const existing = database.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) return res.status(409).json({ error: 'Username o email già in uso' });

    const generatedPassword = crypto.randomBytes(6).toString('hex'); // 12 chars

    try {
        const user = database.createUser(username, generatedPassword, email, 'free', username, 1);
        
        const mailer = getTransporter();
        await mailer.sendMail({
            from: `"M2T Portfolio" <${mailer.defaultFrom}>`,
            to: email,
            subject: 'Il tuo nuovo account M2T Tracker',
            text: `Benvenuto ${username},\n\nIl tuo account è stato creato.\nLa tua password temporanea è: ${generatedPassword}\n\nTi verrà chiesto di cambiarla al primo accesso.\nQuesta password è valida per 24 ore.`
        });

        logger.info(`[AUTH] Registered new user: ${username}`);
        res.json({ ok: true, message: 'Account creato. Controlla l\'email per la password.' });
    } catch (e) {
        logger.error(`[AUTH] Registration error: ${e.message}`);
        res.status(500).json({ error: 'Errore durante la registrazione' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'La nuova password deve essere di almeno 8 caratteri' });

    // Require a valid session
    const token = req.cookies[JWT_COOKIE] || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non autenticato' });

    let userId;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
    } catch (e) {
        return res.status(401).json({ error: 'Sessione non valida o scaduta' });
    }

    const user = database.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    if (!current_password) return res.status(400).json({ error: 'Password corrente obbligatoria' });
    const valid = bcrypt.compareSync(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Password corrente errata' });

    const hash = bcrypt.hashSync(new_password, 10);
    database.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, userId);
    
    logger.info(`[AUTH] User ${user.username} changed password`);
    res.json({ ok: true });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obbligatoria' });

    const user = database.db.prepare('SELECT id, username FROM users WHERE email = ?').get(email);
    if (!user) return res.json({ ok: true, message: 'Se l\'email esiste riceverai un link di ripristino.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 ora

    database.db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?').run(resetToken, expiry, user.id);

    try {
        const resetLink = `http://${req.headers.host}/login?reset_token=${resetToken}`;
        const mailer = getTransporter();
        await mailer.sendMail({
            from: `"M2T Portfolio" <${mailer.defaultFrom}>`,
            to: email,
            subject: 'Ripristino password M2T Tracker',
            text: `Ciao ${user.username},\n\nHai richiesto il ripristino della password.\nClicca qui per impostare una nuova password:\n${resetLink}\n\nIl link è valido per 1 ora.`
        });
    } catch (e) {
        logger.error(`[AUTH] Error sending reset email: ${e.message}`);
    }

    res.json({ ok: true, message: 'Se l\'email esiste riceverai un link di ripristino.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password || new_password.length < 8) return res.status(400).json({ error: 'Token o password non validi (min. 8 caratteri)' });

    const user = database.db.prepare('SELECT id, reset_token_expiry FROM users WHERE reset_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Token non valido o scaduto' });

    if (new Date() > new Date(user.reset_token_expiry)) {
        return res.status(400).json({ error: 'Token scaduto' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    database.db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, must_change_password = 0 WHERE id = ?').run(hash, user.id);
    
    logger.info(`[AUTH] User reset password via token`);
    res.json({ ok: true });
});

module.exports = router;
