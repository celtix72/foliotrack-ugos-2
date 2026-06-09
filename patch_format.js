const fs = require('fs');
let code = fs.readFileSync('public/theme.js', 'utf8');

const oldFormat = `    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatCurrency = function(val, currency = 'EUR', decimals = 2) {`;

const newFormat = `    // ─── Global Formatting ────────────────────────────────────────────────────
    window.formatAiFv = function(val, currency = 'EUR') {
        if (val === null || val === undefined) return '—';
        const num = parseFloat(val);
        if (isNaN(num)) return val;
        let decimals = 2;
        if (num > 30) decimals = 0;
        else if (num > 10) decimals = 1;
        return window.formatCurrency(num, currency, decimals);
    };

    window.formatCurrency = function(val, currency = 'EUR', decimals = 2) {`;

code = code.replace(oldFormat, newFormat);
fs.writeFileSync('public/theme.js', code, 'utf8');
console.log('Patched theme.js with formatAiFv');
