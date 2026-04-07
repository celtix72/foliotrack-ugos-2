function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

const totalVarEUR = 123.45;
const totalValEUR = 25000.78;
const singleEmoji = '🟢';

const totalSign = totalVarEUR >= 0 ? '+' : '-';
const totalAbs = Math.abs(totalVarEUR).toFixed(0);

let msg = `📊 1D: *${escapeV2(totalSign + '€' + totalAbs)}* ${singleEmoji}         Net: *${escapeV2('€' + Math.round(totalValEUR).toLocaleString('it-IT'))}* 💰\n\n`;

console.log('--- REFINED HEADER TEST ---');
console.log(msg);
console.log('---------------------------');
