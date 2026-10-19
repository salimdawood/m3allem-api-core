// Illustrative snippets: adapt to the Android app's existing HTTP/JSON architecture.
// Retrofit/OkHttp imports and dependency versions belong to the Android repository.

const val M3ALLEM_API_BASE_URL = "https://m3allem-api-core.onrender.com/v1/"
const val M3ALLEM_REALTIME_URL = "wss://m3allem-api-core.onrender.com/v1/realtime"

data class SendOtpBody(val phoneNumber: String)
data class VerifyOtpBody(val phoneNumber: String, val challengeId: Long, val code: String)
data class TokenPair(val accessToken: String, val refreshToken: String, val expiresIn: Int)
data class RefreshBody(val refreshToken: String)
data class AttachAvatarBody(val profileImageUploadId: Long?)
data class SubmitIdentityBody(val type: String, val uploadId: Long)
data class ChangeRequestStatusBody(val status: String, val version: Long, val reason: String? = null)
data class SignedFileUrl(val url: String, val expiresIn: Int)
data class ApiErrorDetails(val code: String, val message: String)
data class ApiError(val error: ApiErrorDetails, val requestId: String?)

// Retrofit annotations use paths relative to /v1/ (no leading slash):
// @POST("auth/otp/send") suspend fun sendOtp(@Body body: SendOtpBody): OtpChallenge
// @POST("auth/otp/verify") suspend fun verifyOtp(@Body body: VerifyOtpBody): LoginResult
// @POST("auth/refresh") suspend fun refresh(@Body body: RefreshBody): TokenPair
// @GET("uploads/{id}") suspend fun upload(@Path("id") id: Long): UploadMetadata
// @PATCH("me") suspend fun attachAvatar(@Body body: AttachAvatarBody): User
// @Multipart @POST("uploads/profile-image") suspend fun avatar(@Part file: MultipartBody.Part): UploadMetadata
// Use nullable DTO fields and the full definitions in api/openapi.yaml; these are not all DTOs.

// WebSocket: Request.Builder().url(M3ALLEM_REALTIME_URL)
//     .header("Authorization", "Bearer $accessToken").build()
// Do not send chat text or app-level ping messages over that socket. Use HTTP for writes.

// Avatar: profileImageUploadId -> authenticated GET uploads/{id} -> load returned URL
// with the normal image loader. Do not attach the API bearer header to the storage host.
// Private file: obtain a signed URL through the owner's upload endpoint or the admin
// current-pending document endpoint; use exact URL and renew after 300-second expiry.

// Auth refresh: protect rotation with a Mutex/single-flight mechanism in the app's
// session manager, save BOTH returned tokens atomically, and retry using the newly
// stored pair. Never retry refresh itself with an already consumed refresh token.
