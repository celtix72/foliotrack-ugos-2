const labels = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'];
const prices = [10, 11, 12, 13];
const transactions = [
    { date: '2024-01-01', type: 'BUY', quantity: 10, price: 10 },
    { date: '2024-01-03', type: 'SELL', quantity: 10, price: 12 }
];

const sortedTx = [...transactions].sort((a,b) => new Date(a.date) - new Date(b.date));
let currentQty = 0;
let currentTotalCost = 0;
let txIndex = 0;
let lastValidPMC = null;

const basisPrices = []; // PMC line
const heldPrices = [];  // Current price line for filling

labels.forEach((date, idx) => {
    const dayBeforeQty = currentQty;
    
    // Process all transactions chronologically up to and including 'date'
    while (txIndex < sortedTx.length && sortedTx[txIndex].date <= date) {
        const t = sortedTx[txIndex];
        // handle Italian comma by replacing , with . just in case, although API probably returns .
        const q = Math.abs(parseFloat(String(t.quantity).replace(',', '.'))) || 0;
        const p = parseFloat(String(t.price).replace(',', '.')) || 0;
        
        if (t.type === 'BUY') {
            currentTotalCost += q * p;
            currentQty += q;
        } else if (t.type === 'SELL' && currentQty > 0) {
            const avgPrice = currentTotalCost / currentQty;
            currentTotalCost -= q * avgPrice;
            currentQty -= q;
        } else if (t.type === 'SPLIT' && currentQty > 0 && q > 0) {
            currentQty = currentQty * q;
        }

        if (Math.abs(currentQty) < 0.00001) {
            currentQty = 0;
            currentTotalCost = 0;
        }

        txIndex++;
    }

    if (currentQty > 0.0001) {
        lastValidPMC = currentTotalCost / currentQty;
    }

    const isHolding = dayBeforeQty > 0.0001 || currentQty > 0.0001;
    if (isHolding) {
        basisPrices.push(lastValidPMC);
        heldPrices.push(prices[idx]);
    } else {
        basisPrices.push(null);
        heldPrices.push(null);
    }
});

console.log("basisPrices (PMC):", basisPrices);
