const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/news',
  method: 'GET',
  headers: {
    'Cookie': 'connect.sid=s%3ACyE1w8gKjP6s2eCItJ6S2dY0T_9_m82Q.9Ew7Xm8A8lA1eH%2Bd6M8vT2K9R9v7p6u3m8y7c4b1v0; connect.sid=dummy' // Might not work without real cookie, but let's try.
  }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('Response:', body));
});
req.on('error', console.error);
req.end();
