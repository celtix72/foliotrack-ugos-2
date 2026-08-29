const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

function configureSecurity(app) {
    // ─── Security Headers (Helmet) ───────────────────────────────────────────────
    const isCspDisabled = process.env.DISABLE_CSP === 'true';

    const cspDirectivesBase = {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
            'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'https:'],
        scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
            'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'https:'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'",
            'fonts.googleapis.com', 'cdnjs.cloudflare.com',
            'fonts.gstatic.com', 'https:'],
        styleSrcElem: ["'self'", "'unsafe-inline'",
            'fonts.googleapis.com', 'cdnjs.cloudflare.com',
            'fonts.gstatic.com', 'https:'],
        fontSrc: ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net',
            'cdnjs.cloudflare.com', 'data:', 'https:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'https:', 'wss:', 'ws:'],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // DIAGNOSTICA TEMPORANEA: riceve i violation report dal browser
        reportUri: ['/api/csp-report'],
    };


    const helmetHTTPS = helmet({
        contentSecurityPolicy: isCspDisabled ? false : { directives: cspDirectivesBase },
        crossOriginEmbedderPolicy: false,
        crossOriginOpenerPolicy: { policy: 'same-origin' },
        strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    });

    const helmetHTTP = helmet({
        contentSecurityPolicy: isCspDisabled ? false : {
            directives: {
                ...cspDirectivesBase,
                upgradeInsecureRequests: null,
            }
        },
        crossOriginEmbedderPolicy: false,
        crossOriginOpenerPolicy: false,
        originAgentCluster: false,
        strictTransportSecurity: false,
    });

    app.use((req, res, next) => {
        const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
        return isHttps ? helmetHTTPS(req, res, next) : helmetHTTP(req, res, next);
    });

    // ─── CORS ─────────────────────────────────────────────────────────────────────
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error(`CORS: origin not allowed — ${origin}`));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }));

    // General API limiter
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Troppe richieste. Riprova tra qualche minuto.' },
    });

    app.use('/api/', apiLimiter);
}

// Strict limiter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppi tentativi di accesso. Riprova tra 15 minuti.' },
});

// Very strict limiter for registration
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Limite registrazioni raggiunto. Riprova tra un\'ora.' },
});

module.exports = {
    configureSecurity,
    authLimiter,
    registerLimiter
};
