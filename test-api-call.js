const jwt = require('jsonwebtoken');
require('dotenv').config();

const token = jwt.sign(
    { id: 1, username: 'mauro', role: 'admin' },
    process.env.JWT_SECRET || 'dev_secret_key',
    { expiresIn: '1h' }
);

fetch('http://localhost:3000/api/admin/ai-settings', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Cookie': `ft_jwt=${token}`
    },
    body: JSON.stringify({ geminiApiKey: 'test-from-script' })
}).then(res => {
    console.log("Status:", res.status);
    return res.text();
}).then(text => {
    console.log("Body:", text);
}).catch(err => {
    console.error("Error:", err);
});
