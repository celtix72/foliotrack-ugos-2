const fs = require('fs');
const file = '/Users/mauro/Documents/FolioTrack3/src/server.js';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

// Print lines around key boundaries for verification
const checkLines = [919, 1187, 1188, 1189, 1682, 1683, 1684, 1735, 1736, 2865, 2866, 2867, 3334, 3335, 3381, 3395, 3399, 3670, 3672, 3686, 3739, 3755, 4770, 4792, 6204, 6215, 6440, 6509, 6535];

checkLines.forEach(ln => {
    const idx = ln - 1;
    if (idx >= 0 && idx < lines.length) {
        console.log(`L${ln}: ${lines[idx].trim().substring(0, 100)}`);
    }
});
