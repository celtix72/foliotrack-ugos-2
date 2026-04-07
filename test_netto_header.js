function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

const totalVarEUR = 123.45;
const totalNetValue = 23876.54; // Mocked tax-adjusted value
const singleEmoji = '🟢';

const totalSign = totalVarEUR >= 0 ? '+' : '-';
const totalAbs = Math.abs(totalVarEUR).toFixed(0);

let msg = `📊 1D: *${escapeV2(totalSign + '€' + totalAbs)}* ${singleEmoji}         Netto: *${escapeV2('€' + Math.round(totalNetValue).toLocaleString('it-IT'))}* 💰\n\n`;

console.log('--- NETTO HEADER TEST ---');
console.log(msg);
console.log('-------------------------');
