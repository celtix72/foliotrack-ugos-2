const fs = require('fs');
let code = fs.readFileSync('src/server.js', 'utf8');

const oldPrompt = `NB: 
- "action" deve essere una singola parola in maiuscolo (es. BUY, SELL, HOLD, INCREASE, DECREASE). 
- "targetProfit" e "stopLoss" devono essere numeri (usa il punto per i decimali, es. 10.50). Se non hai un target o stop loss definito, inserisci 0.
\`;`;

const newPrompt = `NB: 
- "action" deve essere una singola parola in maiuscolo (es. BUY, SELL, HOLD, INCREASE, DECREASE). 
- "targetProfit" e "stopLoss" devono essere numeri (usa il punto per i decimali, es. 10.50). Se non hai un target o stop loss definito, inserisci 0.
- IMPORTANTE: Per i ritorni a capo all'interno di "reasoning", devi ASSOLUTAMENTE USARE il carattere di escape "\\n" e non andare mai a capo fisicamente. Fai l'escape anche delle eventuali virgolette interne con \\" per non invalidare il JSON.
\`;`;

code = code.replace(oldPrompt, newPrompt);
fs.writeFileSync('src/server.js', code, 'utf8');
console.log('Patched prompt instructions');
