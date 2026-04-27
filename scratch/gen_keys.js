const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});

const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'pem' })
  .replace('-----BEGIN PUBLIC KEY-----', '')
  .replace('-----END PUBLIC KEY-----', '')
  .replace(/\n/g, '')
  .trim();

const privateKeyBase64 = privateKey.export({ type: 'pkcs8', format: 'pem' })
  .replace('-----BEGIN PRIVATE KEY-----', '')
  .replace('-----END PRIVATE KEY-----', '')
  .replace(/\n/g, '')
  .trim();

// Note: web-push expects uncompressed public key in base64url format
// This PEM export is not exactly what web-push expects, but we can use web-push if user installs it.
// I will just provide the instruction to use web-push.
console.log('Public Key:', publicKeyBase64);
console.log('Private Key:', privateKeyBase64);
