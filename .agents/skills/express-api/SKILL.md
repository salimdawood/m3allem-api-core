
---
name: express-api
description: Build and maintain production-ready REST APIs using Express.js, PostgreSQL, Prisma ORM, layered architecture, centralized error handling, security middleware, logging, and JWT authentication for Android clients.
---

# Express.js API Development Skill

## Role

Act as a senior backend engineer responsible for designing, implementing, reviewing, and maintaining secure, scalable, and maintainable REST APIs.

The API is primarily consumed by an Android mobile application.

Technology stack:
- Node.js (current supported LTS)
- Express.js
- PostgreSQL
- Prisma ORM
- JWT authentication
- Zod for validation
- Pino and Pino HTTP for logging
- Helmet for HTTP security headers
- express-rate-limit for rate limiting
- Multer for multipart uploads when required
- Argon2id for password hashing

Use JavaScript ES modules by default unless the project already uses TypeScript.

## 1. Architecture

Always follow this request lifecycle:

Client
  ↓
Global Middleware
  ↓
Route
  ↓
Authentication Middleware
  ↓
Upload Middleware (when needed)
  ↓
Validation Middleware
  ↓
tryCatch Wrapper
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Prisma ORM
  ↓
PostgreSQL

Response lifecycle:

Repository → Service → Controller → Central Response Handler → Client

Error lifecycle:

Any Layer → Central Error Handler → Client

Each layer must have one clear responsibility.

Never bypass layers for convenience.

## 2. Project Structure

src/
├── app.js
├── server.js
├── config/
│   ├── env.js
│   ├── database.js
│   ├── logger.js
│   └── security.js
├── routes/
│   └── index.js
├── modules/
│   ├── auth/
│   │   ├── auth.routes.js
│   │   ├── auth.controller.js
│   │   ├── auth.service.js
│   │   ├── auth.repository.js
│   │   └── auth.validation.js
│   └── users/
│       ├── user.routes.js
│       ├── user.controller.js
│       ├── user.service.js
│       ├── user.repository.js
│       └── user.validation.js
├── middlewares/
│   ├── auth.middleware.js
│   ├── validate.middleware.js
│   ├── upload.middleware.js
│   ├── error.middleware.js
│   ├── notFound.middleware.js
│   ├── requestLogger.middleware.js
│   ├── rateLimiter.middleware.js
│   └── timeout.middleware.js
├── utils/
│   ├── tryCatch.js
│   ├── AppError.js
│   ├── ApiResponse.js
│   ├── jwt.js
│   └── pagination.js
├── constants/
│   ├── httpStatus.js
│   └── errorCodes.js
├── jobs/
├── tests/
│   ├── unit/
│   └── integration/
└── prisma/
    ├── schema.prisma
    └── migrations/

Organize features by module.

Avoid large global controller, service, or repository files.

## 3. Routes Layer

Routes define HTTP endpoints and their middleware pipeline.

Responsibilities:
- Define HTTP methods and endpoint paths.
- Apply authentication and authorization.
- Apply upload middleware when needed.
- Apply request validation.
- Call controllers wrapped in tryCatch.
- Apply endpoint-specific rate limits when appropriate.

Example:

router.post(
  "/users",
  authenticate,
  authorize("users:create"),
  validate(createUserSchema),
  tryCatch(userController.createUser)
);

Rules:
- Never write business logic in routes.
- Never query Prisma directly.
- Never format responses in routes.
- Never implement controller logic inside route callbacks.
- Use RESTful endpoint naming.
- Apply authentication by default to private endpoints.
- Middleware order must account for content type, validation, and upload requirements.

## 4. tryCatch Wrapper

Every asynchronous controller must be wrapped by tryCatch.

Responsibilities:
- Catch asynchronous controller errors.
- Forward errors to centralized error middleware.
- Forward successful controller results to a centralized response formatter.
- Prevent repeated try/catch blocks in controllers.

Example:

const tryCatch = (controller) => {
  return async (req, res, next) => {
    try {
      const result = await controller(req, res);

      if (res.headersSent) return;

      return sendResponse(res, result);
    } catch (error) {
      return next(error);
    }
  };
};

Rules:
- Controllers return standardized result objects.
- Controllers must not call res.json() directly.
- Controllers must not manually catch errors unless recovery is required.
- The wrapper must not send a second response.
- Use explicit result metadata for HTTP status codes.
- Support 204 responses without a body.
- Streaming and file-download endpoints may use a dedicated response path.
- Do not expose internal error details.

## 5. Controller Layer

Controllers are thin HTTP adapters.

Responsibilities:
- Extract validated data from req.
- Read authenticated user context.
- Call the appropriate service.
- Await and return service results.
- Set HTTP response metadata.

Example:

const createUser = async (req) => {
  const user = await userService.createUser(
    req.validated.body,
    req.user
  );

  return {
    statusCode: 201,
    message: "User created successfully",
    data: user
  };
};

Rules:
- No Prisma queries.
- No business logic.
- No complex formatting or transformations.
- No manual HTTP response sending.
- No unnecessary try/catch.
- Do not trust client-provided user IDs for authorization.
- Keep controllers small and readable.

## 6. Service Layer

The service is the business logic layer.

Responsibilities:
- Implement business rules.
- Enforce business-level authorization.
- Coordinate multiple repositories.
- Format, normalize, factor, and shape data.
- Handle application workflows.
- Apply domain validations.
- Manage database transaction boundaries.
- Throw meaningful application errors.
- Return predictable results.

Example:

const createUser = async (input, actor) => {
  const existingUser =
    await userRepository.findByEmail(input.email);

  if (existingUser) {
    throw new AppError(
      "EMAIL_ALREADY_EXISTS",
      409,
      "Email already exists"
    );
  }

  const passwordHash = await hashPassword(input.password);

  return userRepository.create({
    email: input.email.toLowerCase(),
    name: input.name.trim(),
    passwordHash,
    createdById: actor.id
  });
};

Rules:
- Services never access req or res.
- Services never send HTTP responses.
- Services must not contain raw Prisma queries.
- Services may call multiple repositories.
- Services control transaction boundaries.
- Use dependency injection or a transaction-aware repository interface for multi-repository transactions.
- Avoid duplicated business rules.
- Never return password hashes or sensitive internal fields.
- Use explicit DTOs or response shaping.
- Avoid side effects before transaction commit when possible.

## 7. Repository Layer

Repositories handle database operations.

Responsibilities:
- Execute Prisma queries.
- Accept query parameters from services.
- Encapsulate database access.
- Support filtering, pagination, sorting, and relations.
- Execute queries within supplied transactions.
- Return database results to services.

Example:

const findByEmail = async (email, db = prisma) => {
  return db.user.findUnique({
    where: { email }
  });
};

const create = async (data, db = prisma) => {
  return db.user.create({
    data,
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true
    }
  });
};

Rules:
- Prisma access belongs in repositories.
- Do not implement business rules in repositories.
- Do not use req or res.
- Never return sensitive fields unnecessarily.
- Use select to minimize returned data.
- Avoid N+1 queries.
- Apply pagination to list endpoints.
- Whitelist allowed sorting and filtering fields.
- Never pass untrusted query objects directly into Prisma.
- Prefer Prisma query APIs over raw SQL.
- Parameterize raw SQL when unavoidable.
- Handle known database errors through centralized error mapping.

## 8. Validation Middleware

Use Zod for request validation.

Validate:
- req.body
- req.params
- req.query
- Uploaded file metadata when applicable

Responsibilities:
- Validate required fields.
- Enforce types, formats, ranges, and limits.
- Normalize strings.
- Convert query strings to expected types.
- Reject unexpected fields when appropriate.
- Store parsed values in req.validated.

Example:

const createUserSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.email().trim().toLowerCase(),
    password: z.string().min(12)
  }).strict()
});

Rules:
- Do not trust raw request values.
- Use safeParse or equivalent validation.
- Return 400 for malformed request data.
- Use 413 for payloads exceeding size limits.
- Avoid silent coercion of invalid values.
- Normalize dates, booleans, and numbers explicitly.
- Keep cross-resource business checks in services.
- Never mutate unvalidated input.
- Do not include submitted passwords in validation logs.

## 9. Error Handling

Use a centralized AppError class and error middleware.

Standard error response:

{
  "success": false,
  "message": "Email already exists",
  "error": {
    "code": "EMAIL_ALREADY_EXISTS"
  },
  "requestId": "request-id"
}

Handle:
- Application errors
- Validation errors
- Authentication errors
- Authorization errors
- Prisma known errors
- Database connectivity errors
- File upload errors
- Rate-limit errors
- Request timeouts
- Unknown server errors

Recommended HTTP codes:
- 200: Successful request
- 201: Resource created
- 204: Successful request without body
- 400: Invalid request
- 401: Missing or invalid authentication
- 403: Insufficient permission
- 404: Resource not found
- 409: Resource conflict
- 413: Payload too large
- 415: Unsupported media type
- 422: Semantically invalid request when applicable
- 429: Too many requests
- 500: Unexpected server error
- 503: Service temporarily unavailable
- 504: Upstream gateway timeout when applicable

Rules:
- Never expose stack traces in production.
- Log unexpected errors with stack traces internally.
- Return consistent error codes.
- Map known Prisma errors appropriately.
- Preserve requestId for troubleshooting.
- Do not send multiple responses for one request.
- Handle malformed JSON centrally.

## 10. Standard API Responses

Successful response:

{
  "success": true,
  "message": "Users retrieved successfully",
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100
  },
  "requestId": "request-id"
}

Rules:
- Use a consistent envelope.
- Use correct HTTP status codes.
- Omit meta when unnecessary.
- Never expose internal implementation details.
- Use stable machine-readable error codes.
- Use ISO 8601 timestamps in UTC.
- Use explicit serialization for Decimal and BigInt values.
- Do not include a JSON body for 204 responses.

## 11. JWT Authentication for Android

Use short-lived access tokens and rotating refresh tokens.

Access token:
- Signed JWT.
- Short expiration, approximately 10–15 minutes.
- Contains user ID and minimal required claims.
- Includes issuer, audience, issued-at, and expiration.
- Uses an explicitly configured signing algorithm.

Refresh token:
- Long-lived opaque cryptographically random token preferred.
- Stored hashed in the database.
- Rotated on every successful refresh.
- Revocable per device/session.
- Has an absolute expiration.
- Must never appear in application logs.

If refresh tokens are implemented as JWTs, enforce token type, unique token ID, expiry, server-side session tracking, rotation, and revocation.

Endpoints:

POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
GET  /api/v1/auth/me

Authentication flow:

1. Android submits credentials over HTTPS.
2. Server validates credentials.
3. Server issues access and refresh tokens.
4. Android stores tokens using secure platform-backed storage.
5. Android sends access token using:
   Authorization: Bearer <access_token>
6. Authentication middleware verifies access token.
7. When expired, Android calls refresh endpoint.
8. Server validates and rotates refresh token.
9. Server invalidates the previous refresh token.
10. Logout revokes the active refresh session.

Security requirements:
- Never store passwords in plaintext.
- Use Argon2id for password hashing.
- Use generic login errors to avoid account enumeration.
- Rate-limit login and refresh endpoints.
- Revoke sessions after relevant security events.
- Detect refresh-token reuse.
- Invalidate affected token families when reuse is detected.
- Make refresh rotation atomic to prevent race conditions.
- Define a clear policy for concurrent refresh requests.
- Never include credentials or tokens in URLs.
- Never log Authorization headers.
- Avoid storing secrets in Android SharedPreferences without encryption.
- Support multiple Android devices with separate sessions.
- Authorization must be enforced server-side.

## 12. Security Middleware

Use:
- helmet
- cors
- express-rate-limit
- express.json with payload limits
- Request timeout controls
- Secure upload handling
- Environment variable validation

Rules:
- Enforce HTTPS in production.
- Configure trusted proxies explicitly.
- Configure CORS for actual browser consumers; CORS does not authenticate Android clients.
- Restrict HTTP methods where appropriate.
- Limit request body size.
- Validate uploaded file size, MIME type, and actual file content.
- Use randomized upload filenames.
- Store uploaded files outside public execution paths.
- Use secure object storage for persistent files.
- Apply stricter rate limits to authentication endpoints.
- Use Redis-backed distributed rate limiting when running multiple instances.
- Do not trust arbitrary proxy forwarding headers.
- Avoid exposing framework or infrastructure information.
- Do not expose secrets in logs or API responses.
- Configure graceful shutdown.

Timeout rules:
- Set appropriate server request/header/keep-alive timeouts.
- Use AbortSignal or cancellation where supported.
- Apply timeouts to outbound HTTP calls.
- Understand that sending a timeout response does not automatically cancel ongoing database work.
- Use database-level query timeout controls where applicable.

## 13. Logging and Monitoring

Use structured JSON logging with Pino.

Log each completed request with:
- Timestamp
- Request ID
- HTTP method
- Endpoint or route pattern
- HTTP status
- Duration in milliseconds
- Authenticated user ID when available
- Client IP when appropriate
- User agent
- Error code when applicable

Example:

{
  "level": "info",
  "requestId": "abc-123",
  "method": "GET",
  "path": "/api/v1/users",
  "statusCode": 200,
  "durationMs": 42.6,
  "userId": 15
}

Rules:
- Use high-resolution timers for duration measurement.
- Generate or safely accept a validated request ID.
- Propagate request IDs through services and outbound calls when needed.
- Never log passwords, tokens, API keys, or sensitive payloads.
- Redact Authorization and Cookie headers.
- Avoid logging sensitive query parameters.
- Log unexpected errors with stack traces.
- Use info for normal requests.
- Use warn for suspicious or recoverable failures.
- Use error for unexpected failures.
- Support slow-request logging with configurable thresholds.
- Avoid excessive logs for high-frequency health checks.
- Avoid duplicate error logs across layers.
- Do not log raw SQL parameters containing sensitive information.

## 14. Health Endpoints

Provide:

GET /health/live
GET /health/ready

Liveness:
- Confirms the application process is responsive.
- Does not depend on PostgreSQL availability.
- Returns 200 when the process is healthy.

Readiness:
- Confirms the application can serve traffic.
- Checks essential dependencies such as PostgreSQL.
- Returns 200 when ready.
- Returns 503 when essential dependencies are unavailable.

Example:

{
  "success": true,
  "status": "ready",
  "timestamp": "2026-10-08T12:00:00.000Z"
}

Rules:
- Keep health endpoints lightweight.
- Do not expose secrets or database credentials.
- Use short dependency-check timeouts.
- Keep detailed diagnostics on restricted internal endpoints.
- Mark readiness as unavailable during graceful shutdown.

## 15. Prisma and PostgreSQL

Rules:
- Use one shared Prisma client per application process.
- Keep Prisma access in repositories.
- Use Prisma migrations for schema changes.
- Commit migration files to version control.
- Use prisma migrate deploy in production.
- Never use prisma db push as a substitute for production migrations.
- Define unique constraints and foreign keys.
- Add indexes based on actual query patterns.
- Use transactions for atomic business operations.
- Keep transactions short.
- Handle uniqueness conflicts and transaction retries appropriately.
- Avoid unnecessary queries.
- Use pagination for large datasets.
- Prefer cursor pagination for large or frequently changing datasets.
- Store timestamps in UTC.
- Never assume application-level checks replace database constraints.
- Review connection pooling for the deployment environment.
- Avoid destructive migrations without a reviewed migration plan.

## 16. File Uploads

When an endpoint accepts files:

1. Authenticate the request.
2. Apply upload-specific limits.
3. Parse multipart input using Multer.
4. Validate fields and file metadata.
5. Verify file content where appropriate.
6. Delegate business processing to the service.
7. Store files securely.
8. Save metadata through repositories.

Rules:
- Do not store uploads permanently on ephemeral server disks.
- Prefer S3-compatible object storage for persistent files.
- Use private storage by default.
- Use signed URLs for controlled access.
- Restrict file size, count, and allowed formats.
- Prevent path traversal.
- Clean up temporary files after failure.
- Do not trust client-provided MIME types.
- Use streaming or direct-to-storage uploads for large files.
- Avoid logging file contents.

## 17. Pagination, Filtering, and Sorting

All list endpoints must support controlled pagination when appropriate.

Example:

GET /api/v1/users?page=1&limit=20&sortBy=createdAt&order=desc

Rules:
- Validate page and limit.
- Set a maximum limit.
- Whitelist sortable fields.
- Validate filters.
- Never accept arbitrary Prisma query objects.
- Return pagination metadata.
- Use stable secondary sorting.
- Avoid unbounded database queries.

## 18. Testing

Use automated tests for:
- Validation middleware
- Authentication middleware
- Authorization
- Controllers
- Services
- Repositories
- JWT refresh rotation
- Token reuse detection
- Error handling
- Pagination
- Health endpoints
- File uploads
- Rate limiting

Testing principles:
- Unit-test services with mocked repositories.
- Integration-test routes and middleware.
- Integration-test Prisma repositories against a dedicated PostgreSQL database.
- Test transaction rollback behavior.
- Test concurrent refresh attempts.
- Test expired, malformed, and revoked tokens.
- Test unauthorized cross-user access.
- Test database failures and timeout behavior.
- Never use production credentials in tests.

## 19. API Versioning

All public API endpoints must use versioning.

Example:

/api/v1/users
/api/v1/auth/login

Rules:
- Preserve backward compatibility when possible.
- Do not silently change response contracts.
- Document breaking changes.
- Support mobile clients running older application versions.
- Use a consistent deprecation policy.
- Generate or maintain OpenAPI documentation.

## 20. Environment Variables

Validate environment variables during startup.

Required configuration may include:

NODE_ENV
PORT
DATABASE_URL
JWT_ACCESS_SECRET
JWT_ACCESS_EXPIRES_IN
JWT_ISSUER
JWT_AUDIENCE
REFRESH_TOKEN_TTL_DAYS
LOG_LEVEL
CORS_ALLOWED_ORIGINS
RATE_LIMIT_WINDOW_MS
RATE_LIMIT_MAX
REQUEST_TIMEOUT_MS

Rules:
- Fail startup when required configuration is invalid.
- Never hardcode credentials.
- Never commit .env files.
- Provide .env.example without secrets.
- Use a secret manager in production when available.

## 21. Implementation Workflow

When implementing a new API feature:

1. Understand requirements and business rules.
2. Identify database changes.
3. Update Prisma schema if necessary.
4. Create a reviewed migration.
5. Create validation schemas.
6. Implement repository methods.
7. Implement service business logic.
8. Implement thin controllers.
9. Define routes and middleware.
10. Add authorization checks.
11. Add standardized error handling.
12. Add tests.
13. Update OpenAPI documentation.
14. Verify security, logging, and performance.

Do not skip layers to save time.

## 22. Code Quality

Follow these principles:
- SOLID where applicable.
- DRY without unnecessary abstraction.
- Clear naming.
- Small focused functions.
- Consistent async/await.
- Explicit dependencies.
- Predictable return types.
- No duplicated business logic.
- No direct Prisma access from controllers.
- No business logic in routes.
- No HTTP request objects inside services.
- No sensitive information in logs.
- No silent error swallowing.
- No unnecessary dependencies.
- No speculative abstraction.

## 23. Agent Behavior

When generating or modifying code:

- Inspect existing project conventions first.
- Reuse existing utilities and abstractions.
- Preserve established response contracts.
- Follow the architecture defined in this skill.
- Do not introduce a second competing architecture.
- Do not move business logic into controllers.
- Do not place Prisma queries outside repositories.
- Do not bypass validation.
- Do not bypass centralized error handling.
- Do not weaken authentication or authorization.
- Do not introduce breaking API changes without highlighting them.
- Prefer minimal, maintainable changes.
- Add meaningful tests.
- Explain architectural tradeoffs when necessary.

When requirements are unclear, ask for clarification rather than inventing business rules.

## 24. Definition of Done

A feature is complete only when:

- Endpoint is correctly registered.
- Authentication and authorization are enforced.
- Request validation is implemented.
- Controller uses the service.
- Service contains the business logic.
- Repository handles database operations.
- Errors use centralized handling.
- Responses follow the API contract.
- Sensitive data is protected.
- Logging and request IDs work.
- Appropriate tests pass.
- OpenAPI documentation is updated.
- No unrelated behavior is broken.
