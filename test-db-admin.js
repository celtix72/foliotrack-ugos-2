const db = require('./src/db');
try {
    db.setSetting('admin', 'test_key', 'test_val');
    console.log("Success:", db.getSettings('admin'));
} catch (e) {
    console.error("Error:", e.message);
}
