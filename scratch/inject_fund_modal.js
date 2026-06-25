const fs = require('fs');

const pdFile = 'private_views/portfolio_detail.html';
const wlFile = 'private_views/watchlist.html';
const pdMobFile = 'private_views/portfolio_detail_mobile.html';
const wlMobFile = 'private_views/watchlist_mobile.html';

// 1. Extract HTML
const pdHTML = fs.readFileSync(pdFile, 'utf8');
const modalHtmlMatch = pdHTML.match(/<div id="fundamentals-modal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/);
// It's safer to extract by id and matching divs.
let htmlPart = '';
if (modalHtmlMatch) {
    let startIdx = pdHTML.indexOf('<div id="fundamentals-modal"');
    let endIdx = startIdx;
    let openDivs = 0;
    while (endIdx < pdHTML.length) {
        if (pdHTML.substring(endIdx, endIdx+4) === '<div') openDivs++;
        if (pdHTML.substring(endIdx, endIdx+5) === '</div') openDivs--;
        if (openDivs === 0 && pdHTML.substring(endIdx, endIdx+6) === '</div>') {
            endIdx += 6;
            break;
        }
        endIdx++;
    }
    htmlPart = pdHTML.substring(startIdx, endIdx);
}

// 2. Extract JS
let jsPart = '';
let jsStartIdx = pdHTML.indexOf('window.openFundamentalsModal = async function');
if (jsStartIdx > -1) {
    let jsEndIdx = pdHTML.indexOf('window.closeReconcileModal = function'); // Stop before next function
    if (jsEndIdx > -1) {
        jsPart = pdHTML.substring(jsStartIdx, jsEndIdx);
    }
}

const wlHTML = fs.readFileSync(wlFile, 'utf8');
if (!wlHTML.includes('id="fundamentals-modal"')) {
    const newWl = wlHTML.replace('</body>', `\n${htmlPart}\n</body>`)
                        .replace('// Initialize', `${jsPart}\n    // Initialize`);
    fs.writeFileSync(wlFile, newWl);
}

// 3. Extract Mobile HTML
const pdMobHTML = fs.readFileSync(pdMobFile, 'utf8');
let htmlMobPart = '';
let startMobIdx = pdMobHTML.indexOf('<div id="fundamentals-modal"');
if (startMobIdx > -1) {
    let endMobIdx = startMobIdx;
    let openDivs = 0;
    while (endMobIdx < pdMobHTML.length) {
        if (pdMobHTML.substring(endMobIdx, endMobIdx+4) === '<div') openDivs++;
        if (pdMobHTML.substring(endMobIdx, endMobIdx+5) === '</div') openDivs--;
        if (openDivs === 0 && pdMobHTML.substring(endMobIdx, endMobIdx+6) === '</div>') {
            endMobIdx += 6;
            break;
        }
        endMobIdx++;
    }
    htmlMobPart = pdMobHTML.substring(startMobIdx, endMobIdx);
}

// 4. Extract Mobile JS
let jsMobPart = '';
let jsMobStartIdx = pdMobHTML.indexOf('window.openFundamentalsModal = async function');
if (jsMobStartIdx > -1) {
    let jsMobEndIdx = pdMobHTML.indexOf('window.closeReconcileModal = function'); // Stop before next function
    if (jsMobEndIdx > -1) {
        jsMobPart = pdMobHTML.substring(jsMobStartIdx, jsMobEndIdx);
    }
}

const wlMob = fs.readFileSync(wlMobFile, 'utf8');
if (!wlMob.includes('id="fundamentals-modal"')) {
    const newWlMob = wlMob.replace('</body>', `\n${htmlMobPart}\n</body>`)
                          .replace('// Initialize', `${jsMobPart}\n    // Initialize`);
    fs.writeFileSync(wlMobFile, newWlMob);
}

console.log("Injection completed");
