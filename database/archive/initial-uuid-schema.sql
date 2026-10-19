-- =====================================================================================
-- M3allem database schema (PostgreSQL 15+)
-- Matches the Android domain models (app/src/main/java/.../domain/model) and the API in API.md.
-- Timestamps are TIMESTAMPTZ in the DB; the API serializes them as epoch milliseconds.
-- =====================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy text search on workers
-- Optional, for fast radius queries: CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- enums
CREATE TYPE user_role             AS ENUM ('CUSTOMER', 'WORKER');
CREATE TYPE verification_status   AS ENUM ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE identity_document_type AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE');
CREATE TYPE price_unit            AS ENUM ('PER_HOUR', 'PER_VISIT', 'PER_JOB', 'PER_SESSION', 'PER_DAY');
CREATE TYPE discount_type         AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE day_of_week           AS ENUM ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY');
CREATE TYPE service_request_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED');
CREATE TYPE notification_type     AS ENUM (
    'SERVICE_REQUEST_RECEIVED', 'SERVICE_REQUEST_SENT', 'SERVICE_REQUEST_UPDATED',
    'NEW_MESSAGE', 'NEW_REVIEW', 'VERIFICATION_UPDATE', 'APPOINTMENT_REMINDER');
CREATE TYPE interaction_type      AS ENUM ('SERVICE_REQUEST', 'CHAT', 'CALL', 'WHATSAPP');
CREATE TYPE otp_purpose           AS ENUM ('LOGIN', 'PHONE_CHANGE', 'RECOVERY_EMAIL', 'ACCOUNT_RECOVERY');

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number       VARCHAR(16)  NOT NULL UNIQUE CHECK (phone_number ~ '^\+961[0-9]{7,8}$'),
    full_name          VARCHAR(120) NOT NULL CHECK (length(btrim(full_name)) > 0),
    profile_image_url  TEXT,
    role               user_role    NOT NULL,
    nationality        CHAR(2)      CHECK (nationality ~ '^[A-Z]{2}$'),     -- ISO 3166-1 alpha-2, private
    recovery_email     CITEXT       UNIQUE,                                 -- verified only, private
    latitude           DOUBLE PRECISION CHECK (latitude  BETWEEN -90  AND 90),
    longitude          DOUBLE PRECISION CHECK (longitude BETWEEN -180 AND 180),
    address            VARCHAR(255),
    is_admin           BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ,
    CHECK ((latitude IS NULL) = (longitude IS NULL))
);

-- One pending code per (purpose, destination). On staging the code is always 111111 (see API.md §2).
CREATE TABLE otp_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose       otp_purpose  NOT NULL,
    destination   VARCHAR(255) NOT NULL,               -- normalized phone or lower-cased email
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,  -- set for PHONE_CHANGE / RECOVERY_EMAIL
    code_hash     TEXT         NOT NULL,               -- HMAC-SHA256(code); never store plain codes
    attempts      SMALLINT     NOT NULL DEFAULT 0,     -- max 5
    expires_at    TIMESTAMPTZ  NOT NULL,               -- created_at + 5 minutes
    resend_after  TIMESTAMPTZ  NOT NULL,               -- created_at + 30 seconds
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (purpose, destination)
);

CREATE TABLE refresh_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    TEXT        NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    replaced_by   UUID REFERENCES refresh_tokens(id),
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

CREATE TABLE devices (
    fcm_token     TEXT PRIMARY KEY,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform      VARCHAR(16) NOT NULL DEFAULT 'android',
    locale        VARCHAR(8),
    app_version   VARCHAR(32),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE user_settings (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notifications_enabled   BOOLEAN     NOT NULL DEFAULT TRUE,
    reminder_lead_minutes   SMALLINT    NOT NULL DEFAULT 60
                            CHECK (reminder_lead_minutes IN (0, 5, 15, 30, 60, 120, 1440)),
    language                VARCHAR(2)  NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'fr', 'ar')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- catalog
CREATE TABLE categories (
    id           VARCHAR(40) PRIMARY KEY,         -- stable slug used by the app, e.g. 'home_maintenance'
    icon_key     VARCHAR(40) NOT NULL,
    sort_order   SMALLINT    NOT NULL DEFAULT 0,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE worker_types (
    id           VARCHAR(40) PRIMARY KEY,         -- e.g. 'plumber'
    category_id  VARCHAR(40) NOT NULL REFERENCES categories(id),
    icon_key     VARCHAR(40) NOT NULL,
    local_name   VARCHAR(80),                     -- Lebanese colloquial name, e.g. 'Mksnyen'
    keywords     TEXT[]      NOT NULL DEFAULT '{}',
    sort_order   SMALLINT    NOT NULL DEFAULT 0,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE
);
CREATE INDEX worker_types_category_idx ON worker_types(category_id);

-- Localized names/descriptions (en / fr / ar), selected by Accept-Language.
CREATE TABLE category_translations (
    category_id  VARCHAR(40) REFERENCES categories(id) ON DELETE CASCADE,
    language     VARCHAR(2)  CHECK (language IN ('en', 'fr', 'ar')),
    name         VARCHAR(80) NOT NULL,
    description  VARCHAR(255) NOT NULL,
    PRIMARY KEY (category_id, language)
);

CREATE TABLE worker_type_translations (
    worker_type_id VARCHAR(40) REFERENCES worker_types(id) ON DELETE CASCADE,
    language       VARCHAR(2)  CHECK (language IN ('en', 'fr', 'ar')),
    name           VARCHAR(80) NOT NULL,
    PRIMARY KEY (worker_type_id, language)
);

CREATE TABLE promo_banners (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        VARCHAR(120) NOT NULL,
    subtitle     VARCHAR(255) NOT NULL,
    language     VARCHAR(2)   NOT NULL DEFAULT 'en',
    image_url    TEXT,                                -- optional; the app draws a placeholder
    icon_key     VARCHAR(40)  NOT NULL,
    category_id  VARCHAR(40)  REFERENCES categories(id),
    sort_order   SMALLINT     NOT NULL DEFAULT 0,
    starts_at    TIMESTAMPTZ,
    ends_at      TIMESTAMPTZ,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------- workers
CREATE TABLE workers (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    full_name            VARCHAR(120) NOT NULL,                 -- denormalized from users for listings
    phone_number         VARCHAR(16)  NOT NULL,                 -- public on purpose (Call button)
    whatsapp_number      VARCHAR(16),                           -- public; NULL = use phone_number
    profile_image_url    TEXT,
    category_id          VARCHAR(40)  NOT NULL REFERENCES categories(id),
    description          VARCHAR(1000) NOT NULL CHECK (length(btrim(description)) > 0),
    experience_years     SMALLINT     NOT NULL DEFAULT 0 CHECK (experience_years BETWEEN 0 AND 80),
    starting_price_amount   NUMERIC(10,2) CHECK (starting_price_amount >= 0),
    starting_price_unit     price_unit,
    starting_price_currency CHAR(3) NOT NULL DEFAULT 'USD',
    latitude             DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude            DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    address              VARCHAR(255),
    rating               NUMERIC(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),   -- maintained on review write
    rating_count         INTEGER      NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
    verification_status  verification_status NOT NULL DEFAULT 'PENDING',
    is_available         BOOLEAN      NOT NULL DEFAULT TRUE,
    joined_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    search_text          TSVECTOR,     -- refreshed by the app layer/trigger from name, description, services, types
    CHECK ((starting_price_amount IS NULL) = (starting_price_unit IS NULL))
);
CREATE INDEX workers_public_idx   ON workers(verification_status, category_id);
CREATE INDEX workers_rating_idx   ON workers(rating DESC) WHERE verification_status = 'VERIFIED';
CREATE INDEX workers_geo_idx      ON workers(latitude, longitude);
CREATE INDEX workers_search_idx   ON workers USING GIN (search_text);
CREATE INDEX workers_name_trgm    ON workers USING GIN (full_name gin_trgm_ops);

-- Ordered worker types; position 0 = primary type (Worker.workerTypeIds[0]).
CREATE TABLE worker_worker_types (
    worker_id       UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    worker_type_id  VARCHAR(40) NOT NULL REFERENCES worker_types(id),
    position        SMALLINT    NOT NULL DEFAULT 0,
    PRIMARY KEY (worker_id, worker_type_id),
    UNIQUE (worker_id, position)
);
CREATE INDEX worker_worker_types_type_idx ON worker_worker_types(worker_type_id);

CREATE TABLE worker_services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id       UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    name            VARCHAR(120) NOT NULL,
    description     VARCHAR(500),
    price_amount    NUMERIC(10,2) CHECK (price_amount >= 0),
    price_unit      price_unit,
    price_currency  CHAR(3)      NOT NULL DEFAULT 'USD',
    sort_order      SMALLINT     NOT NULL DEFAULT 0,
    CHECK ((price_amount IS NULL) = (price_unit IS NULL))
);
CREATE INDEX worker_services_worker_idx ON worker_services(worker_id);

CREATE TABLE worker_working_hours (
    worker_id   UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    day         day_of_week NOT NULL,
    opens_at    TIME        NOT NULL,
    closes_at   TIME        NOT NULL CHECK (closes_at > opens_at),
    PRIMARY KEY (worker_id, day)
);

-- At most one discount per worker (the app models Worker.discount as a single optional value).
CREATE TABLE worker_discounts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id   UUID          NOT NULL UNIQUE REFERENCES workers(id) ON DELETE CASCADE,
    type        discount_type NOT NULL,
    value       NUMERIC(10,2) NOT NULL CHECK (value > 0),
    title       VARCHAR(80),
    expires_at  TIMESTAMPTZ,                       -- NULL = no expiry; inactive once passed
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CHECK (type <> 'PERCENTAGE' OR value <= 90)
    -- FIXED_AMOUNT < starting price is validated in the API (DISCOUNT_EXCEEDS_PRICE)
);

-- PRIVATE. Never joined into public worker payloads; storage_reference points to a private bucket.
CREATE TABLE identity_documents (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id          UUID                   NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    type               identity_document_type NOT NULL,
    storage_reference  TEXT                   NOT NULL,
    status             verification_status    NOT NULL DEFAULT 'PENDING',
    submitted_at       TIMESTAMPTZ            NOT NULL DEFAULT now(),
    reviewed_at        TIMESTAMPTZ,
    reviewed_by        UUID REFERENCES users(id),
    rejection_reason   VARCHAR(500)
);
CREATE INDEX identity_documents_worker_idx  ON identity_documents(worker_id, submitted_at DESC);
CREATE INDEX identity_documents_pending_idx ON identity_documents(submitted_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------- favorites
CREATE TABLE favorites (
    user_id     UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    worker_id   UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, worker_id)
);
CREATE INDEX favorites_worker_idx ON favorites(worker_id);

-- ---------------------------------------------------------------- chat
CREATE TABLE conversations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id      UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    worker_id        UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    last_message     VARCHAR(2000),
    last_message_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, worker_id)                 -- get-or-create
);
CREATE INDEX conversations_customer_idx ON conversations(customer_id, updated_at DESC);
CREATE INDEX conversations_worker_idx   ON conversations(worker_id,   updated_at DESC);

CREATE TABLE messages (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID          NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id        UUID          NOT NULL REFERENCES users(id),
    text             VARCHAR(2000) NOT NULL CHECK (length(btrim(text)) > 0),
    sent_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, sent_at);

-- ---------------------------------------------------------------- service requests
CREATE TABLE service_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id     UUID        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    customer_id   UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    details       VARCHAR(1000),
    scheduled_at  TIMESTAMPTZ,                      -- must be in the future at creation (APPOINTMENT_IN_PAST)
    status        service_request_status NOT NULL DEFAULT 'PENDING',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_requests_worker_idx   ON service_requests(worker_id,   created_at DESC);
CREATE INDEX service_requests_customer_idx ON service_requests(customer_id, created_at DESC);

-- Server-side appointment reminders (one row per recipient); a job sends due rows via FCM.
CREATE TABLE scheduled_reminders (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id         UUID        NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    recipient_user_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_at         TIMESTAMPTZ NOT NULL,        -- scheduled_at - recipient's reminder_lead_minutes
    reference_id       TEXT        NOT NULL,        -- workerId for the customer, requestId for the worker
    sent_at            TIMESTAMPTZ,
    cancelled_at       TIMESTAMPTZ,
    UNIQUE (request_id, recipient_user_id)
);
CREATE INDEX scheduled_reminders_due_idx ON scheduled_reminders(trigger_at)
    WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- ---------------------------------------------------------------- reviews
CREATE TABLE reviews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id   UUID         NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    user_id     UUID         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    rating      SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (worker_id, user_id)                      -- one review per customer per worker (re-POST updates)
);
CREATE INDEX reviews_worker_idx ON reviews(worker_id, created_at DESC);
CREATE INDEX reviews_user_idx   ON reviews(user_id,   created_at DESC);   -- "My reviews"

-- Keeps workers.rating (1 decimal) and rating_count in sync with reviews.
CREATE OR REPLACE FUNCTION refresh_worker_rating() RETURNS TRIGGER AS $$
DECLARE target UUID := COALESCE(NEW.worker_id, OLD.worker_id);
BEGIN
    UPDATE workers w
       SET rating       = COALESCE((SELECT round(avg(r.rating)::numeric, 1) FROM reviews r WHERE r.worker_id = target), 0),
           rating_count = (SELECT count(*) FROM reviews r WHERE r.worker_id = target),
           updated_at   = now()
     WHERE w.id = target;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_refresh_rating
AFTER INSERT OR UPDATE OF rating OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION refresh_worker_rating();

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id  UUID              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type               notification_type NOT NULL,
    title              VARCHAR(160)      NOT NULL,
    body               VARCHAR(500)      NOT NULL,
    reference_id       TEXT,                          -- request / conversation / worker id
    is_read            BOOLEAN           NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ       NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx    ON notifications(recipient_user_id) WHERE NOT is_read;

-- ---------------------------------------------------------------- contact history
CREATE TABLE contact_history (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id       UUID             NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    worker_id         UUID             NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    interaction_type  interaction_type NOT NULL,
    reference_id      TEXT,                           -- e.g. service request id (for its live status)
    created_at        TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX contact_history_customer_idx ON contact_history(customer_id, created_at DESC);

-- ---------------------------------------------------------------- updated_at helper
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch            BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER workers_touch          BEFORE UPDATE ON workers          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER service_requests_touch BEFORE UPDATE ON service_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER reviews_touch          BEFORE UPDATE ON reviews          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- =====================================================================================
-- Seed: catalog (ids MUST match app/src/main/java/.../data/catalog/DefaultCategoryCatalog.kt)
-- =====================================================================================
INSERT INTO categories (id, icon_key, sort_order) VALUES
    ('home_maintenance',   'home',       0),
    ('education',          'education',  1),
    ('technology',         'technology', 2),
    ('food_hospitality',   'food',       3),
    ('healthcare',         'health',     4),
    ('delivery_transport', 'delivery',   5);

INSERT INTO category_translations (category_id, language, name, description) VALUES
    ('home_maintenance',   'en', 'Home & Maintenance',        'Plumbing, electricity, repairs and cleaning'),
    ('education',          'en', 'Education',                 'Teachers and private tutors'),
    ('technology',         'en', 'Technology',                'Developers and engineers'),
    ('food_hospitality',   'en', 'Food & Hospitality',        'Chefs and baristas for any occasion'),
    ('healthcare',         'en', 'Healthcare',                'Home nursing and care'),
    ('delivery_transport', 'en', 'Delivery & Transportation', 'Deliveries and errands');
-- Add 'fr' and 'ar' rows from app/src/main/res/values-fr and values-ar.

INSERT INTO worker_types (id, category_id, icon_key, local_name, keywords, sort_order) VALUES
    ('plumber',     'home_maintenance',   'plumbing',    'Mksnyen',     '{plumbing,pipes,leak,sink}', 0),
    ('carpenter',   'home_maintenance',   'carpentry',   'Najjar',      '{wood,furniture,doors}', 1),
    ('cleaner',     'home_maintenance',   'cleaning',    'Tondif',      '{cleaning,housekeeping}', 2),
    ('maintenance', 'home_maintenance',   'repair',      'Tosli7at',    '{repair,fix,handyman,appliances}', 3),
    ('electrician', 'home_maintenance',   'electric',    'Kahraba',     '{electricity,wiring,generator,lights}', 4),
    ('water_tank',  'home_maintenance',   'water',       'Cetern may',  '{cistern,tank,water}', 5),
    ('janitor',     'home_maintenance',   'janitor',     'Natour',      '{building,caretaker}', 6),
    ('tutor',       'education',          'education',   'Estez',       '{teacher,tutor,lessons,math,english}', 0),
    ('programmer',  'technology',         'code',        'Brmje',       '{developer,software,website,app}', 0),
    ('engineer',    'technology',         'engineering', 'Mhandes',     '{civil,mechanical,design}', 1),
    ('chef',        'food_hospitality',   'chef',        'Tabbakh',     '{cooking,catering,food}', 0),
    ('barista',     'food_hospitality',   'coffee',      NULL,          '{coffee,events}', 1),
    ('nurse',       'healthcare',         'health',      'Mmarda',      '{nursing,care,elderly,injection}', 0),
    ('delivery',    'delivery_transport', 'delivery',    'Delivery',    '{delivery,driver,errands,courier}', 0);

INSERT INTO worker_type_translations (worker_type_id, language, name) VALUES
    ('plumber', 'en', 'Plumber'), ('carpenter', 'en', 'Carpenter'), ('cleaner', 'en', 'Cleaner'),
    ('maintenance', 'en', 'Maintenance & Repair'), ('electrician', 'en', 'Electrician'),
    ('water_tank', 'en', 'Water Tank Services'), ('janitor', 'en', 'Janitor'),
    ('tutor', 'en', 'Teacher / Tutor'), ('programmer', 'en', 'Programmer'), ('engineer', 'en', 'Engineer'),
    ('chef', 'en', 'Chef'), ('barista', 'en', 'Barista'), ('nurse', 'en', 'Nurse'),
    ('delivery', 'en', 'Delivery Driver');
