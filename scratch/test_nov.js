const tx = [
    { type: 'BUY', q: 36, p: 82.7 },
    { type: 'SELL', q: 36, p: 82.12 },
    { type: 'BUY', q: 52, p: 58.3 },
    { type: 'BUY', q: 51, p: 47.79 },
    { type: 'SELL', q: 103, p: 39.23 },
    { type: 'BUY', q: 100, p: 42.7 }
];
let qty = 0;
let cost = 0;
tx.forEach(t => {
    if(t.type==='BUY') {
        qty += t.q;
        cost += t.q * t.p;
    } else {
        const avg = cost / qty;
        cost -= t.q * avg;
        qty -= t.q;
    }
    console.log(`${t.type} ${t.q} -> qty: ${qty}, cost: ${cost}, pmc: ${qty>0?cost/qty:0}`);
});
