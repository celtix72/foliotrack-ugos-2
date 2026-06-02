const db = require('./src/db');
try {
    db.setSetting(1, 'test_key', 'test_val');
    console.log("Success:", db.getSettings(1));
} catch (e) {
    console.error("Error:", e.message);
}
