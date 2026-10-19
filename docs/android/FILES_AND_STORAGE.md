# Images and private identity files

## Current Neon storage

| Purpose | Bucket / URL |
| --- | --- |
| Branch S3 endpoint (backend configuration) | {{STORAGE_ENDPOINT}} |
| Profile images | public bucket `seed-public-profiles` |
| Public profile URL prefix | {{PUBLIC_PROFILE_BASE}}/ |
| Identity documents | private bucket `seed-private-identities` |
| Legacy storage | private bucket `uploads`; not the current profile/document target |

The public bucket was empty at handoff inspection. A bucket prefix alone will not
display an image and no object listing is required by the app. Existing seed avatars
may be null or unfinished; show an app placeholder until an attached READY upload exists.
Synthetic identity PDFs are private fixtures, not public avatar images.

## Display an avatar

User/worker DTOs contain `profileImageUploadId`, not the object key or a permanent
avatar URL. If null, show a placeholder. Otherwise:

1. Authenticated GET `{{API_ORIGIN}}/v1/uploads/{profileImageUploadId}`.
2. A READY profile upload returns `url`; pass that URL to the app's image loader.
3. A ready avatar attached to an active account is resolvable by other authenticated
   accounts. An unlinked upload is owner-private through this metadata endpoint.
4. The returned profile URL is public. Download the image without sending the API
   bearer token to the storage host. Use the full returned URL rather than reconstructing it.
5. On upload/profile changes, invalidate the old profile UI reference. Objects have
   random immutable keys and may be cached; uploads alone do not change the attached avatar.

Storage constructs public URLs as `<public-prefix>/profile/<owner-user-id>/<random>.jpg`.
That pattern is explanatory; Android should consume the server-provided URL.

## Upload and attach an avatar

POST `/v1/uploads/profile-image` with the account access bearer and multipart field
`file` (binary image). Accepts JPEG/PNG/WebP, maximum 5 MiB. Do not put an image into
base64 JSON or set a multipart boundary manually; let the HTTP client generate it.
The backend checks bytes, strips metadata, orients/resizes and re-encodes JPEG.

The response has numeric `id`, purpose/status/metadata and `url`. Attach it with
PATCH `/v1/me`, body `{profileImageUploadId:<id>}`. Refetch profile/worker state and resolve
the attached upload. Do not PATCH an arbitrary URL. Detach with `profileImageUploadId:null`
before deleting a live attachment. Upload endpoints require an existing registered account.
`examples/sample-avatar.png` is a small synthetic test image, not a bundled default avatar.

## Identity upload, owner preview and admin review

POST `/v1/uploads/identity-document`, multipart `file`, accepts JPEG/PNG/PDF up to
10 MiB. The response contains no public URL or storage key. Submit the returned numeric
upload ID with POST `/v1/me/worker/identity-documents`, body
`{type:"PASSPORT",uploadId:<id>}` (also NATIONAL_ID / DRIVERS_LICENSE).

For the owner's preview, authenticated GET `/v1/uploads/{uploadId}` returns a signed
URL for a READY identity upload, with `expiresIn:300`. Admin review uses authenticated
GET `/v1/admin/verifications/{documentId}/document` for a current pending non-self
submission, also returning a URL valid for 300 seconds. An admin cannot use the
owner-only upload endpoint to preview arbitrary identities.

Use the signed URL exactly, including its query string, to fetch/display the image
or PDF. Do not append an API access token or remove/rename query parameters. The
file GET needs no API bearer; the signature authorizes it. Do not persist that URL
as a permanent database/profile field. When expired/403, ask the API for a fresh
URL after rechecking authorization. Previously issued links remain usable until expiry
even if review eligibility later changes.

The private bucket has no public display URL. Do not build a URL from the bucket name
or ship AWS/S3 credentials in Android. Display via a viewer appropriate to the file
content type. `examples/synthetic-identity.pdf` is visibly marked as a synthetic fixture.

## Retention and error states

List/get uploads can return PENDING or FAILED; only READY has usable bytes. A failed
upload is not attachable. There is no automatic purge: deleting an upload tombstones
metadata and can be blocked while live references exist. It does not erase object
bytes or instantly revoke signed links. Do not implement app-side S3 delete calls.

Profiles and documents are uploaded through the API running on Render, buffered in
memory and written to Neon. The source folder `src/modules/uploads` is API code;
Render's local filesystem is not the upload destination.
