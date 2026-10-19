BEGIN;
SET LOCAL search_path = public, pg_catalog;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public') THEN
        RAISE EXCEPTION 'Bootstrap requires an empty public schema; run deployment/preflight.sql before an existing-database migration';
    END IF;
END $$;
-- =====================================================================================
-- M3allem database schema (PostgreSQL 15+)
-- Standalone schema for an EMPTY PostgreSQL 15+ database. All resources use soft deletion.
-- Entity IDs are numeric; timestamps are TIMESTAMPTZ. Apply the entire file atomically.
-- =====================================================================================

CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy text search on worker_profiles
CREATE EXTENSION IF NOT EXISTS btree_gist; -- per-worker schedule overlap constraints
-- Optional, for fast radius queries: CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- enums
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE verification_status   AS ENUM ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE document_review_status AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE identity_document_type AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE');
CREATE TYPE price_unit            AS ENUM ('PER_HOUR', 'PER_VISIT', 'PER_JOB', 'PER_SESSION', 'PER_DAY');
CREATE TYPE discount_type         AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE service_request_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED');
CREATE TYPE notification_type     AS ENUM (
    'SERVICE_REQUEST_RECEIVED', 'SERVICE_REQUEST_SENT', 'SERVICE_REQUEST_UPDATED',
    'NEW_MESSAGE', 'NEW_REVIEW', 'VERIFICATION_UPDATE', 'APPOINTMENT_REMINDER');
CREATE TYPE interaction_type      AS ENUM ('SERVICE_REQUEST', 'CHAT', 'CALL', 'WHATSAPP');
CREATE TYPE otp_purpose           AS ENUM ('LOGIN', 'PHONE_CHANGE', 'RECOVERY_EMAIL', 'ACCOUNT_RECOVERY');
CREATE TYPE push_delivery_status AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');
CREATE TYPE upload_purpose AS ENUM ('PROFILE_IMAGE', 'IDENTITY_DOCUMENT');
CREATE TYPE upload_status AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETING', 'DELETED');

-- Every user can hire workers. Owning a worker_profiles row adds worker capability.
-- Administrative access is independent and granted through is_admin.
-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone_number       VARCHAR(16)  NOT NULL UNIQUE CHECK (phone_number ~ '^\+961[0-9]{7,8}$'), -- private login/recovery number
    full_name          VARCHAR(120) NOT NULL CHECK (length(btrim(full_name)) > 0), -- canonical name
    search_text TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, full_name)) STORED,
    profile_image_upload_id BIGINT, -- canonical avatar upload; FK added below
    nationality        CHAR(2)      CHECK (nationality ~ '^[A-Z]{2}$'),     -- ISO 3166-1 alpha-2, private
    recovery_email     CITEXT       UNIQUE,                                 -- verified only, private
    -- Private account location; independent of the worker's public service location.
    latitude           DOUBLE PRECISION CHECK (latitude  BETWEEN -90  AND 90),
    longitude          DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    address            VARCHAR(255),
    is_admin           BOOLEAN      NOT NULL DEFAULT FALSE,
    account_status     account_status NOT NULL DEFAULT 'ACTIVE',
    suspended_at       TIMESTAMPTZ,
    suspension_reason  VARCHAR(500) CHECK (suspension_reason IS NULL OR length(btrim(suspension_reason)) > 0),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ,
    CHECK ((latitude IS NULL) = (longitude IS NULL)),
    CONSTRAINT user_account_lifecycle CHECK (
        (account_status = 'ACTIVE' AND suspended_at IS NULL AND suspension_reason IS NULL AND deleted_at IS NULL)
        OR (account_status = 'SUSPENDED' AND suspended_at IS NOT NULL AND suspension_reason IS NOT NULL AND deleted_at IS NULL)
        OR (account_status = 'DELETED' AND deleted_at IS NOT NULL AND suspended_at IS NULL AND suspension_reason IS NULL)
    ),
    CHECK (suspended_at IS NULL OR suspended_at >= created_at),
    CHECK (deleted_at IS NULL OR deleted_at >= created_at),
    CHECK (account_status = 'ACTIVE' OR NOT is_admin)
);
CREATE VIEW active_users AS SELECT * FROM users WHERE deleted_at IS NULL;
CREATE INDEX users_search_idx ON users USING GIN (search_text);
CREATE INDEX users_name_trgm ON users USING GIN (full_name gin_trgm_ops);
CREATE INDEX users_account_status_idx ON users(account_status, id);

-- Soft deletion preserves relationship/history integrity and reserves identifiers.
-- It is not data erasure. A separate retention/anonymization workflow is required
-- before any future controlled purge, including external object cleanup.
CREATE OR REPLACE FUNCTION guard_user_account_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Accounts must be soft deleted; physical purge requires a separate retention workflow'
            USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.account_status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Accounts must start active' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF ROW(NEW.id, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.created_at) THEN
        RAISE EXCEPTION 'Account identity and creation timestamp are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN NEW.account_status := 'DELETED'; END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'Deleted accounts cannot be restored' USING ERRCODE = '23514';
    END IF;
    IF OLD.account_status = 'DELETED' AND NEW.account_status <> 'DELETED' THEN
        RAISE EXCEPTION 'Deleted accounts cannot be reactivated' USING ERRCODE = '23514';
    END IF;
    IF OLD.account_status = 'DELETED' AND ROW(NEW.phone_number, NEW.recovery_email)
       IS DISTINCT FROM ROW(OLD.phone_number, OLD.recovery_email) THEN
        RAISE EXCEPTION 'Deleted account identifiers remain reserved until a controlled purge'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.account_status = OLD.account_status THEN
        IF ROW(NEW.suspended_at, NEW.deleted_at) IS DISTINCT FROM ROW(OLD.suspended_at, OLD.deleted_at) THEN
            RAISE EXCEPTION 'Account lifecycle timestamps are database managed' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.account_status = 'SUSPENDED' THEN
        NEW.suspended_at := GREATEST(clock_timestamp(), OLD.created_at);
        NEW.deleted_at := NULL;
    ELSIF NEW.account_status = 'DELETED' THEN
        NEW.deleted_at := GREATEST(clock_timestamp(), OLD.created_at);
        NEW.suspended_at := NULL;
        NEW.suspension_reason := NULL;
    ELSE
        NEW.suspended_at := NULL;
        NEW.suspension_reason := NULL;
        NEW.deleted_at := NULL;
    END IF;
    IF NEW.account_status <> 'ACTIVE' THEN NEW.is_admin := FALSE; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_account_guard BEFORE INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION guard_user_account_change();

-- Account creation precedes uploads. Storage keys are server assigned and never
-- supplied as arbitrary URLs. PROFILE_IMAGE objects use public image storage;
-- IDENTITY_DOCUMENT objects require private encrypted storage and signed access.
-- SQL validates metadata/ownership; the storage service must enforce ACLs,
-- encryption, byte inspection, image sanitization and actual object existence.
CREATE TABLE file_uploads (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
    purpose upload_purpose NOT NULL,
    status upload_status NOT NULL DEFAULT 'PENDING',
    bucket_name TEXT NOT NULL CHECK (length(btrim(bucket_name)) > 0),
    object_key TEXT NOT NULL CHECK (length(btrim(object_key)) > 0),
    content_type VARCHAR(127),
    size_bytes BIGINT CHECK (size_bytes > 0),
    sha256 BYTEA CHECK (octet_length(sha256) = 32),
    uploaded_at TIMESTAMPTZ,
    upload_expires_at TIMESTAMPTZ NOT NULL,
    cleanup_after TIMESTAMPTZ, -- orphan review eligibility only; never authorizes automatic purge
    delete_requested_at TIMESTAMPTZ,
    storage_deleted_at TIMESTAMPTZ,
    failure_code VARCHAR(120) CHECK (failure_code IS NULL OR length(btrim(failure_code)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (bucket_name, object_key),
    UNIQUE (owner_user_id, id),
    CHECK (upload_expires_at > created_at),
    CHECK ((uploaded_at IS NULL AND content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
        OR (uploaded_at IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL)),
    CHECK (uploaded_at IS NULL OR (uploaded_at >= created_at AND uploaded_at < upload_expires_at)),
    CHECK ((purpose = 'PROFILE_IMAGE' AND (content_type IS NULL OR content_type IN ('image/jpeg', 'image/png', 'image/webp'))
            AND (size_bytes IS NULL OR size_bytes <= 5242880))
        OR (purpose = 'IDENTITY_DOCUMENT' AND (content_type IS NULL OR content_type IN ('image/jpeg', 'image/png', 'application/pdf'))
            AND (size_bytes IS NULL OR size_bytes <= 10485760))),
    CHECK (status <> 'READY' OR uploaded_at IS NOT NULL),
    CHECK (status <> 'PENDING' OR uploaded_at IS NULL),
    CHECK (status <> 'FAILED' OR failure_code IS NOT NULL),
    CHECK ((status IN ('DELETING', 'DELETED')) = (delete_requested_at IS NOT NULL)),
    CHECK ((status = 'DELETED') = (storage_deleted_at IS NOT NULL)),
    CHECK (delete_requested_at IS NULL OR delete_requested_at >= created_at),
    CHECK (storage_deleted_at IS NULL OR storage_deleted_at >= delete_requested_at)
);
CREATE VIEW active_file_uploads AS SELECT * FROM file_uploads WHERE deleted_at IS NULL;
CREATE INDEX file_uploads_owner_idx ON file_uploads(owner_user_id, id);
CREATE INDEX file_uploads_cleanup_idx ON file_uploads(cleanup_after, id)
    WHERE status IN ('PENDING', 'READY', 'FAILED') AND cleanup_after IS NOT NULL;
CREATE INDEX file_uploads_deleting_idx ON file_uploads(delete_requested_at, id) WHERE status = 'DELETING';
ALTER TABLE users ADD CONSTRAINT user_profile_image_owner_fk
    FOREIGN KEY (id, profile_image_upload_id) REFERENCES file_uploads(owner_user_id, id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX users_profile_image_idx ON users(profile_image_upload_id) WHERE profile_image_upload_id IS NOT NULL;

-- OTP flows serialize issuance per account, purpose and normalized destination.
-- LOGIN has no account yet; other flows require an existing account.
-- Application rate limits per IP/destination are additional to the resend interval.
CREATE TABLE otp_flows (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purpose otp_purpose NOT NULL,
    destination VARCHAR(255) NOT NULL CHECK (destination = lower(btrim(destination)) AND length(destination) > 0),
    user_id BIGINT REFERENCES users(id),
    last_issued_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((purpose = 'LOGIN' AND user_id IS NULL) OR (purpose <> 'LOGIN' AND user_id IS NOT NULL)),
    CHECK (purpose NOT IN ('LOGIN', 'PHONE_CHANGE') OR destination ~ '^\+961[0-9]{7,8}$'),
    CHECK (purpose NOT IN ('RECOVERY_EMAIL', 'ACCOUNT_RECOVERY') OR destination ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
);
CREATE VIEW active_otp_flows AS SELECT * FROM otp_flows WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX otp_flows_live_scope_unique ON otp_flows(purpose,destination,user_id)
    NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE INDEX otp_flows_user_idx ON otp_flows(user_id) WHERE user_id IS NOT NULL;

-- Never store plaintext codes. Application HMAC-SHA256 input must include the
-- flow context, fresh issuance_nonce and code, using a server-held secret.
-- Unknown-account recovery gets a generic API response, not a recoverable flow.
CREATE TABLE otp_challenges (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    flow_id BIGINT NOT NULL REFERENCES otp_flows(id),
    issuance_nonce BYTEA NOT NULL UNIQUE CHECK (octet_length(issuance_nonce) = 16),
    code_hash BYTEA NOT NULL CHECK (octet_length(code_hash) = 32),
    attempts SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts = 5),
    expires_at TIMESTAMPTZ NOT NULL,
    resend_after TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    superseded_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (attempts BETWEEN 0 AND max_attempts),
    CHECK (resend_after > created_at AND expires_at > resend_after),
    CHECK (num_nonnulls(consumed_at, superseded_at, invalidated_at) <= 1),
    CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at AND attempts < max_attempts)),
    CHECK (superseded_at IS NULL OR superseded_at >= created_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    CHECK (attempts < max_attempts OR invalidated_at IS NOT NULL)
);
CREATE VIEW active_otp_challenges AS SELECT * FROM otp_challenges WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX otp_challenges_current_idx ON otp_challenges(flow_id)
    WHERE deleted_at IS NULL AND consumed_at IS NULL AND superseded_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX otp_challenges_flow_history_idx ON otp_challenges(flow_id, id DESC);
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges(expires_at);

CREATE OR REPLACE FUNCTION guard_otp_flow_change() RETURNS TRIGGER AS $$
DECLARE
    account_recovery_email TEXT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.user_id IS NOT NULL THEN
            SELECT lower(recovery_email::text) INTO account_recovery_email
            FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
            IF NOT FOUND THEN RAISE EXCEPTION 'OTP account is unavailable' USING ERRCODE = '23514'; END IF;
            IF NEW.purpose = 'ACCOUNT_RECOVERY' AND NEW.destination IS DISTINCT FROM account_recovery_email THEN
                RAISE EXCEPTION 'Account recovery must use the verified recovery email' USING ERRCODE = '23514';
            END IF;
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.last_issued_at := NULL;
        RETURN NEW;
    END IF;
    IF ROW(NEW.id, NEW.purpose, NEW.destination, NEW.user_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.purpose, OLD.destination, OLD.user_id, OLD.created_at) THEN
        RAISE EXCEPTION 'OTP flow identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.last_issued_at IS NOT NULL AND (NEW.last_issued_at IS NULL OR NEW.last_issued_at < OLD.last_issued_at) THEN
        RAISE EXCEPTION 'OTP issuance clock cannot be reset' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER otp_flows_guard BEFORE INSERT OR UPDATE ON otp_flows
FOR EACH ROW EXECUTE FUNCTION guard_otp_flow_change();

CREATE OR REPLACE FUNCTION guard_otp_challenge_change() RETURNS TRIGGER AS $$
DECLARE
    previous_issued_at TIMESTAMPTZ;
    issued_at TIMESTAMPTZ;
    flow_user_id BIGINT;
    flow_purpose otp_purpose;
    flow_destination VARCHAR(255);
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT last_issued_at, user_id, purpose, destination
        INTO previous_issued_at, flow_user_id, flow_purpose, flow_destination
        FROM active_otp_flows WHERE id = NEW.flow_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'OTP flow does not exist' USING ERRCODE = '23503'; END IF;
        issued_at := clock_timestamp();
        IF previous_issued_at IS NOT NULL AND issued_at < previous_issued_at + interval '30 seconds' THEN
            RAISE EXCEPTION 'OTP resend interval has not elapsed' USING ERRCODE = '23514';
        END IF;
        IF flow_user_id IS NOT NULL THEN
            PERFORM 1 FROM active_users WHERE id = flow_user_id AND account_status = 'ACTIVE' FOR SHARE;
            IF NOT FOUND THEN RAISE EXCEPTION 'OTP account is unavailable' USING ERRCODE = '23514'; END IF;
            IF flow_purpose = 'ACCOUNT_RECOVERY' AND NOT EXISTS (
                SELECT 1 FROM active_users WHERE id = flow_user_id AND lower(recovery_email::text) = flow_destination
            ) THEN
                RAISE EXCEPTION 'Recovery flow no longer matches the verified email' USING ERRCODE = '23514';
            END IF;
        END IF;
        UPDATE active_otp_challenges SET superseded_at = issued_at WHERE flow_id = NEW.flow_id
            AND consumed_at IS NULL AND superseded_at IS NULL AND invalidated_at IS NULL;
        UPDATE active_otp_flows SET last_issued_at = issued_at WHERE id = NEW.flow_id;
        NEW.created_at := issued_at;
        NEW.expires_at := issued_at + interval '5 minutes';
        NEW.resend_after := issued_at + interval '30 seconds';
        NEW.max_attempts := 5;
        NEW.attempts := 0;
        NEW.consumed_at := NULL;
        NEW.superseded_at := NULL;
        NEW.invalidated_at := NULL;
        RETURN NEW;
    END IF;
    IF ROW(NEW.id, NEW.flow_id, NEW.issuance_nonce, NEW.code_hash, NEW.max_attempts, NEW.created_at, NEW.expires_at, NEW.resend_after)
       IS DISTINCT FROM ROW(OLD.id, OLD.flow_id, OLD.issuance_nonce, OLD.code_hash, OLD.max_attempts, OLD.created_at, OLD.expires_at, OLD.resend_after) THEN
        RAISE EXCEPTION 'OTP issuance details are immutable' USING ERRCODE = '23514';
    END IF;
    IF num_nonnulls(OLD.consumed_at, OLD.superseded_at, OLD.invalidated_at) > 0 AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Closed OTP challenges are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
        RAISE EXCEPTION 'OTP attempts must increment one at a time' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER otp_challenges_guard BEFORE INSERT OR UPDATE ON otp_challenges
FOR EACH ROW EXECUTE FUNCTION guard_otp_challenge_change();

-- Lock order is flow then challenge, matching issuance. Callers MUST commit
-- failed outcomes so attempt increments persist; throwing/rolling back undoes them.
-- The application must bind p_flow_id to the expected account/purpose/destination.
CREATE OR REPLACE FUNCTION consume_otp_challenge(p_challenge_id BIGINT, p_flow_id BIGINT, p_code_hash BYTEA)
RETURNS TEXT AS $$
DECLARE
    challenge_row otp_challenges%ROWTYPE;
    checked_at TIMESTAMPTZ;
BEGIN
    PERFORM 1 FROM active_otp_flows WHERE id = p_flow_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'OTP_EXPIRED'; END IF;
    SELECT * INTO challenge_row FROM active_otp_challenges WHERE id = p_challenge_id AND flow_id = p_flow_id FOR UPDATE;
    checked_at := clock_timestamp();
    IF NOT FOUND OR challenge_row.expires_at <= checked_at OR challenge_row.attempts >= challenge_row.max_attempts
       OR num_nonnulls(challenge_row.consumed_at, challenge_row.superseded_at, challenge_row.invalidated_at) > 0 THEN
        RETURN 'OTP_EXPIRED';
    END IF;
    IF p_code_hash IS NULL OR challenge_row.code_hash <> p_code_hash THEN
        UPDATE active_otp_challenges SET attempts = attempts + 1,
            invalidated_at = CASE WHEN attempts + 1 >= max_attempts THEN checked_at ELSE NULL END
        WHERE id = p_challenge_id;
        IF challenge_row.attempts + 1 >= challenge_row.max_attempts THEN RETURN 'OTP_EXPIRED'; END IF;
        RETURN 'INVALID_OTP';
    END IF;
    UPDATE active_otp_challenges SET consumed_at = checked_at WHERE id = p_challenge_id;
    RETURN 'OK';
END $$ LANGUAGE plpgsql;

-- One refresh-token family per login session. Absolute expiry is explicit.
-- Access-token validators must check session revocation/expiry for immediate logout.
CREATE TABLE auth_sessions (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
    CHECK (revocation_reason IS NULL OR length(btrim(revocation_reason)) > 0),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CHECK (last_seen_at >= created_at)
);
CREATE VIEW active_auth_sessions AS SELECT * FROM auth_sessions WHERE deleted_at IS NULL;
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id, id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE refresh_tokens (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES auth_sessions(id),
    token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    generation BIGINT NOT NULL CHECK (generation > 0),
    parent_token_id BIGINT UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, id),
    UNIQUE (session_id, generation),
    FOREIGN KEY (session_id, parent_token_id) REFERENCES refresh_tokens(session_id, id),
    CHECK ((generation = 1 AND parent_token_id IS NULL) OR (generation > 1 AND parent_token_id IS NOT NULL)),
    CHECK (parent_token_id IS NULL OR parent_token_id <> id),
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR (used_at >= created_at AND used_at < expires_at)),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE VIEW active_refresh_tokens AS SELECT * FROM refresh_tokens WHERE deleted_at IS NULL;
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens(expires_at);

CREATE OR REPLACE FUNCTION guard_auth_session_change() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Session account is unavailable' USING ERRCODE = '23514'; END IF;
        IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'New session cannot be revoked' USING ERRCODE = '23514'; END IF;
        NEW.created_at := clock_timestamp();
        NEW.last_seen_at := NEW.created_at;
    ELSE
        IF ROW(NEW.id, NEW.user_id, NEW.expires_at, NEW.user_agent, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.expires_at, OLD.user_agent, OLD.created_at) THEN
            RAISE EXCEPTION 'Session identity and absolute expiry are immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.revoked_at IS NOT NULL THEN
            IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Revoked sessions are immutable' USING ERRCODE = '23514'; END IF;
            RETURN OLD;
        END IF;
        IF NEW.revoked_at IS NOT NULL THEN NEW.revoked_at := GREATEST(clock_timestamp(), OLD.created_at); END IF;
        NEW.last_seen_at := GREATEST(clock_timestamp(), OLD.last_seen_at);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER auth_sessions_guard BEFORE INSERT OR UPDATE ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION guard_auth_session_change();

CREATE OR REPLACE FUNCTION guard_refresh_token_change() RETURNS TRIGGER AS $$
DECLARE
    session_row auth_sessions%ROWTYPE;
    parent_row refresh_tokens%ROWTYPE;
    issued_at TIMESTAMPTZ;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM active_auth_sessions WHERE id = OLD.session_id AND revoked_at IS NULL AND expires_at > clock_timestamp()) THEN
            RAISE EXCEPTION 'Keep refresh-token history for active sessions to detect reuse' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id, NEW.session_id, NEW.token_hash, NEW.generation, NEW.parent_token_id, NEW.expires_at, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.session_id, OLD.token_hash, OLD.generation, OLD.parent_token_id, OLD.expires_at, OLD.created_at) THEN
            RAISE EXCEPTION 'Refresh token identity and lineage are immutable' USING ERRCODE = '23514';
        END IF;
        IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
           OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
            RAISE EXCEPTION 'Refresh token use/revocation cannot be undone' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    UPDATE active_auth_sessions SET last_seen_at = clock_timestamp()
    WHERE id = NEW.session_id AND revoked_at IS NULL RETURNING * INTO session_row;
    issued_at := clock_timestamp();
    IF NOT FOUND OR session_row.expires_at <= issued_at THEN
        RAISE EXCEPTION 'Refresh session is expired or revoked' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := issued_at;
    NEW.used_at := NULL;
    NEW.revoked_at := NULL;
    IF NEW.expires_at IS NULL OR NEW.expires_at <= issued_at OR NEW.expires_at > session_row.expires_at THEN
        RAISE EXCEPTION 'Refresh expiry must be in the future and within session lifetime' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_token_id IS NULL THEN
        NEW.generation := 1;
    ELSE
        SELECT * INTO parent_row FROM active_refresh_tokens
        WHERE id = NEW.parent_token_id AND session_id = NEW.session_id FOR UPDATE;
        IF NOT FOUND OR parent_row.used_at IS NOT NULL OR parent_row.revoked_at IS NOT NULL OR parent_row.expires_at <= issued_at THEN
            RAISE EXCEPTION 'Refresh parent is unavailable or already used' USING ERRCODE = '23514';
        END IF;
        NEW.generation := parent_row.generation + 1;
        UPDATE active_refresh_tokens SET used_at = issued_at WHERE id = parent_row.id;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER refresh_tokens_guard BEFORE INSERT OR UPDATE OR DELETE ON refresh_tokens
FOR EACH ROW EXECUTE FUNCTION guard_refresh_token_change();

-- Commit TOKEN_REUSED outcomes; rolling back afterward would undo revocation.
-- Caller supplies a fresh random token hash and returns the raw secret only on OK.
CREATE OR REPLACE FUNCTION rotate_refresh_token(p_token_hash BYTEA, p_new_hash BYTEA, p_expires_at TIMESTAMPTZ)
RETURNS TABLE(outcome TEXT, token_id BIGINT, session_id BIGINT, user_id BIGINT, expires_at TIMESTAMPTZ) AS $$
DECLARE
    old_token refresh_tokens%ROWTYPE;
    session_row auth_sessions%ROWTYPE;
    replacement refresh_tokens%ROWTYPE;
BEGIN
    SELECT * INTO old_token FROM refresh_tokens t WHERE t.token_hash = p_token_hash;
    IF NOT FOUND THEN RETURN QUERY SELECT 'INVALID_TOKEN'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::timestamptz; RETURN; END IF;
    SELECT * INTO session_row FROM active_auth_sessions s WHERE s.id = old_token.session_id FOR UPDATE;
    IF NOT FOUND OR session_row.revoked_at IS NOT NULL OR session_row.expires_at <= clock_timestamp() THEN
        RETURN QUERY SELECT 'INVALID_TOKEN'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::timestamptz; RETURN;
    END IF;
    SELECT * INTO old_token FROM refresh_tokens t WHERE t.id = old_token.id FOR UPDATE;
    IF old_token.deleted_at IS NOT NULL OR old_token.used_at IS NOT NULL OR old_token.revoked_at IS NOT NULL THEN
        UPDATE active_auth_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'REFRESH_TOKEN_REUSED' WHERE id = session_row.id;
        RETURN QUERY SELECT 'TOKEN_REUSED'::text, NULL::bigint, session_row.id, session_row.user_id, NULL::timestamptz; RETURN;
    END IF;
    IF old_token.expires_at <= clock_timestamp() THEN
        RETURN QUERY SELECT 'INVALID_TOKEN'::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::timestamptz; RETURN;
    END IF;
    IF p_expires_at IS NULL THEN RAISE EXCEPTION 'Replacement token expiry is required' USING ERRCODE = '23514'; END IF;
    INSERT INTO refresh_tokens(session_id, token_hash, parent_token_id, expires_at)
    VALUES (session_row.id, p_new_hash, old_token.id, LEAST(p_expires_at, session_row.expires_at)) RETURNING * INTO replacement;
    RETURN QUERY SELECT 'OK'::text, replacement.id, session_row.id, session_row.user_id, replacement.expires_at;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION revoke_account_auth_state() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.phone_number, NEW.recovery_email, NEW.is_admin, NEW.account_status, NEW.deleted_at)
       IS DISTINCT FROM ROW(OLD.phone_number, OLD.recovery_email, OLD.is_admin, OLD.account_status, OLD.deleted_at) THEN
        UPDATE active_auth_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'ACCOUNT_SECURITY_CHANGED'
        WHERE user_id = NEW.id AND revoked_at IS NULL;
        UPDATE active_otp_challenges c SET invalidated_at = clock_timestamp()
        FROM active_otp_flows f WHERE c.flow_id = f.id
            AND (f.user_id = NEW.id OR (f.purpose = 'LOGIN' AND f.destination IN (OLD.phone_number, NEW.phone_number)))
            AND c.consumed_at IS NULL AND c.superseded_at IS NULL AND c.invalidated_at IS NULL;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_revoke_auth_state
AFTER UPDATE OF phone_number, recovery_email, is_admin, account_status, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION revoke_account_auth_state();


CREATE TABLE devices (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fcm_token     TEXT NOT NULL,
    user_id       BIGINT        NOT NULL REFERENCES users(id),
    platform      VARCHAR(16) NOT NULL DEFAULT 'android',
    locale        VARCHAR(8),
    app_version   VARCHAR(32),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE VIEW active_devices AS SELECT * FROM devices WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX devices_live_token_unique ON devices(fcm_token) WHERE deleted_at IS NULL;
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE user_settings (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    user_id                 BIGINT PRIMARY KEY REFERENCES users(id),
    notifications_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
    reminder_lead_minutes   SMALLINT    NOT NULL DEFAULT 60
                            CHECK (reminder_lead_minutes IN (0, 5, 15, 30, 60, 120, 1440)),
    language                VARCHAR(2)  NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fr', 'ar')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE VIEW active_user_settings AS SELECT * FROM user_settings WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- catalog
CREATE TABLE categories (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug         VARCHAR(40) NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
    icon_key     VARCHAR(40) NOT NULL,
    sort_order   SMALLINT    NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE
);
CREATE VIEW active_categories AS SELECT * FROM categories WHERE deleted_at IS NULL;

CREATE TABLE worker_types (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug         VARCHAR(40) NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
    category_id  BIGINT NOT NULL REFERENCES categories(id),
    icon_key     VARCHAR(40) NOT NULL,
    local_name   VARCHAR(80),                     -- Lebanese colloquial name, e.g. 'Mksnyen'
    keywords     TEXT[]      NOT NULL DEFAULT '{}',
    sort_order   SMALLINT    NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT worker_types_id_category_unique UNIQUE (id, category_id)
);
CREATE VIEW active_worker_types AS SELECT * FROM worker_types WHERE deleted_at IS NULL;
CREATE INDEX worker_types_category_idx ON worker_types(category_id);

-- Localized names/descriptions (en / fr / ar), selected by Accept-Language.
CREATE TABLE category_translations (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    category_id  BIGINT NOT NULL REFERENCES categories(id),
    language     VARCHAR(2) NOT NULL CHECK (language IN ('en', 'fr', 'ar')),
    name         VARCHAR(80) NOT NULL CHECK (length(btrim(name)) > 0),
    description  VARCHAR(255) NOT NULL CHECK (length(btrim(description)) > 0),
    PRIMARY KEY (category_id, language)
);
CREATE VIEW active_category_translations AS SELECT * FROM category_translations WHERE deleted_at IS NULL;

CREATE TABLE worker_type_translations (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    worker_type_id BIGINT NOT NULL REFERENCES worker_types(id),
    language       VARCHAR(2) NOT NULL CHECK (language IN ('en', 'fr', 'ar')),
    name           VARCHAR(80) NOT NULL CHECK (length(btrim(name)) > 0),
    PRIMARY KEY (worker_type_id, language)
);
CREATE VIEW active_worker_type_translations AS SELECT * FROM worker_type_translations WHERE deleted_at IS NULL;

CREATE TABLE promo_banners (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title        VARCHAR(120) NOT NULL CHECK (length(btrim(title)) > 0),
    subtitle     VARCHAR(255) NOT NULL,
    language     VARCHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','fr','ar')),
    image_url    TEXT,                                -- optional public promotional image
    icon_key     VARCHAR(40)  NOT NULL,
    category_id  BIGINT  REFERENCES categories(id),
    sort_order   SMALLINT     NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    starts_at    TIMESTAMPTZ,
    ends_at      TIMESTAMPTZ,
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE
);
CREATE VIEW active_promo_banners AS SELECT * FROM promo_banners WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- worker_profiles
-- One individual worker profile per account. user_id is unique; it is not a role flag.
-- Read name and avatar from users through user_id; do not store copies here.
-- Public contact numbers are independent of the private account phone number.
-- Changing an account phone number does not change public contact numbers.
CREATE TABLE worker_profiles (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id              BIGINT         NOT NULL UNIQUE REFERENCES users(id),
    public_phone_number  VARCHAR(16) NOT NULL CHECK (public_phone_number ~ '^\+961[0-9]{7,8}$'),
    whatsapp_number      VARCHAR(16) CHECK (whatsapp_number ~ '^\+961[0-9]{7,8}$'), -- NULL = use public_phone_number
    category_id          BIGINT  NOT NULL REFERENCES categories(id),
    description          VARCHAR(1000) NOT NULL CHECK (length(btrim(description)) > 0),
    experience_years     SMALLINT     NOT NULL DEFAULT 0 CHECK (experience_years BETWEEN 0 AND 80),
    -- NULL price triple means quote required; zero is an explicitly free price.
    starting_price_amount   NUMERIC(14,2) CHECK (starting_price_amount >= 0 AND starting_price_amount <> 'NaN'::numeric),
    starting_price_unit     price_unit,
    starting_price_currency CHAR(3) CHECK (starting_price_currency ~ '^[A-Z]{3}$'),
    -- Public service base used for worker discovery; not the user's private account location.
    latitude             DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude            DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    address              VARCHAR(255),
    time_zone            TEXT NOT NULL DEFAULT 'Asia/Beirut', -- named zone for recurring local working hours
    rating               NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),   -- maintained on review write
    rating_count         BIGINT       NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
    current_identity_document_id BIGINT, -- NULL = NOT_SUBMITTED; status is derived below
    is_available         BOOLEAN      NOT NULL DEFAULT TRUE,
    is_listed            BOOLEAN      NOT NULL DEFAULT TRUE, -- owner may hide listing without deleting history
    joined_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    search_text TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, description)) STORED,
    CONSTRAINT worker_starting_price_complete CHECK (
        (starting_price_amount IS NULL AND starting_price_unit IS NULL AND starting_price_currency IS NULL)
        OR
        (starting_price_amount IS NOT NULL AND starting_price_unit IS NOT NULL AND starting_price_currency IS NOT NULL)
    ),
    CONSTRAINT worker_profiles_id_category_unique UNIQUE (id, category_id),
    CONSTRAINT worker_profiles_id_user_unique UNIQUE (id, user_id)
);
CREATE VIEW active_worker_profiles AS SELECT * FROM worker_profiles WHERE deleted_at IS NULL;
CREATE INDEX worker_profiles_category_idx ON worker_profiles(category_id);
CREATE INDEX worker_profiles_rating_idx ON worker_profiles(rating DESC, id);
CREATE INDEX worker_profiles_geo_idx      ON worker_profiles(latitude, longitude);
CREATE INDEX worker_profiles_search_idx   ON worker_profiles USING GIN (search_text);

-- Ordered worker types; position 0 is the required primary type.
-- category_id ties both sides to the same category through composite foreign keys.
-- Create a profile and its types in one transaction. Category changes must also
-- update these rows in the same transaction before the deferred checks run.
CREATE TABLE worker_worker_types (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    worker_id       BIGINT NOT NULL,
    worker_type_id  BIGINT NOT NULL,
    category_id     BIGINT NOT NULL,
    position        SMALLINT NOT NULL CHECK (position >= 0),
    PRIMARY KEY (worker_id, worker_type_id),
    CONSTRAINT worker_types_position_unique EXCLUDE USING gist (worker_id WITH =, position WITH =)
        WHERE (deleted_at IS NULL) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT worker_types_profile_category_fk
        FOREIGN KEY (worker_id, category_id)
        REFERENCES worker_profiles(id, category_id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT worker_types_catalog_category_fk
        FOREIGN KEY (worker_type_id, category_id)
        REFERENCES worker_types(id, category_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE VIEW active_worker_worker_types AS SELECT * FROM worker_worker_types WHERE deleted_at IS NULL;
CREATE INDEX worker_worker_types_type_idx ON worker_worker_types(worker_type_id, category_id);

-- A foreign key cannot express "every parent must have a child at position 0".
-- Check the final transaction state, including both profiles on a reassignment.
CREATE OR REPLACE FUNCTION require_worker_primary_type() RETURNS TRIGGER AS $$
DECLARE
    affected_ids BIGINT[];
    target_id BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'worker_profiles' THEN
        IF TG_OP = 'INSERT' THEN
            affected_ids := ARRAY[NEW.id];
        ELSE
            affected_ids := ARRAY[OLD.id, NEW.id];
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        affected_ids := ARRAY[OLD.worker_id];
    ELSIF TG_OP = 'INSERT' THEN
        affected_ids := ARRAY[NEW.worker_id];
    ELSE
        affected_ids := ARRAY[OLD.worker_id, NEW.worker_id];
    END IF;

    FOR target_id IN
        SELECT DISTINCT value FROM unnest(affected_ids) AS affected(value) ORDER BY value
    LOOP
        -- Serialize final checks for the same profile. Deleted profiles need no types.
        PERFORM 1 FROM active_worker_profiles WHERE id = target_id FOR UPDATE;
        IF FOUND THEN
            IF NOT EXISTS (
                SELECT 1 FROM active_worker_worker_types
                WHERE worker_id = target_id AND position = 0
            ) THEN
                RAISE EXCEPTION 'Worker profile % must have a primary worker type at position 0', target_id
                    USING ERRCODE = '23514', CONSTRAINT = 'worker_primary_type_required';
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER worker_profiles_require_primary_type
AFTER INSERT OR UPDATE OF id, category_id, deleted_at ON worker_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_worker_primary_type();

CREATE CONSTRAINT TRIGGER worker_types_require_primary_type
AFTER INSERT OR UPDATE OR DELETE ON worker_worker_types
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_worker_primary_type();

CREATE TABLE worker_services (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id       BIGINT         NOT NULL REFERENCES worker_profiles(id),
    name            VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
    description     VARCHAR(500),
    -- An independent service quote; do not compare amounts across currencies or units.
    price_amount    NUMERIC(14,2) CHECK (price_amount >= 0 AND price_amount <> 'NaN'::numeric),
    price_unit      price_unit,
    price_currency  CHAR(3) CHECK (price_currency ~ '^[A-Z]{3}$'),
    sort_order      SMALLINT NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT worker_service_price_complete CHECK (
        (price_amount IS NULL AND price_unit IS NULL AND price_currency IS NULL)
        OR
        (price_amount IS NOT NULL AND price_unit IS NOT NULL AND price_currency IS NOT NULL)
    )
);
CREATE VIEW active_worker_services AS SELECT * FROM worker_services WHERE deleted_at IS NULL;
CREATE INDEX worker_services_worker_idx ON worker_services(worker_id);

CREATE OR REPLACE FUNCTION validate_worker_time_zone() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_timezone_names
        WHERE name = NEW.time_zone AND (name = 'UTC' OR position('/' IN name) > 0)
          AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
    ) THEN
        RAISE EXCEPTION 'Worker time_zone must be a recognized named timezone, such as Asia/Beirut or UTC'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_profiles_time_zone_guard
BEFORE INSERT OR UPDATE OF time_zone ON worker_profiles
FOR EACH ROW EXECUTE FUNCTION validate_worker_time_zone();

-- Map local weekly intervals to minute ranges in [0, 10080). Sunday overnight
-- intervals wrap into Monday using a second range. Half-open bounds permit
-- adjacent shifts while rejecting any overlap, including across week boundaries.
CREATE OR REPLACE FUNCTION weekly_working_span(
    p_day SMALLINT, p_opens TIME, p_closes TIME, p_end_day_offset SMALLINT
) RETURNS INT4MULTIRANGE LANGUAGE SQL IMMUTABLE STRICT AS $$
    WITH bounds AS (
        SELECT (p_day - 1) * 1440 + extract(hour FROM p_opens)::integer * 60
                   + extract(minute FROM p_opens)::integer AS starts,
               (p_day - 1 + p_end_day_offset) * 1440 + extract(hour FROM p_closes)::integer * 60
                   + extract(minute FROM p_closes)::integer AS ends
    )
    SELECT CASE WHEN ends <= 10080 THEN int4multirange(int4range(starts, ends, '[)'))
                ELSE int4multirange(int4range(starts, 10080, '[)'), int4range(0, ends - 10080, '[)'))
           END FROM bounds;
$$;

-- Recurring wall-clock hours in worker_profiles.time_zone, not UTC offsets.
-- ISO weekday: 1=Monday ... 7=Sunday. Multiple rows allow split shifts.
-- No intervals means no declared hours; it does not assert that the worker is closed.
-- end_day_offset=1 crosses midnight. Equal opening/closing times with offset 1
-- mean a full 24 hours; intervals longer than 24 hours are not allowed.
-- Appointments remain TIMESTAMPTZ instants, independent of recurring hours.
CREATE TABLE worker_working_hours (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id BIGINT NOT NULL REFERENCES worker_profiles(id),
    iso_weekday SMALLINT NOT NULL CHECK (iso_weekday BETWEEN 1 AND 7),
    opens_at TIME NOT NULL CHECK (extract(second FROM opens_at) = 0 AND opens_at < TIME '24:00'),
    closes_at TIME NOT NULL CHECK (extract(second FROM closes_at) = 0 AND closes_at < TIME '24:00'),
    end_day_offset SMALLINT NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0, 1)),
    weekly_span INT4MULTIRANGE GENERATED ALWAYS AS (
        weekly_working_span(iso_weekday, opens_at, closes_at, end_day_offset)
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT worker_working_interval_duration CHECK (
        (end_day_offset = 0 AND closes_at > opens_at)
        OR (end_day_offset = 1 AND closes_at <= opens_at)
    ),
    CONSTRAINT worker_working_hours_no_overlap
        EXCLUDE USING gist (worker_id WITH =, weekly_span WITH &&)
        WHERE (deleted_at IS NULL) DEFERRABLE INITIALLY DEFERRED
);
CREATE VIEW active_worker_working_hours AS SELECT * FROM worker_working_hours WHERE deleted_at IS NULL;
CREATE INDEX worker_working_hours_schedule_idx ON worker_working_hours(worker_id, iso_weekday, opens_at);

-- At most one discount per worker, applying only to the starting price.
-- FIXED_AMOUNT records that price's currency/unit so edits cannot reinterpret its value.
-- PERCENTAGE is dimensionless. Neither type applies to individual service prices.
-- Expiry controls visibility, not integrity: remove expired discounts if no longer applicable.
CREATE TABLE worker_discounts (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id   BIGINT          NOT NULL REFERENCES worker_profiles(id),
    type        discount_type NOT NULL,
    value       NUMERIC(14,2) NOT NULL CHECK (value > 0 AND value <> 'NaN'::numeric),
    currency    CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
    unit        price_unit,
    title       VARCHAR(80) CHECK (title IS NULL OR length(btrim(title)) > 0),
    expires_at  TIMESTAMPTZ,                       -- NULL = no expiry; inactive once passed
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT worker_discount_dimensions CHECK (
        (type = 'FIXED_AMOUNT' AND currency IS NOT NULL AND unit IS NOT NULL)
        OR (type = 'PERCENTAGE' AND currency IS NULL AND unit IS NULL)
    ),
    CHECK (type <> 'PERCENTAGE' OR value <= 100),
    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE VIEW active_worker_discounts AS SELECT * FROM worker_discounts WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX worker_discounts_live_unique ON worker_discounts(worker_id) WHERE deleted_at IS NULL;

-- Serialize discount changes with price changes on the owning profile.
-- Updating the parent also makes concurrent stale snapshots detect a row change.
CREATE OR REPLACE FUNCTION serialize_worker_discount_change() RETURNS TRIGGER AS $$
DECLARE
    affected_ids BIGINT[];
    target_id BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        affected_ids := ARRAY[NEW.worker_id];
    ELSIF TG_OP = 'DELETE' THEN
        affected_ids := ARRAY[OLD.worker_id];
    ELSE
        affected_ids := ARRAY[OLD.worker_id, NEW.worker_id];
    END IF;
    FOR target_id IN
        SELECT DISTINCT value FROM unnest(affected_ids) AS affected(value) ORDER BY value
    LOOP
        UPDATE active_worker_profiles SET updated_at = now() WHERE id = target_id;
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_discounts_serialize
BEFORE INSERT OR UPDATE OR DELETE ON worker_discounts
FOR EACH ROW EXECUTE FUNCTION serialize_worker_discount_change();

-- Validate final state so related price/discount edits can occur in either order.
CREATE OR REPLACE FUNCTION validate_worker_starting_discount() RETURNS TRIGGER AS $$
DECLARE
    affected_ids BIGINT[];
    target_id BIGINT;
    base_amount NUMERIC;
    base_currency CHAR(3);
    base_unit price_unit;
    discount_row worker_discounts%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'worker_profiles' THEN
        affected_ids := ARRAY[NEW.id];
    ELSIF TG_OP = 'INSERT' THEN
        affected_ids := ARRAY[NEW.worker_id];
    ELSE
        affected_ids := ARRAY[OLD.worker_id, NEW.worker_id];
    END IF;
    FOR target_id IN
        SELECT DISTINCT value FROM unnest(affected_ids) AS affected(value) ORDER BY value
    LOOP
        SELECT starting_price_amount, starting_price_currency, starting_price_unit
        INTO base_amount, base_currency, base_unit
        FROM active_worker_profiles WHERE id = target_id FOR UPDATE;
        IF NOT FOUND THEN CONTINUE; END IF;

        SELECT * INTO discount_row FROM active_worker_discounts WHERE worker_id = target_id;
        IF NOT FOUND THEN CONTINUE; END IF;

        IF base_amount IS NULL OR base_amount <= 0 THEN
            RAISE EXCEPTION 'Worker profile % requires a positive starting price for a discount', target_id
                USING ERRCODE = '23514', CONSTRAINT = 'worker_discount_requires_price';
        END IF;
        IF discount_row.type = 'FIXED_AMOUNT' AND discount_row.value > base_amount THEN
            RAISE EXCEPTION 'Fixed discount exceeds starting price for worker profile %', target_id
                USING ERRCODE = '23514', CONSTRAINT = 'worker_discount_within_price';
        END IF;
        IF discount_row.type = 'FIXED_AMOUNT'
           AND (discount_row.currency <> base_currency OR discount_row.unit <> base_unit) THEN
            RAISE EXCEPTION 'Fixed discount currency and unit must match starting price for worker profile %', target_id
                USING ERRCODE = '23514', CONSTRAINT = 'worker_discount_price_dimensions';
        END IF;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER worker_profiles_validate_discount
AFTER INSERT OR UPDATE ON worker_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_worker_starting_discount();

CREATE CONSTRAINT TRIGGER worker_discounts_validate_price
AFTER INSERT OR UPDATE ON worker_discounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_worker_starting_discount();

-- PRIVATE. Each row is a submission; resubmission creates a new row, never overwrites a file.
-- upload_id identifies a private identity upload; storage details stay in file_uploads.
CREATE TABLE identity_documents (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id          BIGINT                   NOT NULL REFERENCES worker_profiles(id),
    submission_number  BIGINT NOT NULL CHECK (submission_number > 0), -- assigned under the profile lock
    type               identity_document_type NOT NULL,
    upload_id          BIGINT NOT NULL UNIQUE REFERENCES file_uploads(id),
    status             document_review_status NOT NULL DEFAULT 'PENDING',
    submitted_at       TIMESTAMPTZ            NOT NULL DEFAULT now(),
    reviewed_at        TIMESTAMPTZ,
    reviewed_by        BIGINT REFERENCES users(id),
    rejection_reason   VARCHAR(500),
    CONSTRAINT identity_document_worker_id_unique UNIQUE (worker_id, id),
    CONSTRAINT identity_document_submission_unique UNIQUE (worker_id, submission_number),
    CONSTRAINT identity_document_review_metadata CHECK (
        (status = 'PENDING' AND reviewed_at IS NULL AND reviewed_by IS NULL AND rejection_reason IS NULL)
        OR
        (status = 'VERIFIED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
        OR
        (status = 'REJECTED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
            AND rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) > 0)
    ),
    CHECK (reviewed_at IS NULL OR reviewed_at >= submitted_at)
);
CREATE VIEW active_identity_documents AS SELECT * FROM identity_documents WHERE deleted_at IS NULL;
CREATE INDEX identity_documents_pending_idx ON identity_documents(submitted_at) WHERE status = 'PENDING';

-- A profile can point only to its own document. Deferred to permit cascading deletion.
ALTER TABLE worker_profiles ADD CONSTRAINT worker_current_identity_document_fk
    FOREIGN KEY (id, current_identity_document_id)
    REFERENCES identity_documents(worker_id, id)
    DEFERRABLE INITIALLY DEFERRED;

-- This is the single derived worker verification status; no independently writable copy.
CREATE VIEW worker_verification AS
SELECT w.id AS worker_id,
       w.current_identity_document_id,
       CASE WHEN d.id IS NULL THEN 'NOT_SUBMITTED'::verification_status
            ELSE d.status::text::verification_status END AS verification_status
FROM active_worker_profiles w
LEFT JOIN active_identity_documents d ON d.worker_id = w.id AND d.id = w.current_identity_document_id;

-- Public discovery must read this view. Unavailability remains a visible status;
-- hiding the listing, losing verification or disabling the account removes it.
-- Private account phone/email/location/nationality and document IDs are excluded.
CREATE VIEW public_worker_profiles AS
SELECT w.id, w.user_id, u.full_name, u.profile_image_upload_id,
       w.public_phone_number, w.whatsapp_number, w.category_id, w.description,
       w.experience_years, w.starting_price_amount, w.starting_price_unit, w.starting_price_currency,
       w.latitude, w.longitude, w.address, w.time_zone, w.rating, w.rating_count,
       v.verification_status, w.is_available, w.joined_at
FROM active_worker_profiles w JOIN active_users u ON u.id = w.user_id
JOIN worker_verification v ON v.worker_id = w.id
JOIN active_categories c ON c.id = w.category_id AND c.is_active
JOIN active_worker_worker_types primary_type ON primary_type.worker_id = w.id AND primary_type.position = 0
JOIN active_worker_types wt ON wt.id = primary_type.worker_type_id AND wt.is_active
WHERE u.account_status = 'ACTIVE' AND w.is_listed AND v.verification_status = 'VERIFIED';

CREATE OR REPLACE FUNCTION guard_identity_document_change() RETURNS TRIGGER AS $$
DECLARE
    current_document_id BIGINT;
    reviewer_is_admin BOOLEAN;
    worker_owner_id BIGINT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        -- A real parent update serializes submissions/reviews even with stale snapshots.
        UPDATE active_worker_profiles SET updated_at = now() WHERE id = NEW.worker_id RETURNING user_id INTO worker_owner_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Worker profile % does not exist', NEW.worker_id USING ERRCODE = '23503';
        END IF;
        PERFORM 1 FROM active_users WHERE id = worker_owner_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Identity submission owner must be active' USING ERRCODE = '23514';
        END IF;
        PERFORM 1 FROM active_file_uploads WHERE id = NEW.upload_id AND owner_user_id = worker_owner_id
            AND purpose = 'IDENTITY_DOCUMENT' AND status = 'READY' FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Identity submission requires a ready identity upload owned by the worker'
                USING ERRCODE = '23514';
        END IF;
        SELECT COALESCE(max(submission_number), 0) + 1 INTO NEW.submission_number
        FROM identity_documents WHERE worker_id = NEW.worker_id;
        IF NEW.status <> 'PENDING' OR NEW.reviewed_at IS NOT NULL
           OR NEW.reviewed_by IS NOT NULL OR NEW.rejection_reason IS NOT NULL THEN
            RAISE EXCEPTION 'Identity submissions must start pending and unreviewed' USING ERRCODE = '23514';
        END IF;
        NEW.submitted_at := clock_timestamp();
        RETURN NEW;
    END IF;

    UPDATE active_worker_profiles SET updated_at = now() WHERE id = OLD.worker_id
        RETURNING current_identity_document_id INTO current_document_id;
    IF TG_OP = 'DELETE' THEN
        -- Keep history while a profile exists; allow its cleanup.
        IF FOUND THEN
            RAISE EXCEPTION 'Identity submission history cannot be deleted while its profile exists'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(NEW.id, NEW.worker_id, NEW.submission_number, NEW.type, NEW.upload_id, NEW.submitted_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.worker_id, OLD.submission_number, OLD.type, OLD.upload_id, OLD.submitted_at) THEN
        RAISE EXCEPTION 'Identity submission details are immutable; create a new submission'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'Finalized identity reviews are immutable' USING ERRCODE = '23514';
    END IF;
    IF current_document_id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'A superseded identity submission cannot be reviewed' USING ERRCODE = '23514';
    END IF;
    IF NEW.status NOT IN ('VERIFIED', 'REJECTED') THEN
        RAISE EXCEPTION 'Review must approve or reject the pending submission' USING ERRCODE = '23514';
    END IF;

    SELECT u.is_admin INTO reviewer_is_admin
    FROM active_users u JOIN active_worker_profiles w ON w.id = OLD.worker_id
    WHERE u.id = NEW.reviewed_by AND u.account_status = 'ACTIVE' AND u.id <> w.user_id
    FOR SHARE OF u;
    IF reviewer_is_admin IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Review requires an active administrator other than the profile owner'
            USING ERRCODE = '23514';
    END IF;
    NEW.reviewed_at := clock_timestamp();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER identity_documents_guard
BEFORE INSERT OR UPDATE OR DELETE ON identity_documents
FOR EACH ROW EXECUTE FUNCTION guard_identity_document_change();

CREATE OR REPLACE FUNCTION select_current_identity_document() RETURNS TRIGGER AS $$
BEGIN
    UPDATE active_worker_profiles SET current_identity_document_id = (
        SELECT CASE WHEN d.deleted_at IS NULL THEN d.id END FROM identity_documents d
        WHERE d.worker_id = NEW.worker_id ORDER BY d.submission_number DESC LIMIT 1
    ) WHERE id = NEW.worker_id;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER identity_documents_select_current
AFTER INSERT OR UPDATE OF deleted_at ON identity_documents
FOR EACH ROW EXECUTE FUNCTION select_current_identity_document();

-- Prevent manually selecting old submissions or clearing the current pointer.
CREATE OR REPLACE FUNCTION validate_current_identity_document() RETURNS TRIGGER AS $$
DECLARE
    actual_document_id BIGINT;
    latest_document_id BIGINT;
BEGIN
    SELECT current_identity_document_id INTO actual_document_id
    FROM active_worker_profiles WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT CASE WHEN deleted_at IS NULL THEN id END INTO latest_document_id FROM identity_documents
    WHERE worker_id = NEW.id ORDER BY submission_number DESC LIMIT 1;
    IF actual_document_id IS DISTINCT FROM latest_document_id THEN
        RAISE EXCEPTION 'Worker profile % must reference its latest identity submission', NEW.id
            USING ERRCODE = '23514', CONSTRAINT = 'worker_current_identity_document_required';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER worker_profiles_current_identity_document
AFTER INSERT OR UPDATE ON worker_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_current_identity_document();

-- ---------------------------------------------------------------- favorites
CREATE TABLE favorites (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    user_id     BIGINT        NOT NULL REFERENCES users(id)  ,
    worker_id   BIGINT        NOT NULL REFERENCES worker_profiles(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, worker_id)
);
CREATE VIEW active_favorites AS SELECT * FROM favorites WHERE deleted_at IS NULL;
CREATE INDEX favorites_worker_idx ON favorites(worker_id);
CREATE INDEX favorites_user_recent_idx ON favorites(user_id, created_at DESC, worker_id);

CREATE OR REPLACE FUNCTION guard_favorite_change() RETURNS TRIGGER AS $$
DECLARE
    owner_id BIGINT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Favorites cannot be edited; remove or add the relationship' USING ERRCODE = '23514';
    END IF;
    SELECT w.user_id INTO owner_id FROM active_worker_profiles w JOIN active_users u ON u.id = w.user_id
    WHERE w.id = NEW.worker_id AND u.account_status = 'ACTIVE' AND w.is_listed
      AND EXISTS (SELECT 1 FROM worker_verification v WHERE v.worker_id = w.id AND v.verification_status = 'VERIFIED') FOR SHARE OF w, u;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Favorite worker is unavailable' USING ERRCODE = '23514';
    END IF;
    IF NEW.user_id = owner_id THEN
        RAISE EXCEPTION 'A user cannot favorite their own worker profile' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Favorite owner is unavailable' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public_worker_profiles WHERE id = NEW.worker_id) THEN
        RAISE EXCEPTION 'New favorites require a verified worker' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER favorites_guard
BEFORE INSERT OR UPDATE ON favorites
FOR EACH ROW EXECUTE FUNCTION guard_favorite_change();

-- ---------------------------------------------------------------- chat
-- One conversation per requesting user and worker profile. A worker account may
-- contact another worker, but cannot create a conversation with its own profile.
CREATE TABLE conversations (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id      BIGINT        NOT NULL REFERENCES users(id)  ,
    worker_id        BIGINT NOT NULL,
    worker_user_id   BIGINT NOT NULL REFERENCES users(id), -- assigned from the profile owner
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, worker_id),
    CONSTRAINT conversation_id_participants_unique UNIQUE (id, worker_id, customer_id),
    CONSTRAINT conversation_worker_owner_fk FOREIGN KEY (worker_id, worker_user_id)
        REFERENCES worker_profiles(id, user_id),
    CONSTRAINT conversation_distinct_participants CHECK (customer_id <> worker_user_id)
);
CREATE VIEW active_conversations AS SELECT * FROM conversations WHERE deleted_at IS NULL;
CREATE INDEX conversations_customer_idx ON conversations(customer_id, updated_at DESC, id DESC);
CREATE INDEX conversations_worker_idx ON conversations(worker_id, updated_at DESC, id DESC);
CREATE INDEX conversations_worker_user_idx ON conversations(worker_user_id, updated_at DESC, id DESC);

-- The application supplies sender_id from the authenticated identity. SQL checks
-- membership; it does not independently authenticate the application caller.
-- message_number is database assigned, strictly increasing within a conversation.
-- Paginate with (conversation_id, message_number), not a timestamp alone.
CREATE TABLE messages (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id  BIGINT          NOT NULL REFERENCES conversations(id),
    sender_id        BIGINT          NOT NULL REFERENCES users(id),
    message_number   BIGINT NOT NULL CHECK (message_number > 0),
    text             VARCHAR(2000) NOT NULL CHECK (length(btrim(text)) > 0),
    sent_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, message_number)
);
CREATE VIEW active_messages AS SELECT * FROM messages WHERE deleted_at IS NULL;
CREATE INDEX messages_sender_idx ON messages(sender_id);

-- Latest message is derived, not copied into the conversations table.
CREATE VIEW conversation_summaries AS
SELECT c.*, m.id AS last_message_id, m.text AS last_message, m.sent_at AS last_message_at
FROM active_conversations c
LEFT JOIN LATERAL (
    SELECT id, text, sent_at FROM active_messages
    WHERE conversation_id = c.id ORDER BY message_number DESC LIMIT 1
) m ON TRUE;

CREATE OR REPLACE FUNCTION guard_conversation_change() RETURNS TRIGGER AS $$
DECLARE
    assigned_user_id BIGINT;
    latest_message_at TIMESTAMPTZ;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT w.user_id INTO assigned_user_id FROM active_worker_profiles w
        JOIN active_users u ON u.id = w.user_id
        WHERE w.id = NEW.worker_id AND u.account_status = 'ACTIVE' AND w.is_listed
      AND EXISTS (SELECT 1 FROM worker_verification v WHERE v.worker_id = w.id AND v.verification_status = 'VERIFIED')
        FOR SHARE OF w, u;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Conversation worker profile is unavailable' USING ERRCODE = '23503';
        END IF;
        IF NEW.worker_user_id IS NOT NULL AND NEW.worker_user_id <> assigned_user_id THEN
            RAISE EXCEPTION 'Conversation worker user does not match profile owner' USING ERRCODE = '23514';
        END IF;
        NEW.worker_user_id := assigned_user_id;
        PERFORM 1 FROM active_users WHERE id = NEW.customer_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Conversation customer is unavailable' USING ERRCODE = '23503';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.updated_at := NEW.created_at;
        RETURN NEW;
    END IF;

    IF ROW(NEW.id, NEW.customer_id, NEW.worker_id, NEW.worker_user_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.customer_id, OLD.worker_id, OLD.worker_user_id, OLD.created_at) THEN
        RAISE EXCEPTION 'Conversation identity and participants are immutable' USING ERRCODE = '23514';
    END IF;
    SELECT sent_at INTO latest_message_at FROM active_messages
    WHERE conversation_id = OLD.id ORDER BY message_number DESC LIMIT 1;
    NEW.updated_at := COALESCE(latest_message_at, OLD.created_at);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_guard
BEFORE INSERT OR UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION guard_conversation_change();

CREATE OR REPLACE FUNCTION guard_message_change() RETURNS TRIGGER AS $$
DECLARE
    conversation_customer_id BIGINT;
    conversation_worker_user_id BIGINT;
    conversation_updated_at TIMESTAMPTZ;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM active_conversations WHERE id = OLD.conversation_id) THEN
            RAISE EXCEPTION 'Messages cannot be deleted while their conversation exists' USING ERRCODE = '23514';
        END IF;
        RETURN OLD; -- physical DELETE is blocked by the common policy
    ELSIF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Messages are immutable' USING ERRCODE = '23514';
    END IF;

    -- Serialize senders before assigning sequence numbers and checking participants.
    -- A real row update also forces stale concurrent snapshots to detect the change.
    UPDATE active_conversations SET updated_at = updated_at WHERE id = NEW.conversation_id
        RETURNING customer_id, worker_user_id, updated_at
        INTO conversation_customer_id, conversation_worker_user_id, conversation_updated_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversation does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.sender_id IS NULL OR NEW.sender_id NOT IN (conversation_customer_id, conversation_worker_user_id) THEN
        RAISE EXCEPTION 'Message sender must be a conversation participant' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.sender_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Message sender is unavailable' USING ERRCODE = '23514';
    END IF;
    NEW.text := btrim(NEW.text);
    SELECT COALESCE(max(message_number), 0) + 1 INTO NEW.message_number
    FROM messages WHERE conversation_id = NEW.conversation_id;
    NEW.sent_at := GREATEST(clock_timestamp(), conversation_updated_at);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER messages_guard
BEFORE INSERT OR UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION guard_message_change();

CREATE OR REPLACE FUNCTION refresh_conversation_activity() RETURNS TRIGGER AS $$
BEGIN
    -- conversations_guard derives updated_at from the now-inserted latest message.
    UPDATE active_conversations SET updated_at = NEW.sent_at WHERE id = NEW.conversation_id;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER messages_refresh_conversation
AFTER INSERT OR UPDATE OF deleted_at ON messages
FOR EACH ROW EXECUTE FUNCTION refresh_conversation_activity();

-- ---------------------------------------------------------------- service requests
-- Requests retain their original parties, details and appointment time.
-- The server supplies status_changed_by from the authenticated identity; this
-- records/validates the actor, but is not a substitute for authenticating callers.
CREATE TABLE service_requests (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id     BIGINT NOT NULL,
    worker_user_id BIGINT NOT NULL REFERENCES users(id), -- populated from the assigned profile
    customer_id   BIGINT        NOT NULL REFERENCES users(id)  ,
    details       VARCHAR(1000) CHECK (details IS NULL OR length(btrim(details)) > 0),
    scheduled_at  TIMESTAMPTZ, -- checked at creation, not with a time-dependent CHECK
    status        service_request_status NOT NULL DEFAULT 'PENDING',
    status_changed_by BIGINT NOT NULL REFERENCES users(id),
    status_reason VARCHAR(500) CHECK (status_reason IS NULL OR length(btrim(status_reason)) > 0),
    status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version       BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT request_worker_owner_fk FOREIGN KEY (worker_id, worker_user_id)
        REFERENCES worker_profiles(id, user_id),
    CONSTRAINT request_distinct_participants CHECK (customer_id <> worker_user_id),
    CONSTRAINT request_status_actor CHECK (status_changed_by IN (customer_id, worker_user_id)),
    CONSTRAINT request_reason_status CHECK (status_reason IS NULL OR status IN ('DECLINED', 'CANCELLED')),
    CONSTRAINT request_id_participants_unique UNIQUE (id, worker_id, customer_id)
);
CREATE VIEW active_service_requests AS SELECT * FROM service_requests WHERE deleted_at IS NULL;
CREATE INDEX service_requests_worker_idx ON service_requests(worker_id, created_at DESC, id DESC);
CREATE INDEX service_requests_worker_user_idx ON service_requests(worker_user_id, status, created_at DESC, id DESC);
CREATE INDEX service_requests_customer_idx ON service_requests(customer_id, created_at DESC, id DESC);
CREATE INDEX service_requests_actor_idx ON service_requests(status_changed_by);

CREATE TABLE service_request_events (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id  BIGINT NOT NULL REFERENCES service_requests(id),
    version     BIGINT NOT NULL CHECK (version > 0),
    from_status service_request_status,
    to_status   service_request_status NOT NULL,
    actor_id    BIGINT NOT NULL REFERENCES users(id),
    reason      VARCHAR(500) CHECK (reason IS NULL OR length(btrim(reason)) > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    UNIQUE (request_id, version),
    CHECK ((version = 1 AND from_status IS NULL AND to_status = 'PENDING')
        OR (version > 1 AND from_status IS NOT NULL AND from_status <> to_status)),
    CHECK (reason IS NULL OR to_status IN ('DECLINED', 'CANCELLED'))
);
CREATE VIEW active_service_request_events AS SELECT * FROM service_request_events WHERE deleted_at IS NULL;
CREATE INDEX service_request_events_actor_idx ON service_request_events(actor_id);

CREATE OR REPLACE FUNCTION guard_service_request_change() RETURNS TRIGGER AS $$
DECLARE
    assigned_user_id BIGINT;
    transition_allowed BOOLEAN;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT w.user_id INTO assigned_user_id FROM active_worker_profiles w
        JOIN active_users u ON u.id = w.user_id
        WHERE w.id = NEW.worker_id AND u.account_status = 'ACTIVE' AND w.is_listed
      AND EXISTS (SELECT 1 FROM worker_verification v WHERE v.worker_id = w.id AND v.verification_status = 'VERIFIED')
        FOR SHARE OF w, u;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Assigned worker profile is unavailable' USING ERRCODE = '23503';
        END IF;
        IF NEW.worker_user_id IS NOT NULL AND NEW.worker_user_id <> assigned_user_id THEN
            RAISE EXCEPTION 'Assigned worker user does not match the profile owner' USING ERRCODE = '23514';
        END IF;
        NEW.worker_user_id := assigned_user_id;
        PERFORM 1 FROM active_users WHERE id = NEW.customer_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Request customer is unavailable' USING ERRCODE = '23503';
        END IF;
        IF NEW.status <> 'PENDING' THEN
            RAISE EXCEPTION 'Service requests must start pending' USING ERRCODE = '23514';
        END IF;
        IF NEW.status_changed_by IS NOT NULL AND NEW.status_changed_by <> NEW.customer_id THEN
            RAISE EXCEPTION 'Only the customer can submit the request' USING ERRCODE = '23514';
        END IF;
        NEW.status_changed_by := NEW.customer_id;
        NEW.created_at := clock_timestamp();
        NEW.status_changed_at := NEW.created_at;
        NEW.updated_at := NEW.created_at;
        NEW.version := 1;
        IF NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at <= NEW.created_at THEN
            RAISE EXCEPTION 'Appointment must be in the future when submitted' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW.id, NEW.worker_id, NEW.worker_user_id, NEW.customer_id, NEW.details, NEW.scheduled_at, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.worker_id, OLD.worker_user_id, OLD.customer_id, OLD.details, OLD.scheduled_at, OLD.created_at) THEN
        RAISE EXCEPTION 'Submitted request details and participants are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = OLD.status THEN
        RAISE EXCEPTION 'A request update must change its status' USING ERRCODE = '23514';
    END IF;

    transition_allowed :=
        (NEW.status_changed_by = OLD.worker_user_id AND (
            (OLD.status = 'PENDING' AND NEW.status IN ('ACCEPTED', 'DECLINED'))
            OR (OLD.status = 'ACCEPTED' AND NEW.status = 'COMPLETED')
        )) OR
        (NEW.status_changed_by = OLD.customer_id
            AND OLD.status IN ('PENDING', 'ACCEPTED') AND NEW.status = 'CANCELLED');
    IF transition_allowed IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Invalid request transition or actor' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.status_changed_by AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request actor is unavailable' USING ERRCODE = '23514';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.status_changed_at := clock_timestamp();
    NEW.updated_at := NEW.status_changed_at;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER service_requests_guard
BEFORE INSERT OR UPDATE ON service_requests
FOR EACH ROW EXECUTE FUNCTION guard_service_request_change();

CREATE OR REPLACE FUNCTION record_service_request_event() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO service_request_events(request_id, version, from_status, to_status, actor_id, reason, occurred_at)
        VALUES (NEW.id, NEW.version, NULL, NEW.status, NEW.status_changed_by, NEW.status_reason, NEW.status_changed_at);
    ELSE
        INSERT INTO service_request_events(request_id, version, from_status, to_status, actor_id, reason, occurred_at)
        VALUES (NEW.id, NEW.version, OLD.status, NEW.status, NEW.status_changed_by, NEW.status_reason, NEW.status_changed_at);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER service_requests_record_event
AFTER INSERT OR UPDATE ON service_requests
FOR EACH ROW EXECUTE FUNCTION record_service_request_event();

CREATE OR REPLACE FUNCTION guard_service_request_event_change() RETURNS TRIGGER AS $$
DECLARE
    current_request service_requests%ROWTYPE;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO current_request FROM active_service_requests WHERE id = NEW.request_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Service request does not exist' USING ERRCODE = '23503';
        END IF;
        IF ROW(NEW.version, NEW.to_status, NEW.actor_id, NEW.reason, NEW.occurred_at)
           IS DISTINCT FROM ROW(current_request.version, current_request.status,
               current_request.status_changed_by, current_request.status_reason, current_request.status_changed_at) THEN
            RAISE EXCEPTION 'Event must match the current request transition' USING ERRCODE = '23514';
        END IF;
        IF NEW.version > 1 AND NOT EXISTS (
            SELECT 1 FROM service_request_events
            WHERE request_id = NEW.request_id AND version = NEW.version - 1 AND to_status = NEW.from_status
        ) THEN
            RAISE EXCEPTION 'Event must continue the existing request history' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM active_service_requests WHERE id = OLD.request_id) THEN
        RETURN OLD; -- physical DELETE is blocked by the common policy
    END IF;
    RAISE EXCEPTION 'Service request events are immutable' USING ERRCODE = '23514';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER service_request_events_guard
BEFORE INSERT OR UPDATE OR DELETE ON service_request_events
FOR EACH ROW EXECUTE FUNCTION guard_service_request_event_change();

-- One reminder per request/recipient. Materializing an inbox notification and
-- delivering its push are distinct steps. Queue delivery never marks a reminder "sent".
CREATE TABLE scheduled_reminders (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id         BIGINT        NOT NULL REFERENCES service_requests(id),
    recipient_user_id  BIGINT        NOT NULL REFERENCES users(id),
    trigger_at         TIMESTAMPTZ NOT NULL,        -- scheduled_at - recipient's reminder_lead_minutes
    lead_minutes       SMALLINT NOT NULL CHECK (lead_minutes IN (5, 15, 30, 60, 120, 1440)),
    notification_id    BIGINT UNIQUE, -- FK added after notifications is defined
    cancelled_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (notification_id IS NULL OR cancelled_at IS NULL),
    UNIQUE (request_id, recipient_user_id)
);
CREATE VIEW active_scheduled_reminders AS SELECT * FROM scheduled_reminders WHERE deleted_at IS NULL;
CREATE INDEX scheduled_reminders_due_idx ON scheduled_reminders(trigger_at)
    WHERE notification_id IS NULL AND cancelled_at IS NULL;
CREATE INDEX scheduled_reminders_recipient_idx ON scheduled_reminders(recipient_user_id);

-- ---------------------------------------------------------------- reviews
-- A completed request proves eligibility. A user still has only one review per
-- worker, and may edit that review without changing its originating request.
CREATE TABLE reviews (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id   BIGINT         NOT NULL REFERENCES worker_profiles(id),
    user_id     BIGINT         NOT NULL REFERENCES users(id)  ,
    request_id  BIGINT NOT NULL,
    rating      SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT review_request_participants_fk FOREIGN KEY (request_id, worker_id, user_id)
        REFERENCES service_requests(id, worker_id, customer_id)
);
CREATE VIEW active_reviews AS SELECT * FROM reviews WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX reviews_live_unique ON reviews(worker_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX reviews_worker_idx ON reviews(worker_id, created_at DESC, id DESC);
CREATE INDEX reviews_user_idx ON reviews(user_id, created_at DESC, id DESC);
CREATE INDEX reviews_request_idx ON reviews(request_id);

-- Application authorization must bind user_id to the authenticated reviewer.
CREATE OR REPLACE FUNCTION guard_review_change() RETURNS TRIGGER AS $$
DECLARE
    target_id BIGINT;
    owner_id BIGINT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        UPDATE active_worker_profiles SET updated_at=now() WHERE id=OLD.worker_id;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id, NEW.worker_id, NEW.user_id, NEW.request_id, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.worker_id, OLD.user_id, OLD.request_id, OLD.created_at) THEN
            RAISE EXCEPTION 'Review identity, participants and originating request are immutable'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN target_id := OLD.worker_id;
    ELSE target_id := NEW.worker_id;
    END IF;

    -- Serialize every review writer before modifying reviews or reading aggregates.
    -- A real row update also forces stale concurrent snapshots to detect the change.
    UPDATE active_worker_profiles SET updated_at = now() WHERE id = target_id RETURNING user_id INTO owner_id;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reviewed worker profile does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.user_id = owner_id THEN
        RAISE EXCEPTION 'A worker cannot review their own profile' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reviewer is unavailable' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_service_requests
    WHERE id = NEW.request_id AND worker_id = NEW.worker_id
      AND customer_id = NEW.user_id AND status = 'COMPLETED'
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Review requires a completed request between this customer and worker'
            USING ERRCODE = '23514';
    END IF;
    NEW.comment := NULLIF(btrim(NEW.comment), '');
    IF TG_OP = 'INSERT' THEN NEW.created_at := clock_timestamp(); END IF;
    NEW.updated_at := GREATEST(clock_timestamp(), NEW.created_at);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_guard
BEFORE INSERT OR UPDATE OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION guard_review_change();

-- Keeps worker_profiles.rating (1 decimal) and rating_count in sync with reviews.
CREATE OR REPLACE FUNCTION refresh_worker_rating() RETURNS TRIGGER AS $$
DECLARE
    target_id BIGINT;
    calculated_rating NUMERIC(2,1);
    calculated_count BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN target_id := OLD.worker_id;
    ELSE target_id := NEW.worker_id;
    END IF;
    SELECT COALESCE(round(avg(rating), 1), 0), count(*)
    INTO calculated_rating, calculated_count FROM active_reviews WHERE worker_id = target_id;
    UPDATE active_worker_profiles w
       SET rating       = calculated_rating,
           rating_count = calculated_count,
           updated_at   = now()
     WHERE w.id = target_id;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_refresh_rating
AFTER INSERT OR UPDATE OF rating, deleted_at OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION refresh_worker_rating();

-- Guard against manually overriding cached aggregates on worker_profiles.
CREATE OR REPLACE FUNCTION validate_worker_rating() RETURNS TRIGGER AS $$
DECLARE
    stored_rating NUMERIC(2,1);
    stored_count BIGINT;
    calculated_rating NUMERIC(2,1);
    calculated_count BIGINT;
BEGIN
    SELECT rating, rating_count INTO stored_rating, stored_count
    FROM active_worker_profiles WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT COALESCE(round(avg(rating), 1), 0), count(*)
    INTO calculated_rating, calculated_count FROM active_reviews WHERE worker_id = NEW.id;
    IF ROW(stored_rating, stored_count) IS DISTINCT FROM ROW(calculated_rating, calculated_count) THEN
        RAISE EXCEPTION 'Worker profile % rating aggregates must match its reviews', NEW.id
            USING ERRCODE = '23514', CONSTRAINT = 'worker_rating_matches_reviews';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER worker_profiles_validate_rating
AFTER INSERT OR UPDATE OF rating, rating_count ON worker_profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_worker_rating();

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_user_id  BIGINT              NOT NULL REFERENCES users(id),
    type               notification_type NOT NULL,
    title              VARCHAR(160) NOT NULL CHECK (length(btrim(title)) > 0),
    body               VARCHAR(500) NOT NULL CHECK (length(btrim(body)) > 0),
    request_id         BIGINT REFERENCES service_requests(id),
    conversation_id    BIGINT REFERENCES conversations(id),
    worker_id          BIGINT REFERENCES worker_profiles(id),
    reminder_id        BIGINT UNIQUE REFERENCES scheduled_reminders(id),
    read_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notification_target CHECK (
        (type IN ('SERVICE_REQUEST_RECEIVED', 'SERVICE_REQUEST_SENT', 'SERVICE_REQUEST_UPDATED', 'APPOINTMENT_REMINDER')
            AND request_id IS NOT NULL AND conversation_id IS NULL AND worker_id IS NULL)
        OR (type = 'NEW_MESSAGE' AND conversation_id IS NOT NULL AND request_id IS NULL AND worker_id IS NULL)
        OR (type IN ('NEW_REVIEW', 'VERIFICATION_UPDATE') AND worker_id IS NOT NULL AND request_id IS NULL AND conversation_id IS NULL)
    ),
    CHECK ((type = 'APPOINTMENT_REMINDER') = (reminder_id IS NOT NULL)),
    CHECK (read_at IS NULL OR read_at >= created_at),
    UNIQUE (id, recipient_user_id)
);
CREATE VIEW active_notifications AS SELECT * FROM notifications WHERE deleted_at IS NULL;
CREATE INDEX notifications_recipient_idx ON notifications(recipient_user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications(recipient_user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_request_idx ON notifications(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX notifications_conversation_idx ON notifications(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX notifications_worker_idx ON notifications(worker_id) WHERE worker_id IS NOT NULL;

ALTER TABLE scheduled_reminders ADD CONSTRAINT reminder_notification_fk
    FOREIGN KEY (notification_id) REFERENCES notifications(id)
    DEFERRABLE INITIALLY DEFERRED;

-- Durable per-device delivery rows are inserted with the inbox notification.
-- A sender must recheck current device ownership/token and notification preferences
-- before every attempt. Claim with FOR UPDATE SKIP LOCKED and a finite lease;
-- increment claim_version and use it to fence updates from expired workers.
-- Retry transient failures with backoff; expired PROCESSING leases are reclaimable.
-- SENT means provider acceptance, not proof that the recipient opened the push.
CREATE TABLE notification_deliveries (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notification_id    BIGINT NOT NULL,
    recipient_user_id  BIGINT NOT NULL,
    device_id          BIGINT REFERENCES devices(id),
    device_token       TEXT NOT NULL CHECK (length(btrim(device_token)) > 0), -- delivery snapshot
    status             push_delivery_status NOT NULL DEFAULT 'PENDING',
    attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts       SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
    next_attempt_at    TIMESTAMPTZ DEFAULT now(),
    last_attempt_at    TIMESTAMPTZ,
    lease_expires_at   TIMESTAMPTZ,
    claim_version      BIGINT NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
    sent_at            TIMESTAMPTZ,
    provider_message_id TEXT,
    last_error_code    VARCHAR(120), -- no raw provider payloads or document/contact data
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (notification_id, recipient_user_id)
        REFERENCES notifications(id, recipient_user_id),
    UNIQUE (notification_id, device_token),
    CHECK (attempts <= max_attempts),
    CHECK (claim_version = attempts),
    CHECK ((attempts = 0 AND last_attempt_at IS NULL) OR (attempts > 0 AND last_attempt_at IS NOT NULL)),
    CHECK ((status = 'PENDING' AND next_attempt_at IS NOT NULL AND lease_expires_at IS NULL AND sent_at IS NULL AND attempts < max_attempts)
        OR (status = 'PROCESSING' AND next_attempt_at IS NULL AND lease_expires_at IS NOT NULL
            AND last_attempt_at IS NOT NULL AND lease_expires_at > last_attempt_at AND attempts > 0 AND claim_version > 0 AND sent_at IS NULL)
        OR (status = 'SENT' AND next_attempt_at IS NULL AND lease_expires_at IS NULL AND sent_at IS NOT NULL AND attempts > 0)
        OR (status IN ('FAILED', 'CANCELLED') AND next_attempt_at IS NULL AND lease_expires_at IS NULL AND sent_at IS NULL)),
    CHECK (sent_at IS NULL OR sent_at >= last_attempt_at),
    CHECK (provider_message_id IS NULL OR status = 'SENT')
);
CREATE VIEW active_notification_deliveries AS SELECT * FROM notification_deliveries WHERE deleted_at IS NULL;
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries(next_attempt_at, id) WHERE status = 'PENDING';
CREATE INDEX notification_deliveries_lease_idx ON notification_deliveries(lease_expires_at, id) WHERE status = 'PROCESSING';
CREATE INDEX notification_deliveries_device_idx ON notification_deliveries(device_id);
CREATE INDEX notification_deliveries_recipient_idx ON notification_deliveries(recipient_user_id);

CREATE OR REPLACE FUNCTION guard_scheduled_reminder_change() RETURNS TRIGGER AS $$
DECLARE
    request_row service_requests%ROWTYPE;
    linked_notification notifications%ROWTYPE;
    notifications_enabled BOOLEAN;
    configured_lead SMALLINT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    SELECT * INTO request_row FROM active_service_requests WHERE id = NEW.request_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reminder request does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.recipient_user_id NOT IN (request_row.customer_id, request_row.worker_user_id) THEN
        RAISE EXCEPTION 'Reminder recipient must be a request participant' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.request_id, NEW.recipient_user_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.request_id, OLD.recipient_user_id, OLD.created_at) THEN
        RAISE EXCEPTION 'Reminder identity and recipient are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.notification_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'A materialized reminder cannot be changed' USING ERRCODE = '23514';
    END IF;
    IF NEW.cancelled_at IS NULL AND NEW.notification_id IS NULL THEN
        PERFORM 1 FROM active_users WHERE id = NEW.recipient_user_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Active reminders require an active recipient account' USING ERRCODE = '23514';
        END IF;
        IF request_row.status <> 'ACCEPTED' OR request_row.scheduled_at IS NULL THEN
            RAISE EXCEPTION 'Active reminders require an accepted scheduled request' USING ERRCODE = '23514';
        END IF;
        SELECT s.notifications_enabled, s.reminder_lead_minutes INTO notifications_enabled, configured_lead
        FROM active_user_settings s WHERE s.user_id = NEW.recipient_user_id;
        IF COALESCE(notifications_enabled, TRUE) = FALSE OR COALESCE(configured_lead, 60) = 0 THEN
            RAISE EXCEPTION 'Recipient has disabled appointment reminders' USING ERRCODE = '23514';
        END IF;
        NEW.lead_minutes := COALESCE(configured_lead, 60);
        NEW.trigger_at := request_row.scheduled_at - make_interval(mins => NEW.lead_minutes);
    END IF;
    IF NEW.notification_id IS NOT NULL THEN
        SELECT * INTO linked_notification FROM active_notifications WHERE id = NEW.notification_id;
        IF NOT FOUND OR linked_notification.reminder_id IS DISTINCT FROM NEW.id
           OR linked_notification.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
           OR linked_notification.request_id IS DISTINCT FROM NEW.request_id THEN
            RAISE EXCEPTION 'Reminder must link to its own recipient notification' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_reminders_guard
BEFORE INSERT OR UPDATE ON scheduled_reminders
FOR EACH ROW EXECUTE FUNCTION guard_scheduled_reminder_change();

CREATE OR REPLACE FUNCTION guard_notification_change() RETURNS TRIGGER AS $$
DECLARE
    request_row service_requests%ROWTYPE;
    conversation_row conversations%ROWTYPE;
    reminder_row scheduled_reminders%ROWTYPE;
    owner_id BIGINT;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id, NEW.recipient_user_id, NEW.type, NEW.title, NEW.body, NEW.request_id,
               NEW.conversation_id, NEW.worker_id, NEW.reminder_id, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.recipient_user_id, OLD.type, OLD.title, OLD.body, OLD.request_id,
               OLD.conversation_id, OLD.worker_id, OLD.reminder_id, OLD.created_at) THEN
            RAISE EXCEPTION 'Notification content and recipient are immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
            RAISE EXCEPTION 'Notification read timestamp is immutable once set' USING ERRCODE = '23514';
        END IF;
        IF OLD.read_at IS NULL AND NEW.read_at IS NOT NULL THEN
            NEW.read_at := GREATEST(clock_timestamp(), OLD.created_at);
        END IF;
        RETURN NEW;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.read_at := NULL;
    IF NEW.request_id IS NOT NULL THEN
        SELECT * INTO request_row FROM active_service_requests WHERE id = NEW.request_id FOR SHARE;
        IF NOT FOUND OR NEW.recipient_user_id NOT IN (request_row.customer_id, request_row.worker_user_id) THEN
            RAISE EXCEPTION 'Notification recipient must be a request participant' USING ERRCODE = '23514';
        END IF;
        IF (NEW.type = 'SERVICE_REQUEST_RECEIVED' AND NEW.recipient_user_id <> request_row.worker_user_id)
           OR (NEW.type = 'SERVICE_REQUEST_SENT' AND NEW.recipient_user_id <> request_row.customer_id) THEN
            RAISE EXCEPTION 'Request notification has the wrong recipient' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.conversation_id IS NOT NULL THEN
        SELECT * INTO conversation_row FROM active_conversations WHERE id = NEW.conversation_id FOR SHARE;
        IF NOT FOUND OR NEW.recipient_user_id NOT IN (conversation_row.customer_id, conversation_row.worker_user_id) THEN
            RAISE EXCEPTION 'Notification recipient must be a conversation participant' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.worker_id IS NOT NULL THEN
        SELECT user_id INTO owner_id FROM active_worker_profiles WHERE id = NEW.worker_id FOR SHARE;
        IF NOT FOUND OR NEW.recipient_user_id IS DISTINCT FROM owner_id THEN
            RAISE EXCEPTION 'Review and verification notifications belong to the worker owner' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.reminder_id IS NOT NULL THEN
        PERFORM 1 FROM active_users WHERE id = NEW.recipient_user_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Reminder recipient account is inactive' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM active_user_settings WHERE user_id = NEW.recipient_user_id
                   AND (NOT notifications_enabled OR reminder_lead_minutes = 0)) THEN
            RAISE EXCEPTION 'Recipient has disabled appointment reminders' USING ERRCODE = '23514';
        END IF;
        SELECT * INTO reminder_row FROM active_scheduled_reminders WHERE id = NEW.reminder_id FOR UPDATE;
        IF NOT FOUND OR reminder_row.request_id IS DISTINCT FROM NEW.request_id
           OR reminder_row.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
           OR reminder_row.cancelled_at IS NOT NULL OR reminder_row.notification_id IS NOT NULL
           OR reminder_row.trigger_at > clock_timestamp()
           OR request_row.status <> 'ACCEPTED' OR request_row.scheduled_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'Reminder is not due or no longer eligible' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_guard
BEFORE INSERT OR UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION guard_notification_change();

CREATE OR REPLACE FUNCTION enqueue_notification_delivery() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reminder_id IS NOT NULL THEN
        UPDATE active_scheduled_reminders SET notification_id = NEW.id WHERE id = NEW.reminder_id;
    END IF;
    INSERT INTO notification_deliveries(notification_id, recipient_user_id, device_id, device_token)
    SELECT NEW.id, NEW.recipient_user_id, d.id, d.fcm_token
    FROM active_devices d JOIN active_users u ON u.id = d.user_id
    LEFT JOIN active_user_settings s ON s.user_id = d.user_id
    WHERE d.user_id = NEW.recipient_user_id AND u.account_status = 'ACTIVE'
      AND COALESCE(s.notifications_enabled, TRUE);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_enqueue_delivery
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION enqueue_notification_delivery();

CREATE OR REPLACE FUNCTION sync_request_reminders() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'ACCEPTED' AND NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > clock_timestamp() THEN
        INSERT INTO scheduled_reminders(request_id, recipient_user_id, lead_minutes, trigger_at)
        SELECT NEW.id, p.user_id, COALESCE(s.reminder_lead_minutes, 60),
               NEW.scheduled_at - make_interval(mins => COALESCE(s.reminder_lead_minutes, 60))
        FROM (VALUES (NEW.customer_id), (NEW.worker_user_id)) AS p(user_id)
        JOIN active_users u ON u.id = p.user_id AND u.account_status = 'ACTIVE'
        LEFT JOIN active_user_settings s ON s.user_id = p.user_id
        WHERE COALESCE(s.notifications_enabled, TRUE) AND COALESCE(s.reminder_lead_minutes, 60) > 0
        ON CONFLICT (request_id, recipient_user_id) DO NOTHING;
    ELSE
        UPDATE active_scheduled_reminders SET cancelled_at = clock_timestamp()
        WHERE request_id = NEW.id AND notification_id IS NULL AND cancelled_at IS NULL;
        UPDATE active_notification_deliveries d SET status = 'CANCELLED', next_attempt_at = NULL, lease_expires_at = NULL
        FROM active_notifications n WHERE n.id = d.notification_id AND n.request_id = NEW.id
            AND n.type = 'APPOINTMENT_REMINDER' AND d.status IN ('PENDING', 'PROCESSING');
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER service_requests_sync_reminders
AFTER UPDATE OF status ON service_requests
FOR EACH ROW EXECUTE FUNCTION sync_request_reminders();

CREATE OR REPLACE FUNCTION sync_settings_reminders() RETURNS TRIGGER AS $$
BEGIN
    IF NOT NEW.notifications_enabled OR NEW.reminder_lead_minutes = 0 THEN
        UPDATE active_scheduled_reminders SET cancelled_at = clock_timestamp()
        WHERE recipient_user_id = NEW.user_id AND notification_id IS NULL AND cancelled_at IS NULL;
    ELSE
        INSERT INTO scheduled_reminders(request_id, recipient_user_id, lead_minutes, trigger_at)
        SELECT r.id, NEW.user_id, NEW.reminder_lead_minutes,
               r.scheduled_at - make_interval(mins => NEW.reminder_lead_minutes)
        FROM active_service_requests r
        WHERE (r.customer_id = NEW.user_id OR r.worker_user_id = NEW.user_id)
          AND r.status = 'ACCEPTED' AND r.scheduled_at > clock_timestamp()
        ON CONFLICT (request_id, recipient_user_id) DO UPDATE
            SET lead_minutes = EXCLUDED.lead_minutes, trigger_at = EXCLUDED.trigger_at, cancelled_at = NULL
            WHERE scheduled_reminders.notification_id IS NULL;
    END IF;
    IF NOT NEW.notifications_enabled OR NEW.reminder_lead_minutes = 0 THEN
        UPDATE active_notification_deliveries d SET status = 'CANCELLED', next_attempt_at = NULL, lease_expires_at = NULL
        FROM active_notifications n WHERE n.id = d.notification_id AND d.recipient_user_id = NEW.user_id
          AND d.status IN ('PENDING', 'PROCESSING')
          AND (NOT NEW.notifications_enabled OR n.type = 'APPOINTMENT_REMINDER');
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER user_settings_sync_reminders
AFTER INSERT OR UPDATE OF notifications_enabled, reminder_lead_minutes ON user_settings
FOR EACH ROW EXECUTE FUNCTION sync_settings_reminders();

CREATE OR REPLACE FUNCTION guard_notification_delivery_identity() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM active_devices WHERE id = NEW.device_id
            AND user_id = NEW.recipient_user_id AND fcm_token = NEW.device_token FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Delivery device must belong to the notification recipient' USING ERRCODE = '23514';
        END IF;
        IF NEW.status <> 'PENDING' OR NEW.attempts <> 0 OR NEW.claim_version <> 0 THEN
            RAISE EXCEPTION 'Delivery must start pending and unattempted' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF ROW(NEW.id, NEW.notification_id, NEW.recipient_user_id, NEW.device_token, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.notification_id, OLD.recipient_user_id, OLD.device_token, OLD.created_at) THEN
            RAISE EXCEPTION 'Delivery identity and target are immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.device_id IS DISTINCT FROM OLD.device_id THEN
            IF NEW.device_id IS NOT NULL OR EXISTS (SELECT 1 FROM active_devices WHERE id = OLD.device_id) THEN
                RAISE EXCEPTION 'Delivery device can only be cleared when the device is deleted' USING ERRCODE = '23514';
            END IF;
            IF NEW.status IN ('PENDING', 'PROCESSING') THEN
                NEW.status := 'CANCELLED';
                NEW.next_attempt_at := NULL;
                NEW.lease_expires_at := NULL;
            END IF;
        END IF;
        IF NEW.attempts < OLD.attempts OR NEW.claim_version < OLD.claim_version THEN
            RAISE EXCEPTION 'Delivery attempt and claim counters cannot decrease' USING ERRCODE = '23514';
        END IF;
        IF OLD.status IN ('SENT', 'FAILED', 'CANCELLED')
           AND ROW(NEW.status, NEW.attempts, NEW.claim_version, NEW.sent_at, NEW.provider_message_id)
               IS DISTINCT FROM ROW(OLD.status, OLD.attempts, OLD.claim_version, OLD.sent_at, OLD.provider_message_id) THEN
            RAISE EXCEPTION 'Terminal delivery outcome is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'PROCESSING' THEN
            IF OLD.status NOT IN ('PENDING', 'PROCESSING')
               OR (OLD.status = 'PROCESSING' AND OLD.lease_expires_at > clock_timestamp())
               OR NEW.attempts <> OLD.attempts + 1 OR NEW.claim_version <> OLD.claim_version + 1 THEN
                RAISE EXCEPTION 'Delivery claim requires a pending job or expired lease and incremented counters'
                    USING ERRCODE = '23514';
            END IF;
            NEW.last_attempt_at := clock_timestamp();
        ELSIF NEW.attempts <> OLD.attempts OR NEW.claim_version <> OLD.claim_version THEN
            RAISE EXCEPTION 'Delivery counters change only when claiming an attempt' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'SENT' AND OLD.status <> 'SENT' THEN
            IF OLD.status <> 'PROCESSING' THEN
                RAISE EXCEPTION 'Only a claimed delivery can be marked sent' USING ERRCODE = '23514';
            END IF;
            NEW.sent_at := GREATEST(clock_timestamp(), NEW.last_attempt_at);
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER notification_deliveries_guard
BEFORE INSERT OR UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery_identity();

-- ---------------------------------------------------------------- contact history
-- Calls/WhatsApp are reported attempts, not proof that a call or exchange occurred.
-- Chat/request rows are generated automatically from their source records.
CREATE TABLE contact_history (
    deleted_at TIMESTAMPTZ, -- logical tombstone; rows are retained
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id       BIGINT             NOT NULL REFERENCES users(id)  ,
    worker_id         BIGINT             NOT NULL REFERENCES worker_profiles(id),
    interaction_type  interaction_type NOT NULL,
    conversation_id   BIGINT UNIQUE,
    request_id        BIGINT UNIQUE,
    created_at        TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT history_conversation_participants_fk FOREIGN KEY (conversation_id, worker_id, customer_id)
        REFERENCES conversations(id, worker_id, customer_id),
    CONSTRAINT history_request_participants_fk FOREIGN KEY (request_id, worker_id, customer_id)
        REFERENCES service_requests(id, worker_id, customer_id),
    CONSTRAINT history_interaction_target CHECK (
        (interaction_type = 'CHAT' AND conversation_id IS NOT NULL AND request_id IS NULL)
        OR (interaction_type = 'SERVICE_REQUEST' AND request_id IS NOT NULL AND conversation_id IS NULL)
        OR (interaction_type IN ('CALL', 'WHATSAPP') AND request_id IS NULL AND conversation_id IS NULL)
    )
);
CREATE VIEW active_contact_history AS SELECT * FROM contact_history WHERE deleted_at IS NULL;
CREATE INDEX contact_history_customer_idx ON contact_history(customer_id, created_at DESC, id DESC);
CREATE INDEX contact_history_worker_idx ON contact_history(worker_id);

CREATE OR REPLACE FUNCTION guard_contact_history_change() RETURNS TRIGGER AS $$
DECLARE
    owner_id BIGINT;
    source_created_at TIMESTAMPTZ;
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Contact history entries are immutable' USING ERRCODE = '23514';
    END IF;
    SELECT w.user_id INTO owner_id FROM active_worker_profiles w JOIN active_users u ON u.id = w.user_id
    WHERE w.id = NEW.worker_id AND u.account_status = 'ACTIVE' AND w.is_listed
      AND EXISTS (SELECT 1 FROM worker_verification v WHERE v.worker_id = w.id AND v.verification_status = 'VERIFIED') FOR SHARE OF w, u;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contacted worker is unavailable' USING ERRCODE = '23514';
    END IF;
    IF NEW.customer_id = owner_id THEN
        RAISE EXCEPTION 'A user cannot contact their own worker profile' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.customer_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contact history user is unavailable' USING ERRCODE = '23514';
    END IF;

    IF NEW.interaction_type = 'CHAT' THEN
        SELECT created_at INTO source_created_at FROM active_conversations
        WHERE id = NEW.conversation_id AND customer_id = NEW.customer_id AND worker_id = NEW.worker_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Chat history must match its conversation participants' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := source_created_at;
    ELSIF NEW.interaction_type = 'SERVICE_REQUEST' THEN
        SELECT created_at INTO source_created_at FROM active_service_requests
        WHERE id = NEW.request_id AND customer_id = NEW.customer_id AND worker_id = NEW.worker_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Request history must match its request participants' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := source_created_at;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM public_worker_profiles WHERE id = NEW.worker_id) THEN
            RAISE EXCEPTION 'Call and WhatsApp history require a verified worker' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := clock_timestamp();
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER contact_history_guard
BEFORE INSERT OR UPDATE ON contact_history
FOR EACH ROW EXECUTE FUNCTION guard_contact_history_change();

CREATE OR REPLACE FUNCTION record_contact_history() RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'conversations' THEN
        INSERT INTO contact_history(customer_id, worker_id, interaction_type, conversation_id)
        VALUES (NEW.customer_id, NEW.worker_id, 'CHAT', NEW.id);
    ELSE
        INSERT INTO contact_history(customer_id, worker_id, interaction_type, request_id)
        VALUES (NEW.customer_id, NEW.worker_id, 'SERVICE_REQUEST', NEW.id);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_record_contact
AFTER INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION record_contact_history();

CREATE TRIGGER service_requests_record_contact
AFTER INSERT ON service_requests
FOR EACH ROW EXECUTE FUNCTION record_contact_history();

-- A worker profile belongs permanently to its account. Transferring ownership
-- would invalidate historical participant and self-interaction checks.
CREATE OR REPLACE FUNCTION guard_worker_profile_identity() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF ROW(NEW.id, NEW.user_id, NEW.joined_at) IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.joined_at) THEN
        RAISE EXCEPTION 'Worker profile identity and ownership are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_profiles_identity_guard
BEFORE UPDATE ON worker_profiles
FOR EACH ROW EXECUTE FUNCTION guard_worker_profile_identity();

-- ---------------------------------------------------------------- account operational state
CREATE OR REPLACE FUNCTION sync_account_operational_state() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.account_status = OLD.account_status THEN RETURN NULL; END IF;
    IF NEW.account_status <> 'ACTIVE' THEN
        -- Device tombstones also tombstone their queued deliveries.
        UPDATE active_devices SET deleted_at=clock_timestamp() WHERE user_id = NEW.id;
        UPDATE active_scheduled_reminders SET cancelled_at = clock_timestamp()
        WHERE recipient_user_id = NEW.id AND notification_id IS NULL AND cancelled_at IS NULL;
        UPDATE active_notification_deliveries SET status = 'CANCELLED', next_attempt_at = NULL, lease_expires_at = NULL
        WHERE recipient_user_id = NEW.id AND status IN ('PENDING', 'PROCESSING');
        UPDATE active_worker_profiles SET is_available = FALSE,
            is_listed = CASE WHEN NEW.account_status = 'DELETED' THEN FALSE ELSE is_listed END
        WHERE user_id = NEW.id;
    ELSE
        -- Reactivation does not restore revoked sessions, devices, cancelled pushes
        -- or administrator access. Rebuild only eligible future reminders.
        INSERT INTO user_settings(user_id) VALUES (NEW.id)
        ON CONFLICT (user_id) DO UPDATE SET notifications_enabled = user_settings.notifications_enabled;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_sync_account_state
AFTER UPDATE OF account_status ON users
FOR EACH ROW EXECUTE FUNCTION sync_account_operational_state();

CREATE OR REPLACE FUNCTION guard_device_owner() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'Device identity is immutable' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device owner must be active' USING ERRCODE = '23514'; END IF;
    IF length(btrim(NEW.fcm_token)) = 0 THEN RAISE EXCEPTION 'Device token cannot be blank' USING ERRCODE = '23514'; END IF;
    NEW.last_seen_at := clock_timestamp();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER devices_owner_guard BEFORE INSERT OR UPDATE ON devices
FOR EACH ROW EXECUTE FUNCTION guard_device_owner();

CREATE OR REPLACE FUNCTION cancel_stale_device_deliveries() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.user_id, NEW.fcm_token) IS DISTINCT FROM ROW(OLD.user_id, OLD.fcm_token) THEN
        UPDATE active_notification_deliveries SET status = 'CANCELLED', next_attempt_at = NULL, lease_expires_at = NULL
        WHERE device_id = NEW.id AND status IN ('PENDING', 'PROCESSING');
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER devices_cancel_stale_deliveries AFTER UPDATE OF user_id, fcm_token ON devices
FOR EACH ROW EXECUTE FUNCTION cancel_stale_device_deliveries();

CREATE OR REPLACE FUNCTION guard_settings_owner() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'Settings owner is immutable' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM active_users WHERE id = NEW.user_id AND account_status = 'ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Settings owner must be active' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER user_settings_owner_guard BEFORE INSERT OR UPDATE ON user_settings
FOR EACH ROW EXECUTE FUNCTION guard_settings_owner();

-- ---------------------------------------------------------------- upload lifecycle and attachment integrity
CREATE OR REPLACE FUNCTION guard_file_upload_change() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DELETED' THEN
            RAISE EXCEPTION 'Delete the storage object before deleting upload metadata' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM active_users WHERE id = NEW.owner_user_id AND account_status = 'ACTIVE' FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Upload owner is unavailable' USING ERRCODE = '23514'; END IF;
        IF NEW.status <> 'PENDING' OR NEW.uploaded_at IS NOT NULL
           OR NEW.delete_requested_at IS NOT NULL OR NEW.storage_deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'Uploads must start pending and unattached' USING ERRCODE = '23514';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.upload_expires_at := NEW.created_at + interval '1 hour';
        NEW.cleanup_after := NEW.created_at + interval '24 hours';
    ELSE
        IF ROW(NEW.id, NEW.owner_user_id, NEW.purpose, NEW.bucket_name, NEW.object_key, NEW.created_at, NEW.upload_expires_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.owner_user_id, OLD.purpose, OLD.bucket_name, OLD.object_key, OLD.created_at, OLD.upload_expires_at) THEN
            RAISE EXCEPTION 'Upload identity, ownership and storage location are immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'DELETED' THEN
            IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Deleted upload records are immutable' USING ERRCODE = '23514'; END IF;
            RETURN OLD;
        END IF;
        IF OLD.uploaded_at IS NOT NULL AND ROW(NEW.uploaded_at, NEW.content_type, NEW.size_bytes, NEW.sha256)
           IS DISTINCT FROM ROW(OLD.uploaded_at, OLD.content_type, OLD.size_bytes, OLD.sha256) THEN
            RAISE EXCEPTION 'Ready file content is immutable; upload a new object' USING ERRCODE = '23514';
        END IF;
        IF NEW.status <> OLD.status AND NOT (
            (OLD.status = 'PENDING' AND NEW.status IN ('READY', 'FAILED', 'DELETING'))
            OR (OLD.status IN ('READY', 'FAILED') AND NEW.status = 'DELETING')
            OR (OLD.status = 'DELETING' AND NEW.status = 'DELETED')
        ) THEN
            RAISE EXCEPTION 'Invalid upload lifecycle transition' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'READY' AND OLD.status = 'PENDING' THEN
            PERFORM 1 FROM active_users WHERE id = NEW.owner_user_id AND account_status = 'ACTIVE' FOR SHARE;
            IF NOT FOUND THEN RAISE EXCEPTION 'Upload owner is unavailable' USING ERRCODE = '23514'; END IF;
            IF clock_timestamp() >= OLD.upload_expires_at THEN
                RAISE EXCEPTION 'Upload completion window has expired' USING ERRCODE = '23514';
            END IF;
            NEW.uploaded_at := clock_timestamp();
        ELSIF OLD.uploaded_at IS NULL AND NEW.uploaded_at IS NOT NULL THEN
            RAISE EXCEPTION 'Only ready uploads may acquire content metadata' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'DELETING' AND OLD.status <> 'DELETING' THEN
            IF OLD.status = 'PENDING' AND clock_timestamp() < OLD.upload_expires_at THEN
                RAISE EXCEPTION 'Wait for upload authorization expiry before deleting an unfinished object'
                    USING ERRCODE = '23514';
            END IF;
            NEW.delete_requested_at := GREATEST(clock_timestamp(), NEW.created_at);
        ELSIF NEW.delete_requested_at IS DISTINCT FROM OLD.delete_requested_at THEN
            RAISE EXCEPTION 'Upload deletion request timestamp is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.status = 'DELETED' THEN NEW.storage_deleted_at := GREATEST(clock_timestamp(), NEW.delete_requested_at); END IF;
    END IF;
    NEW.updated_at := GREATEST(clock_timestamp(), NEW.created_at);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER file_uploads_guard
BEFORE INSERT OR UPDATE OR DELETE ON file_uploads
FOR EACH ROW EXECUTE FUNCTION guard_file_upload_change();

CREATE OR REPLACE FUNCTION guard_user_profile_image() RETURNS TRIGGER AS $$
BEGIN
    -- Tombstone-only edits are checked by the common resource guard.
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF NEW.profile_image_upload_id IS NOT NULL THEN
        PERFORM 1 FROM active_file_uploads WHERE id = NEW.profile_image_upload_id AND owner_user_id = NEW.id
            AND purpose = 'PROFILE_IMAGE' AND status = 'READY' FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Profile image must be a ready image upload owned by the account' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_profile_image_guard
BEFORE INSERT OR UPDATE OF profile_image_upload_id ON users
FOR EACH ROW EXECUTE FUNCTION guard_user_profile_image();

CREATE OR REPLACE FUNCTION refresh_upload_attachment(p_upload_id BIGINT) RETURNS VOID AS $$
BEGIN
    IF p_upload_id IS NULL THEN RETURN; END IF;
    UPDATE active_file_uploads f SET cleanup_after = CASE
        WHEN EXISTS (SELECT 1 FROM active_users WHERE profile_image_upload_id = f.id)
          OR EXISTS (SELECT 1 FROM active_identity_documents WHERE upload_id = f.id) THEN NULL
        ELSE COALESCE(f.cleanup_after, clock_timestamp() + interval '24 hours') END
    WHERE f.id = p_upload_id AND f.deleted_at IS NULL AND f.status <> 'DELETED';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_upload_attachment() RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'users' THEN
        IF TG_OP <> 'INSERT' THEN PERFORM refresh_upload_attachment(OLD.profile_image_upload_id); END IF;
        IF TG_OP <> 'DELETE' THEN PERFORM refresh_upload_attachment(NEW.profile_image_upload_id); END IF;
    ELSE
        IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM refresh_upload_attachment(OLD.upload_id);
        ELSE PERFORM refresh_upload_attachment(NEW.upload_id);
        END IF;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_sync_upload_attachment
AFTER INSERT OR UPDATE OF profile_image_upload_id OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION sync_upload_attachment();

CREATE TRIGGER identity_documents_sync_upload_attachment
AFTER INSERT OR UPDATE OF deleted_at OR DELETE ON identity_documents
FOR EACH ROW EXECUTE FUNCTION sync_upload_attachment();

-- Deferred checks permit detach-and-delete in one transaction, but never permit
-- a committed reference to a pending, failed, deleting or deleted object.
-- Cleanup workers must lock uploads, recheck attachments and commit DELETING
-- before deleting external objects; confirm deletion before marking DELETED.
CREATE OR REPLACE FUNCTION validate_upload_attachment() RETURNS TRIGGER AS $$
DECLARE
    upload_row file_uploads%ROWTYPE;
    is_attached BOOLEAN;
BEGIN
    SELECT * INTO upload_row FROM file_uploads WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT EXISTS (SELECT 1 FROM active_users WHERE profile_image_upload_id = NEW.id)
        OR EXISTS (SELECT 1 FROM active_identity_documents WHERE upload_id = NEW.id) INTO is_attached;
    IF is_attached AND (upload_row.deleted_at IS NOT NULL OR upload_row.status <> 'READY' OR upload_row.cleanup_after IS NOT NULL) THEN
        RAISE EXCEPTION 'Attached uploads must remain ready and excluded from orphan cleanup'
            USING ERRCODE = '23514';
    END IF;
    IF NOT is_attached AND upload_row.deleted_at IS NULL AND upload_row.status IN ('PENDING', 'READY', 'FAILED') AND upload_row.cleanup_after IS NULL THEN
        RAISE EXCEPTION 'Unattached uploads must have an orphan cleanup deadline' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER file_uploads_validate_attachment
AFTER INSERT OR UPDATE ON file_uploads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_upload_attachment();

-- ---------------------------------------------------------------- updated_at helper
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch            BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER worker_profiles_touch          BEFORE UPDATE ON worker_profiles          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER worker_services_touch BEFORE UPDATE ON worker_services FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER worker_working_hours_touch BEFORE UPDATE ON worker_working_hours FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER worker_discounts_touch BEFORE UPDATE ON worker_discounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER notification_deliveries_touch BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER user_settings_touch BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------- common retained-resource policy
-- DELETE/TRUNCATE are rejected. Soft-delete with UPDATE ... SET deleted_at=clock_timestamp().
-- Restore supported domain resources with SET deleted_at=NULL in a separate statement;
-- root accounts and security/delivery records are never restored. Tombstones reserve
-- entity identity. Composite-key relationships (favorites/translations) are restored
-- rather than reinserted. Retained historical FKs are intentionally not physical cascades.
CREATE OR REPLACE FUNCTION guard_resource_tombstone() RETURNS TRIGGER AS $$
DECLARE ignored_columns TEXT[]; primary_column RECORD;
BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'Physical deletion of % is disabled; use deleted_at', TG_TABLE_NAME USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'New resources must be live' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END IF;
    FOR primary_column IN SELECT a.attname FROM pg_index i JOIN pg_attribute a
        ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=TG_RELID AND i.indisprimary
    LOOP
        IF to_jsonb(NEW)->primary_column.attname IS DISTINCT FROM to_jsonb(OLD)->primary_column.attname THEN
            RAISE EXCEPTION 'Resource primary keys are immutable' USING ERRCODE='23514';
        END IF;
    END LOOP;
    IF to_jsonb(NEW)->'created_at' IS DISTINCT FROM to_jsonb(OLD)->'created_at' THEN
        RAISE EXCEPTION 'Resource creation timestamps are immutable' USING ERRCODE='23514';
    END IF;
    SELECT ARRAY['deleted_at','updated_at'] || COALESCE(array_agg(attname::text),ARRAY[]::text[])
      INTO ignored_columns FROM pg_attribute WHERE attrelid=TG_RELID AND attgenerated <> '';
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        IF (to_jsonb(NEW)-ignored_columns) IS DISTINCT FROM (to_jsonb(OLD)-ignored_columns) THEN
            RAISE EXCEPTION 'Change the tombstone separately from resource data' USING ERRCODE='23514';
        END IF;
        IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'Deletion timestamp is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.deleted_at IS NOT NULL THEN NEW.deleted_at:=clock_timestamp(); END IF;
        IF OLD.deleted_at IS NOT NULL AND TG_TABLE_NAME IN
           ('users','auth_sessions','refresh_tokens','otp_flows','otp_challenges','notification_deliveries') THEN
            RAISE EXCEPTION 'Restore is not permitted for %; create a new authorized resource',TG_TABLE_NAME USING ERRCODE='23514';
        END IF;
    ELSIF OLD.deleted_at IS NOT NULL AND TG_TABLE_NAME <> 'file_uploads'
       AND (to_jsonb(NEW)-ignored_columns) IS DISTINCT FROM (to_jsonb(OLD)-ignored_columns) THEN
        RAISE EXCEPTION 'Deleted resources cannot be edited' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cascade_resource_tombstone() RETURNS TRIGGER AS $$
DECLARE edge RECORD;
BEGIN
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN RETURN NULL; END IF;
    FOR edge IN SELECT * FROM (VALUES
        ('users','worker_profiles','user_id'),
        ('users','auth_sessions','user_id'),('users','otp_flows','user_id'),
        ('users','devices','user_id'),('users','user_settings','user_id'),
        ('users','favorites','user_id'),('users','reviews','user_id'),
        ('users','contact_history','customer_id'),('users','notifications','recipient_user_id'),
        ('users','scheduled_reminders','recipient_user_id'),('users','notification_deliveries','recipient_user_id'),
        ('users','file_uploads','owner_user_id'),
        ('worker_profiles','worker_worker_types','worker_id'),
        ('worker_profiles','worker_services','worker_id'),('worker_profiles','worker_working_hours','worker_id'),
        ('worker_profiles','worker_discounts','worker_id'),('worker_profiles','identity_documents','worker_id'),
        ('worker_profiles','favorites','worker_id'),
        ('categories','category_translations','category_id'),('categories','worker_types','category_id'),
        ('worker_types','worker_type_translations','worker_type_id'),
        ('auth_sessions','refresh_tokens','session_id'),('otp_flows','otp_challenges','flow_id'),
        ('conversations','messages','conversation_id'),('conversations','notifications','conversation_id'),
        ('conversations','contact_history','conversation_id'),
        ('service_requests','service_request_events','request_id'),
        ('service_requests','scheduled_reminders','request_id'),('service_requests','notifications','request_id'),
        ('service_requests','contact_history','request_id'),('service_requests','reviews','request_id'),
        ('scheduled_reminders','notifications','reminder_id'),
        ('notifications','notification_deliveries','notification_id'),
        ('devices','notification_deliveries','device_id')
    ) AS e(parent_table,child_table,child_column) WHERE e.parent_table=TG_TABLE_NAME
    LOOP
        EXECUTE format('UPDATE %I SET deleted_at=$1 WHERE %I=$2 AND deleted_at IS NULL',edge.child_table,edge.child_column)
            USING NEW.deleted_at, (to_jsonb(NEW)->>'id')::bigint;
    END LOOP;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

-- New relationships/restores must reference live resources. Unchanged historical
-- links remain valid when the other party is later suspended/deleted.
CREATE OR REPLACE FUNCTION validate_live_resource_links() RETURNS TRIGGER AS $$
DECLARE
    fk RECORD; key RECORD; predicates TEXT; missing BOOLEAN;
    new_json JSONB; old_json JSONB; changed BOOLEAN; has_null BOOLEAN;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
    new_json:=to_jsonb(NEW);
    -- Read final row state, because deferred checks can outlive subsequent deletion.
    EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE %s',TG_TABLE_NAME,
       (SELECT string_agg(format('t.%I = ($1->>%L)::%s',a.attname,a.attname,format_type(a.atttypid,a.atttypmod)),' AND ')
        FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
        WHERE i.indrelid=TG_RELID AND i.indisprimary))
      INTO new_json USING new_json;
    IF new_json IS NULL OR new_json->>'deleted_at' IS NOT NULL THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' THEN old_json:=to_jsonb(OLD); END IF;
    FOR fk IN SELECT c.* FROM pg_constraint c WHERE c.conrelid=TG_RELID AND c.contype='f'
    LOOP
        predicates:=''; has_null:=FALSE;
        changed:=TG_OP='INSERT' OR (old_json->>'deleted_at' IS NOT NULL);
        FOR key IN SELECT ca.attname AS child_name,pa.attname AS parent_name,format_type(pa.atttypid,pa.atttypmod) AS parent_type
            FROM unnest(fk.conkey,fk.confkey) AS k(child_num,parent_num)
            JOIN pg_attribute ca ON ca.attrelid=fk.conrelid AND ca.attnum=k.child_num
            JOIN pg_attribute pa ON pa.attrelid=fk.confrelid AND pa.attnum=k.parent_num
        LOOP
            IF new_json->>key.child_name IS NULL THEN has_null:=TRUE; END IF;
            IF old_json->key.child_name IS DISTINCT FROM new_json->key.child_name THEN changed:=TRUE; END IF;
            predicates:=predicates || CASE WHEN predicates='' THEN '' ELSE ' AND ' END ||
                format('p.%I = ($1->>%L)::%s',key.parent_name,key.child_name,key.parent_type);
        END LOOP;
        IF has_null OR NOT changed THEN CONTINUE; END IF;
        EXECUTE format('SELECT NOT EXISTS(SELECT 1 FROM %s p WHERE %s AND p.deleted_at IS NULL%s)',
            fk.confrelid::regclass,predicates,
            CASE WHEN fk.confrelid='users'::regclass THEN ' AND p.account_status=''ACTIVE''' ELSE '' END)
        INTO missing USING new_json;
        IF missing THEN RAISE EXCEPTION 'New/restored % relationship references an unavailable resource (%)',TG_TABLE_NAME,fk.conname USING ERRCODE='23514'; END IF;
    END LOOP;
    IF TG_OP='UPDATE' AND old_json->>'deleted_at' IS NOT NULL THEN
        IF TG_TABLE_NAME='favorites' AND NOT EXISTS
           (SELECT 1 FROM public_worker_profiles WHERE id=(new_json->>'worker_id')::bigint) THEN
            RAISE EXCEPTION 'Restore favorite only for a public worker' USING ERRCODE='23514';
        ELSIF TG_TABLE_NAME='reviews' AND NOT EXISTS
           (SELECT 1 FROM active_service_requests WHERE id=(new_json->>'request_id')::bigint AND status='COMPLETED') THEN
            RAISE EXCEPTION 'Restore review only for a completed request' USING ERRCODE='23514';
        ELSIF TG_TABLE_NAME='file_uploads' AND new_json->>'status' IN ('DELETING','DELETED') THEN
            RAISE EXCEPTION 'A storage deletion cannot be undone by restoring metadata' USING ERRCODE='23514';
        ELSIF TG_TABLE_NAME='identity_documents' AND NOT EXISTS
           (SELECT 1 FROM active_file_uploads WHERE id=(new_json->>'upload_id')::bigint AND status='READY' AND purpose='IDENTITY_DOCUMENT') THEN
            RAISE EXCEPTION 'Restored identity document requires its ready private upload' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (
      'users','file_uploads','otp_flows','otp_challenges','auth_sessions','refresh_tokens','devices','user_settings',
      'categories','worker_types','category_translations','worker_type_translations','promo_banners',
      'worker_profiles','worker_worker_types','worker_services','worker_working_hours','worker_discounts',
      'identity_documents','favorites','conversations','messages','service_requests','service_request_events',
      'scheduled_reminders','reviews','notifications','notification_deliveries','contact_history')
    LOOP
        EXECUTE format('CREATE TRIGGER a_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_resource_tombstone()',t.tablename);
        EXECUTE format('CREATE TRIGGER a_resource_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_resource_tombstone()',t.tablename);
        EXECUTE format('CREATE TRIGGER zz_resource_soft_delete AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION cascade_resource_tombstone()',t.tablename);
        EXECUTE format('CREATE CONSTRAINT TRIGGER resource_live_links AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_live_resource_links()',t.tablename);
        EXECUTE format('CREATE INDEX %I ON %I(deleted_at) WHERE deleted_at IS NOT NULL',t.tablename||'_deleted_idx',t.tablename);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION refresh_restored_upload_attachment() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN PERFORM refresh_upload_attachment(NEW.id); END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER file_uploads_refresh_restore AFTER UPDATE OF deleted_at ON file_uploads
FOR EACH ROW EXECUTE FUNCTION refresh_restored_upload_attachment();


-- ---------------------------------------------------------------- catalog integrity and localization
-- Serialize fallback translation edits with parent activation/deactivation.
CREATE OR REPLACE FUNCTION serialize_catalog_translation() RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME='category_translations' THEN
        UPDATE active_categories SET sort_order=sort_order WHERE id=NEW.category_id;
    ELSE
        UPDATE active_worker_types SET sort_order=sort_order WHERE id=NEW.worker_type_id;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER catalog_category_translation_lock BEFORE INSERT OR UPDATE ON category_translations
FOR EACH ROW EXECUTE FUNCTION serialize_catalog_translation();
CREATE TRIGGER catalog_worker_type_translation_lock BEFORE INSERT OR UPDATE ON worker_type_translations
FOR EACH ROW EXECUTE FUNCTION serialize_catalog_translation();

CREATE OR REPLACE FUNCTION validate_catalog_english() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM active_categories c WHERE c.is_active AND NOT EXISTS
        (SELECT 1 FROM active_category_translations t WHERE t.category_id=c.id AND t.language='en')) THEN
        RAISE EXCEPTION 'Active categories require an English fallback translation' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM active_worker_types w WHERE w.is_active AND NOT EXISTS
        (SELECT 1 FROM active_worker_type_translations t WHERE t.worker_type_id=w.id AND t.language='en')) THEN
        RAISE EXCEPTION 'Active worker types require an English fallback translation' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER categories_translation_fallback AFTER INSERT OR UPDATE ON categories
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_catalog_english();
CREATE CONSTRAINT TRIGGER types_translation_fallback AFTER INSERT OR UPDATE ON worker_types
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_catalog_english();
CREATE CONSTRAINT TRIGGER category_translations_fallback AFTER INSERT OR UPDATE ON category_translations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_catalog_english();
CREATE CONSTRAINT TRIGGER worker_type_translations_fallback AFTER INSERT OR UPDATE ON worker_type_translations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_catalog_english();

CREATE OR REPLACE FUNCTION guard_catalog_assignment() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RETURN NEW; END IF;
    IF NOT EXISTS(SELECT 1 FROM active_categories WHERE id=NEW.category_id AND is_active) THEN
        RAISE EXCEPTION 'New category assignments require an active category' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='worker_worker_types' THEN
        IF NOT EXISTS (SELECT 1 FROM active_worker_types WHERE id=NEW.worker_type_id AND category_id=NEW.category_id AND is_active) THEN
            RAISE EXCEPTION 'Worker type must be active and belong to the selected category' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER worker_profiles_catalog_assignment BEFORE INSERT OR UPDATE OF category_id ON worker_profiles
FOR EACH ROW EXECUTE FUNCTION guard_catalog_assignment();
CREATE TRIGGER worker_types_catalog_assignment BEFORE INSERT OR UPDATE OF category_id ON worker_types
FOR EACH ROW EXECUTE FUNCTION guard_catalog_assignment();
CREATE TRIGGER worker_links_catalog_assignment BEFORE INSERT OR UPDATE OF category_id,worker_type_id ON worker_worker_types
FOR EACH ROW EXECUTE FUNCTION guard_catalog_assignment();

CREATE OR REPLACE FUNCTION catalog_categories(p_language TEXT DEFAULT 'en')
RETURNS TABLE(id BIGINT,slug VARCHAR,name VARCHAR,description VARCHAR,icon_key VARCHAR,sort_order SMALLINT)
LANGUAGE SQL STABLE AS $$
    SELECT c.id,c.slug,COALESCE(t.name,en.name),COALESCE(t.description,en.description),c.icon_key,c.sort_order
    FROM active_categories c
    JOIN active_category_translations en ON en.category_id=c.id AND en.language='en'
    LEFT JOIN active_category_translations t ON t.category_id=c.id AND t.language=p_language
    WHERE c.is_active ORDER BY c.sort_order,c.id;
$$;
CREATE OR REPLACE FUNCTION catalog_worker_types(p_language TEXT DEFAULT 'en')
RETURNS TABLE(id BIGINT,category_id BIGINT,slug VARCHAR,name VARCHAR,local_name VARCHAR,icon_key VARCHAR,keywords TEXT[],sort_order SMALLINT)
LANGUAGE SQL STABLE AS $$
    SELECT w.id,w.category_id,w.slug,COALESCE(t.name,en.name),w.local_name,w.icon_key,w.keywords,w.sort_order
    FROM active_worker_types w JOIN active_categories c ON c.id=w.category_id AND c.is_active
    JOIN active_worker_type_translations en ON en.worker_type_id=w.id AND en.language='en'
    LEFT JOIN active_worker_type_translations t ON t.worker_type_id=w.id AND t.language=p_language
    WHERE w.is_active ORDER BY c.sort_order,w.sort_order,w.id;
$$;
CREATE VIEW public_banners AS
SELECT b.* FROM active_promo_banners b
WHERE b.is_active AND (b.starts_at IS NULL OR b.starts_at<=statement_timestamp())
  AND (b.ends_at IS NULL OR b.ends_at>statement_timestamp())
  AND (b.category_id IS NULL OR EXISTS(SELECT 1 FROM active_categories c WHERE c.id=b.category_id AND c.is_active));
CREATE OR REPLACE FUNCTION catalog_banners(p_language TEXT DEFAULT 'en')
RETURNS SETOF public_banners LANGUAGE SQL STABLE AS $$
    SELECT b.* FROM public_banners b WHERE b.language=CASE
      WHEN EXISTS(SELECT 1 FROM public_banners WHERE language=p_language) THEN p_language ELSE 'en' END
    ORDER BY b.sort_order,b.id;
$$;

-- Search is computed from current source rows at query time, eliminating stale
-- cached joined documents after concurrent name/catalog/service edits.
-- simple configuration handles multilingual tokens without assuming English stemming.
-- Ranking is relevance first, worker ID breaks ties. Only public listings appear.
CREATE VIEW worker_search_documents AS
SELECT p.id AS worker_id,
       setweight(u.search_text,'A') || setweight(w.search_text,'B') ||
       setweight(to_tsvector('simple'::regconfig,
           COALESCE((SELECT string_agg(s.name||' '||COALESCE(s.description,''),' ')
                     FROM active_worker_services s WHERE s.worker_id=p.id),'')),'B') ||
       setweight(to_tsvector('simple'::regconfig,
           COALESCE((SELECT string_agg(COALESCE(t.local_name,'')||' '||array_to_string(t.keywords,' ')||' '||
                   COALESCE((SELECT string_agg(tr.name,' ') FROM active_worker_type_translations tr WHERE tr.worker_type_id=t.id),''),' ')
               FROM active_worker_worker_types x JOIN active_worker_types t ON t.id=x.worker_type_id AND t.is_active
               WHERE x.worker_id=p.id),'')),'B') ||
       setweight(to_tsvector('simple'::regconfig,
           COALESCE((SELECT string_agg(t.name||' '||t.description,' ') FROM active_category_translations t WHERE t.category_id=p.category_id),'')),'C')
       AS document
FROM public_worker_profiles p JOIN active_worker_profiles w ON w.id=p.id JOIN active_users u ON u.id=p.user_id;
CREATE OR REPLACE FUNCTION search_workers(p_query TEXT,p_limit INTEGER DEFAULT 50)
RETURNS TABLE(worker_id BIGINT,score REAL) LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p_limit IS NULL OR p_limit<1 OR p_limit>200 OR p_query IS NULL OR length(btrim(p_query))=0 OR length(p_query)>200 THEN
        RAISE EXCEPTION 'Search requires a nonblank query (max 200 characters) and limit 1..200' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT d.worker_id,ts_rank_cd(d.document,q.query)
    FROM worker_search_documents d CROSS JOIN (SELECT websearch_to_tsquery('simple'::regconfig,p_query) AS query) q
    WHERE d.document @@ q.query ORDER BY ts_rank_cd(d.document,q.query) DESC,d.worker_id LIMIT p_limit;
END $$;


-- =====================================================================================
-- Seed: catalog (slugs identify catalog entries independently of numeric primary keys)
-- =====================================================================================
INSERT INTO categories (slug, icon_key, sort_order) VALUES
    ('home_maintenance',   'home',       0),
    ('education',          'education',  1),
    ('technology',         'technology', 2),
    ('food_hospitality',   'food',       3),
    ('healthcare',         'health',     4),
    ('delivery_transport', 'delivery',   5);

INSERT INTO category_translations (category_id, language, name, description) VALUES
    ((SELECT id FROM active_categories WHERE slug = 'home_maintenance'), 'en', 'Home & Maintenance',        'Plumbing, electricity, repairs and cleaning'),
    ((SELECT id FROM active_categories WHERE slug = 'education'), 'en', 'Education',                 'Teachers and private tutors'),
    ((SELECT id FROM active_categories WHERE slug = 'technology'), 'en', 'Technology',                'Developers and engineers'),
    ((SELECT id FROM active_categories WHERE slug = 'food_hospitality'), 'en', 'Food & Hospitality',        'Chefs and baristas for any occasion'),
    ((SELECT id FROM active_categories WHERE slug = 'healthcare'), 'en', 'Healthcare',                'Home nursing and care'),
    ((SELECT id FROM active_categories WHERE slug = 'delivery_transport'), 'en', 'Delivery & Transportation', 'Deliveries and errands');
-- English is the required fallback. Add curated French/Arabic translations as catalog content.

INSERT INTO worker_types (slug, category_id, icon_key, local_name, keywords, sort_order) VALUES
    ('plumber',     (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'plumbing',    'Mksnyen',     '{plumbing,pipes,leak,sink}', 0),
    ('carpenter',   (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'carpentry',   'Najjar',      '{wood,furniture,doors}', 1),
    ('cleaner',     (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'cleaning',    'Tondif',      '{cleaning,housekeeping}', 2),
    ('maintenance', (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'repair',      'Tosli7at',    '{repair,fix,handyman,appliances}', 3),
    ('electrician', (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'electric',    'Kahraba',     '{electricity,wiring,generator,lights}', 4),
    ('water_tank',  (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'water',       'Cetern may',  '{cistern,tank,water}', 5),
    ('janitor',     (SELECT id FROM active_categories WHERE slug = 'home_maintenance'),   'janitor',     'Natour',      '{building,caretaker}', 6),
    ('tutor',       (SELECT id FROM active_categories WHERE slug = 'education'),          'education',   'Estez',       '{teacher,tutor,lessons,math,english}', 0),
    ('programmer',  (SELECT id FROM active_categories WHERE slug = 'technology'),         'code',        'Brmje',       '{developer,software,website,app}', 0),
    ('engineer',    (SELECT id FROM active_categories WHERE slug = 'technology'),         'engineering', 'Mhandes',     '{civil,mechanical,design}', 1),
    ('chef',        (SELECT id FROM active_categories WHERE slug = 'food_hospitality'),   'chef',        'Tabbakh',     '{cooking,catering,food}', 0),
    ('barista',     (SELECT id FROM active_categories WHERE slug = 'food_hospitality'),   'coffee',      NULL,          '{coffee,events}', 1),
    ('nurse',       (SELECT id FROM active_categories WHERE slug = 'healthcare'),         'health',      'Mmarda',      '{nursing,care,elderly,injection}', 0),
    ('delivery',    (SELECT id FROM active_categories WHERE slug = 'delivery_transport'), 'delivery',    'Delivery',    '{delivery,driver,errands,courier}', 0);

INSERT INTO worker_type_translations (worker_type_id, language, name) VALUES
    ((SELECT id FROM active_worker_types WHERE slug = 'plumber'), 'en', 'Plumber'), ((SELECT id FROM active_worker_types WHERE slug = 'carpenter'), 'en', 'Carpenter'), ((SELECT id FROM active_worker_types WHERE slug = 'cleaner'), 'en', 'Cleaner'),
    ((SELECT id FROM active_worker_types WHERE slug = 'maintenance'), 'en', 'Maintenance & Repair'), ((SELECT id FROM active_worker_types WHERE slug = 'electrician'), 'en', 'Electrician'),
    ((SELECT id FROM active_worker_types WHERE slug = 'water_tank'), 'en', 'Water Tank Services'), ((SELECT id FROM active_worker_types WHERE slug = 'janitor'), 'en', 'Janitor'),
    ((SELECT id FROM active_worker_types WHERE slug = 'tutor'), 'en', 'Teacher / Tutor'), ((SELECT id FROM active_worker_types WHERE slug = 'programmer'), 'en', 'Programmer'), ((SELECT id FROM active_worker_types WHERE slug = 'engineer'), 'en', 'Engineer'),
    ((SELECT id FROM active_worker_types WHERE slug = 'chef'), 'en', 'Chef'), ((SELECT id FROM active_worker_types WHERE slug = 'barista'), 'en', 'Barista'), ((SELECT id FROM active_worker_types WHERE slug = 'nurse'), 'en', 'Nurse'),
    ((SELECT id FROM active_worker_types WHERE slug = 'delivery'), 'en', 'Delivery Driver');

-- Bind application functions to this schema even when callers change search_path.
DO $$ DECLARE f RECORD; BEGIN
    FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_catalog',f.signature); END LOOP;
END $$;
COMMIT;
