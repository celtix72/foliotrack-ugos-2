const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });

async function test() {
    try {
        console.log("Testing historical fundamentals for AAPL...");
        const result = await yahooFinance.quoteSummary('AAPL', { 
            modules: [
                'earningsTrend',
                'earningsHistory', 
                'incomeStatementHistory', 
                'incomeStatementHistoryQuarterly',
                'balanceSheetHistory',
                'cashflowStatementHistory'
            ] 
        });
        
        console.log(JSON.stringify(Object.keys(result), null, 2));
        
        if (result.earningsHistory) {
            console.log("\nEarnings History:");
            console.log(JSON.stringify(result.earningsHistory.history.slice(0, 2), null, 2));
        }
        
        if (result.incomeStatementHistory) {
            console.log("\nIncome Statement History (Annual):");
            const stmts = result.incomeStatementHistory.incomeStatementHistory;
            stmts.forEach(s => {
                console.log(`Date: ${s.endDate}, Revenue: ${s.totalRevenue}, Net Income: ${s.netIncome}`);
            });
        }
        if (result.balanceSheetHistory) {
            console.log("\nBalance Sheet History (Annual):");
            const stmts = result.balanceSheetHistory.balanceSheetStatements;
            stmts.forEach(s => {
                console.log(`Date: ${s.endDate}, Total Assets: ${s.totalAssets}`);
            });
        }
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
