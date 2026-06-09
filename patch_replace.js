const fs = require('fs');

const files = [
    'private_views/watchlist.html',
    'private_views/watchlist_mobile.html',
    'private_views/market_overview.html',
    'private_views/market_mobile.html'
];

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/formatCurrency\(badge\.aiTargetPrice/g, 'formatAiFv(badge.aiTargetPrice');
    fs.writeFileSync(file, content, 'utf8');
}

let assetChart = fs.readFileSync('public/asset_chart_component.js', 'utf8');
assetChart = assetChart.replace(
    /\$\{item\.targetPrice \? \`\<span(.*?)FV: \$\{item\.targetPrice\}(.*?)\` : ''\}/,
    "${item.targetPrice ? `<span$1FV: ${window.formatAiFv ? window.formatAiFv(item.targetPrice, '') : item.targetPrice}$2` : ''}"
);
fs.writeFileSync('public/asset_chart_component.js', assetChart, 'utf8');
console.log('Patched all files');
