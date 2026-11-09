# Object storage: MinIO and bucket CORS

Moved out of the README. The feature itself is described under Direct to object storage there.

Try it against MinIO:

```bash
docker run -d --name trakie-minio -p 59000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
# create the bucket once (console at http://localhost:59000 or any S3 client), then:
S3_BUCKET=trakie S3_ENDPOINT=http://localhost:59000 AWS_ACCESS_KEY_ID=minio AWS_SECRET_ACCESS_KEY=minio12345 npm start
```

`minio/minio` is no longer on Docker Hub. The quay.io copy refuses anonymous pulls. So the tests and CI use the `pgsty/minio` fork pinned by tag.

**Bucket CORS.** The phone page PUTs from the server's own origin, so a real bucket needs a rule that allows that origin, the PUT method and the Content-Type header:

```json
[{"AllowedOrigins": ["https://your-server-origin"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 300}]
```

Also add a lifecycle rule that expires `sessions/` after a day, as a backstop for photos uploaded by a phone that vanished before the server could delete them.
