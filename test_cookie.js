const express = require('express');
const cookieParser = require('cookie-parser');
const app = express();
app.use(cookieParser());
app.get('/set', (req, res) => {
    res.cookie('ft_token', 'miao', {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, 
        secure: process.env.NODE_ENV === 'production'
    });
    res.send('ok');
});
app.get('/get', (req, res) => {
    res.json(req.cookies);
});
app.listen(3001, () => console.log('Listening 3001'));
