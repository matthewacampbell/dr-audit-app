// Where screenshot files live. The database only stores each file's "key" (its name in
// storage), so you can switch between local disk and S3 without touching the data model.
//
//   STORAGE_DRIVER=local  -> files in UPLOAD_DIR on this machine (default)
//   STORAGE_DRIVER=s3     -> any S3-compatible server (MinIO, Ceph, Garage, Wasabi-style, etc.)
const fs = require('fs');
const path = require('path');

const driverName = (process.env.STORAGE_DRIVER || 'local').toLowerCase();

function localDriver() {
  const root = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

  const resolveKey = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };

  return {
    name: 'local',
    describe: () => `local disk (${root})`,
    async put(key, buffer) {
      const full = resolveKey(key);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, buffer);
    },
    async get(key) {
      const full = resolveKey(key);
      const stat = await fs.promises.stat(full);
      return { stream: fs.createReadStream(full), size: stat.size };
    },
    async remove(key) {
      try {
        await fs.promises.unlink(resolveKey(key));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },
    isMissing: (err) => err && err.code === 'ENOENT',
  };
}

function s3Driver() {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

  const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`STORAGE_DRIVER=s3 but these settings are missing in .env: ${missing.join(', ')}`);
    process.exit(1);
  }

  const bucket = process.env.S3_BUCKET;
  const prefix = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  const fullKey = (key) => (prefix ? `${prefix}/${key}` : key);

  const config = {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    // Private/self-hosted S3 servers almost always want path-style URLs (host/bucket/key).
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    // Recent AWS SDK versions add extra checksum headers by default, which many
    // non-AWS S3 servers reject. Only send them when S3 actually requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };

  if (process.env.S3_ALLOW_SELF_SIGNED === 'true') {
    const https = require('https');
    const { NodeHttpHandler } = require('@smithy/node-http-handler');
    config.requestHandler = new NodeHttpHandler({
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    console.warn('WARNING: S3_ALLOW_SELF_SIGNED=true, TLS certificates for S3 are NOT being verified.');
  }

  const client = new S3Client(config);

  return {
    name: 's3',
    describe: () => `S3 bucket "${bucket}" at ${process.env.S3_ENDPOINT}${prefix ? ` (prefix ${prefix}/)` : ''}`,
    async put(key, buffer, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: buffer,
          ContentType: contentType,
          ContentLength: buffer.length,
        })
      );
    },
    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
      return { stream: out.Body, size: out.ContentLength };
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
    },
    isMissing: (err) => err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404),
  };
}

module.exports = driverName === 's3' ? s3Driver() : localDriver();
