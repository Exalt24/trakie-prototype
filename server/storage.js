const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const DEFAULT_EXPIRES_IN = 300;

// Standard AWS variables only: no profile files, no instance metadata, nothing implicit.
function credentialsFromEnv(env) {
  return async () => {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      throw new Error("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    }
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || undefined,
    };
  };
}

// Returns null when S3_BUCKET is unset, so the base64 path stays exactly as it was.
// Credentials come only from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN).
function createStorage(env = process.env) {
  const bucket = env.S3_BUCKET;
  if (!bucket) return null;

  const endpoint = env.S3_ENDPOINT || undefined;
  const client = new S3Client({
    region: env.S3_REGION || env.AWS_REGION || "us-east-1",
    endpoint,
    forcePathStyle: Boolean(endpoint) || env.S3_FORCE_PATH_STYLE === "1",
    credentials: credentialsFromEnv(env),
    // A presigned URL has no body to checksum, so do not bake a checksum parameter into it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    bucket,
    client,

    // Content-Type and Content-Length are part of the signature, so the store itself
    // refuses a different type or a body of another size.
    presignPut(key, contentType, size, { expiresIn = DEFAULT_EXPIRES_IN } = {}) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      });
      return getSignedUrl(client, command, {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      });
    },

    async getObject(key, { maxBytes } = {}) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (maxBytes && res.ContentLength > maxBytes) {
        res.Body.destroy?.();
        throw new Error("Object is larger than the allowed size");
      }
      return Buffer.from(await res.Body.transformToByteArray());
    },

    async deleteObjects(keys) {
      if (!keys || keys.length === 0) return;
      const res = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        })
      );
      if (res.Errors && res.Errors.length > 0) {
        throw new Error(`Delete failed for ${res.Errors.length} object(s)`);
      }
    },
  };
}

module.exports = { createStorage, DEFAULT_EXPIRES_IN };
