const { xirr, calculateTWR } = require('./src/utils/finance');

function testXirr() {
    console.log('Testing XIRR...');
    // Simple case: Invest 1000, get 1100 after 1 year. XIRR should be 10%.
    const cashFlows = [
        { date: new Date('2023-01-01'), amount: -1000 },
        { date: new Date('2024-01-01'), amount: 1100 }
    ];
    const result = xirr(cashFlows);
    console.log(`Result: ${(result * 100).toFixed(2)}% (Expected: ~10.00%)`);

    // More complex case
    const flows2 = [
        { date: new Date('2023-01-01'), amount: -1000 },
        { date: new Date('2023-07-01'), amount: -1000 },
        { date: new Date('2024-01-01'), amount: 2200 }
    ];
    const result2 = xirr(flows2);
    console.log(`Result 2: ${(result2 * 100).toFixed(2)}% (Expected: ~13.7%)`);
}

function testTwr() {
    console.log('\nTesting TWR...');
    // Period 1: Start 1000, End 1100, NetFlow 0 -> +10%
    // Period 2: Start 1100, End 2500, NetFlow 1000 -> (2500 - 1000 - 1100) / 1100 = 400 / 1100 = 36.36%
    // Cumulative: 1.1 * 1.3636 = 1.4999 -> ~50%
    const subPeriods = [
        { startingValue: 1000, endingValue: 1100, netCashFlow: 0 },
        { startingValue: 1100, endingValue: 2500, netCashFlow: 1000 }
    ];
    const result = calculateTWR(subPeriods);
    console.log(`Result: ${(result * 100).toFixed(2)}% (Expected: ~50.00%)`);
}

testXirr();
testTwr();
