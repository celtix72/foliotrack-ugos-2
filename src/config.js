const crypto = require('crypto');

function getRequiredSecret(name) {
    const value = (process.env[name] || '').trim();
    if (value) return value;

    if (process.env.NODE_ENV === 'development') {
        const temporarySecret = crypto.randomBytes(32).toString('hex');
        console.warn(`[SECURITY] ${name} is not set. Using a temporary random secret for this process only.`);
        return temporarySecret;
    }

    throw new Error(`${name} is required. Set it in the environment before starting the server.`);
}

module.exports = {
    JWT_SECRET: getRequiredSecret('JWT_SECRET'),
    JWT_COOKIE: 'ft_token',
    JWT_EXPIRY: '7d',
};
