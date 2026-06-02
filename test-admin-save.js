const fs = require('fs');
require('dotenv').config();

async function test() {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD;

    const loginRes = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUser, password: adminPass })
    });
    
    if (!loginRes.ok) {
        console.error("Login failed:", await loginRes.text());
        return;
    }
    
    const cookies = loginRes.headers.get('set-cookie');
    const token = cookies.split(';')[0].split('=')[1]; // very rough cookie parse

    const saveRes = await fetch('http://localhost:3000/api/admin/ai-settings', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({ geminiApiKey: 'test-key-123' })
    });

    if (!saveRes.ok) {
        console.error("Save failed:", saveRes.status, await saveRes.text());
    } else {
        console.log("Save success:", await saveRes.json());
    }
}
test();
