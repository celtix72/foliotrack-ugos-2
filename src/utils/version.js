const now = new Date();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const hour = String(now.getHours()).padStart(2, '0');
const min = String(now.getMinutes()).padStart(2, '0');
const APP_VERSION = `v.${month}${day}${hour}:${min}`;

module.exports = { APP_VERSION };
