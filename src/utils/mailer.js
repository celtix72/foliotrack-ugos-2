const nodemailer = require('nodemailer');
const database = require('../db');

let transporterInstance = null;
function getTransporter() {
    if (transporterInstance) return transporterInstance;
    const settings = database.getSettings(1); // Use admin settings for SMTP
    const smtpHost = settings.smtp_host || process.env.SMTP_HOST || 'smtp.ethereal.email';
    const smtpPort = parseInt(settings.smtp_port) || parseInt(process.env.SMTP_PORT) || 587;
    const smtpUser = settings.smtp_user || process.env.SMTP_USER || '';
    const smtpPass = settings.smtp_pass || process.env.SMTP_PASS || '';
    const smtpFrom = settings.smtp_from || process.env.SMTP_FROM || smtpUser || 'noreply@foliotrack.com';
    
    transporterInstance = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
            user: smtpUser,
            pass: smtpPass
        }
    });
    // Add the from address to the instance for easy access
    transporterInstance.defaultFrom = smtpFrom;
    return transporterInstance;
}

function resetTransporter() {
    transporterInstance = null;
}

module.exports = {
    getTransporter,
    resetTransporter
};
