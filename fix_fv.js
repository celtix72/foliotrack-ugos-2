const fs = require('fs');

const files = [
    'private_views/watchlist.html',
    'private_views/market_overview.html',
    'private_views/watchlist_mobile.html',
    'private_views/market_mobile.html'
];

for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf8');
    
    // Replace ${fv} in titles
    content = content.replace(/\$\{fv\}/g, '');
    
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed', file);
}
