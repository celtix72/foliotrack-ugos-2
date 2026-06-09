const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

code = code.replace(/database\.getSettings\(\)/g, 'database.getSettings(1)');

fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched all database.getSettings() in server.js');
