const jwt = require('jsonwebtoken');
const database = require('../db');
const { JWT_COOKIE, JWT_SECRET } = require('../config');

/**
 * Verifies JWT from cookie or Authorization header.
 * Attaches req.user = { id, username, role, display_name } on success.
 */
function requireAuth(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    const token = req.cookies[JWT_COOKIE] || (req.headers.authorization || '').replace('Bearer ', '');
    const isApi = req.originalUrl.startsWith('/api/');

    if (!token) {
        if (isApi) return res.status(401).json({ error: 'Non autenticato' });
        return res.redirect('/login');
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Session Check
        if (decoded.sid) {
            const session = database.db.prepare('SELECT id FROM user_sessions WHERE session_id = ?').get(decoded.sid);
            if (!session) {
                res.clearCookie(JWT_COOKIE);
                if (isApi) return res.status(401).json({ error: 'Sessione revocata o scaduta' });
                return res.redirect('/login?error=session_revoked');
            }
            // Update last seen
            database.db.prepare("UPDATE user_sessions SET last_seen = datetime('now') WHERE session_id = ?").run(decoded.sid);
        }

        req.user = decoded;
        next();
    } catch (e) {
        if (isApi) return res.status(401).json({ error: 'Token non valido o scaduto' });
        return res.redirect('/login');
    }
}

/**
 * Requires admin role after requireAuth.
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        if (req.accepts('html')) return res.redirect('/dashboard');
        return res.status(403).json({ error: 'Accesso negato: richiesto ruolo admin' });
    }
    next();
}

/**
 * Ensures the authenticated user has access to the portfolio.
 * Looks for portfolioId in req.params or req.body.
 */
function requirePortfolioAccess(req, res, next) {
    const portfolioId = req.params.portfolioId || req.params.id || req.body.portfolioId;
    if (!portfolioId) return next();

    try {
        const access = database.db.prepare('SELECT 1 FROM portfolio_users WHERE portfolio_id = ? AND user_id = ?').get(portfolioId, req.user.id);
        if (!access && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Accesso negato a questo portafoglio' });
        }
        next();
    } catch (e) {
        res.status(500).json({ error: 'Errore verifica permessi' });
    }
}

const PUBLIC_API_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/app-version'
]);

// Minimal set of public GET endpoints:
// - market-status: used by header_indices.js loaded in all authenticated pages,
//   but also potentially before login in the theme. Kept public to avoid breaking
//   the header on slow connections. All other market/asset data requires auth.
const PUBLIC_API_PATTERNS = [
    /^\/api\/market-status$/
];

function isPublicApiRequest(req) {
    const path = req.path === '/' ? '/api' : `/api${req.path}`;

    if (req.method === 'POST') return PUBLIC_API_PATHS.has(path);
    if (req.method !== 'GET') return false;
    if (PUBLIC_API_PATHS.has(path)) return true;

    return PUBLIC_API_PATTERNS.some(pattern => pattern.test(path));
}

const publicApiMiddleware = (req, res, next) => {
    if (isPublicApiRequest(req)) return next();
    return requireAuth(req, res, next);
};

module.exports = {
    requireAuth,
    requireAdmin,
    requirePortfolioAccess,
    publicApiMiddleware
};
