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
    
    // Using simple replace
    content = content.split("const fv = badge.aiTargetPrice ? ` • ${formatCurrency(badge.aiTargetPrice, item.currency)}` : '';").join("const fvStr = badge.aiTargetPrice ? formatCurrency(badge.aiTargetPrice, item.currency) : badge.aiAction;");
    content = content.split("const fv = badge.aiTargetPrice ? ` • ${formatCurrency(badge.aiTargetPrice, a.currency)}` : '';").join("const fvStr = badge.aiTargetPrice ? formatCurrency(badge.aiTargetPrice, a.currency) : badge.aiAction;");
    
    // Replace ${badge.aiAction}${fv} with ${fvStr}
    content = content.split("${badge.aiAction}${fv}").join("${fvStr}");
    
    fs.writeFileSync(file, content, 'utf8');
    console.log('patched', file);
}
