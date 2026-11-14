# Large videos in parts

A video goes up in 8 MiB parts, so a dropped connection costs one part and not the file.

## How it runs

1. The phone asks for the slot (`request-video-upload` with token, index, total, type and size).
2. The server opens the multipart upload, keeps the upload id itself, and returns a presigned URL for every part still owed.
3. Asking again for the same slot is a resume. The server lists what the store holds and signs only the missing parts. A part stored at the wrong size is owed again.
4. When every part is up the phone sends `video-uploaded`. The server lists the parts and refuses to join them unless every one is there at its exact size with the store's checksum. Then it completes the upload.

The rules are in `server/video-uploads.js` (no I/O, table tested) and the store calls are in `server/storage.js`.

## What the server checks

- Types are MP4, MOV and WebM (`video/mp4`, `video/quicktime`, `video/webm`), up to 3 videos per session and 2 GiB each, which is at most 256 parts.
- Each part URL signs its Content-Length and expires in 300 seconds, so the store refuses a part of another size.
- The client never sends an upload id. A key is accepted only as `videos/<this session's token>/<n>.<mp4|mov|webm>` and only for a slot this server opened.
- One slot holds one file: the same slot with another size or type is refused.
- Only the phone paired to the session can ask or finish.
- An unfinished upload is aborted and a finished video deleted when the session ends or the desktop leaves.

## Tests

`cd server && npm test` runs them. `tests/video-uploads.test.js` has 9 tests that need no container (a part plan for 400 seeded sizes whose parts always add up to the file, resume, completeness, request and key rules) and 8 against MinIO:

- 17 MiB through three parts, byte for byte the same (sha256).
- A resume after a dropped connection that re-signs only the missing part.
- A short upload that is refused and never joined, then finished on the same slot.
- A part of the wrong size refused by the store, with the exact size going through.
- One slot, one file.
- Rule breaks answered with a short reason and nothing opened.
- A phone that is not paired, and a key from another session, refused.
- An unfinished upload aborted and a finished video deleted when the session ends.

`node tests/mutants.mjs` removes 19 of these guards one at a time in a temp copy and requires the suite to fail each time.

## Limits

- Run on MinIO, not on AWS S3, with a 17 MiB test file and not a gigabyte one.
- The phone page still sends photos only. The part sender is tested through the Socket.IO events the phone would use, and no phone page uploads a video yet.
- Bucket CORS and parts sent in parallel are not tested.
