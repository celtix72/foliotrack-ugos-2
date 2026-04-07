function escapeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeCodeV2(text) {
    if (typeof text !== 'string') text = String(text || '');
    return text.replace(/([\\`])/g, '\\$1');
}

const sym = 'TDIV    ';
const mktVal = '52.33';
const cSym = '€';
const valChange = '-€20';
const pctChange = '-0.63%';

console.log('--- MARKDOWN V2 FIX TEST ---');
const row = [
    '📉',
    `\`${escapeCodeV2(sym)}\``,
    `\`${escapeCodeV2(cSym + mktVal.padStart(7))}\``,
    `\`${escapeCodeV2(valChange.padStart(8))}\``,
    `\`${escapeCodeV2(pctChange.padStart(8))}\``,
    '🔴'
].join(' ');

console.log(row);

// Verification: dots and minuses should NOT be escaped inside backticks
if (row.includes('\\.')) {
    console.log('ERROR: Dot is still escaped inside backticks!');
} else if (row.includes('\\-')) {
    console.log('ERROR: Minus is still escaped inside backticks!');
} else if (row.includes('\\`')) {
    console.log('SUCCESS: Escaped backtick check passed (only if backticks were present in data)');
} else {
    console.log('SUCCESS: Content looks clean and monospaced.');
}
console.log('----------------------------');
