const transactions = [
    { date: '2022-10-03', type: 'BUY', quantity: 8000, price: 0.66 },
    { date: '2023-03-08', type: 'SELL', quantity: 8000, price: 1.44 },
    { date: '2024-02-23', type: 'BUY', quantity: 4000, price: 1.41 },
    { date: '2024-03-22', type: 'SELL', quantity: 4000, price: 2.03 },
    { date: '2024-04-14', type: 'BUY', quantity: 1136, price: 1.76 },
    { date: '2024-06-14', type: 'BUY', quantity: 1469, price: 2.03 },
    { date: '2024-06-26', type: 'SELL', quantity: 1469, price: 2.32 },
    { date: '2024-09-04', type: 'BUY', quantity: 2606, price: 1.92 },
    { date: '2024-09-19', type: 'SELL', quantity: 2606, price: 1.99 },
    { date: '2025-02-26', type: 'BUY', quantity: 1268, price: 2.37 },
    { date: '2025-06-19', type: 'SELL', quantity: 2404, price: 2.41 },
    { date: '2025-07-29', type: 'BUY', quantity: 2125, price: 2.35 },
    { date: '2026-05-25', type: 'SELL', quantity: 1000, price: 4.196 }
];

let currentQty = 0;
let currentTotalCost = 0;

transactions.forEach(t => {
    const q = t.quantity;
    const p = t.price;
    if (t.type === 'BUY') {
        currentTotalCost += q * p;
        currentQty += q;
    } else if (t.type === 'SELL' && currentQty > 0) {
        const avgPrice = currentTotalCost / currentQty;
        currentTotalCost -= q * avgPrice;
        currentQty -= q;
    }
    console.log(`${t.date} ${t.type} - Qty: ${currentQty}, Total Cost: ${currentTotalCost}, PMC: ${currentQty > 0.0001 ? currentTotalCost/currentQty : 0}`);
});
