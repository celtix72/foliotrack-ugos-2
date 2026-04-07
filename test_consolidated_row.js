function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

const sym = 'TDIV    ';
const mktVal = '52.33';
const cSym = '€';
const valChange = '-€20';
const pctChange = '-0.63%';

const rowData = `${sym} ${cSym + mktVal.padStart(7)} ${valChange.padStart(8)} ${pctChange.padStart(8)}`;
const row = `📉 \`${escapeCodeV2(rowData)}\` 🔴`;

console.log('--- CONSOLIDATED ROW TEST ---');
console.log(row);
console.log('-----------------------------');
