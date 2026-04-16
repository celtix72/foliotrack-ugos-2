const { initDb, getSettings, recalculateAll } = require('../src/db');
const server = require('../src/server'); // Note: importing server.js will also start it unless it's designed to be required

// We might need to mock things or just call the function directly if it's exported.
// Since getAllPortfolioStats is NOT exported from server.js, we can't test it easily this way.

// Let's try instead to check if recalculateAll in db.js works.
async function test() {
    try {
        const liveRate = 1.08;
        const overrides = { regular: {}, prePost: {} };
        console.log("Testing database.recalculateAll...");
        recalculateAll(liveRate, overrides);
        console.log("Success!");
    } catch (err) {
        console.error("FAILED with error:", err);
    }
}
test();
