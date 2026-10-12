// Run with: npm run check-storage
// Writes, reads and deletes a tiny test file so you can confirm your storage settings work.
require('dotenv').config();
const storage = require('../src/storage');

(async () => {
  console.log(`Storage: ${storage.describe()}`);
  const key = `healthcheck/${Date.now()}.txt`;
  const body = Buffer.from('audit-app storage check');
  try {
    await storage.put(key, body, 'text/plain');
    console.log('  write:  ok');

    const { stream } = await storage.get(key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const same = Buffer.concat(chunks).equals(body);
    console.log(`  read:   ${same ? 'ok' : 'MISMATCH'}`);

    await storage.remove(key);
    console.log('  delete: ok');
    console.log(same ? '\nStorage is working.' : '\nStorage returned different data than was written.');
    process.exit(same ? 0 : 1);
  } catch (err) {
    console.error(`\nStorage check FAILED: ${err.name || ''} ${err.message}`);
    const hints = {
      NoSuchBucket: 'The bucket does not exist. Create it on your S3 server first, or fix S3_BUCKET.',
      InvalidAccessKeyId: 'The access key was not recognised. Check S3_ACCESS_KEY_ID.',
      SignatureDoesNotMatch: 'The secret key is wrong (or the region is). Check S3_SECRET_ACCESS_KEY and S3_REGION.',
      AccessDenied: 'The key is valid but is not allowed to read/write/delete in this bucket.',
    };
    if (hints[err.name]) console.error(`Hint: ${hints[err.name]}`);
    else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(String(err.code || err.message)))
      console.error('Hint: cannot reach the S3 server. Check S3_ENDPOINT and that this machine can connect to it.');
    else if (/self[- ]signed|certificate|CERT_/i.test(String(err.code || err.message)))
      console.error('Hint: the server uses a certificate Node does not trust. Fix the certificate, or set S3_ALLOW_SELF_SIGNED=true (less secure).');
    process.exit(1);
  }
})();
