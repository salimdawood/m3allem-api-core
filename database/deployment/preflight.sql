-- Read-only inventory. No credentials or personal data are returned.
-- This classifies the target; it does not apply or attempt a UUID-to-BIGINT migration.
BEGIN READ ONLY;
SELECT current_database() AS database_name,current_setting('server_version') AS postgres_version;
SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public') THEN 'EMPTY: standalone bootstrap can be applied'
    WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='id' AND udt_name='uuid')
        THEN 'LEGACY_UUID: requires explicit numeric ID maps, data reconciliation and a separate migration'
    WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='id' AND udt_name='int8')
        THEN 'NUMERIC: compare the installed schema/version before preparing a forward migration'
    ELSE 'NONEMPTY_UNKNOWN: inspect before deployment'
END AS deployment_classification;
SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
WHERE table_schema='public' AND (column_name IN ('id','deleted_at','role','account_status','profile_image_url','profile_image_upload_id','storage_reference','upload_id'))
ORDER BY table_name,ordinal_position;
SELECT relname AS table_name,n_live_tup AS estimated_live_rows
FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname;
DO $$ DECLARE issue_count BIGINT; BEGIN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='identity_documents' AND column_name='storage_reference') THEN
        EXECUTE 'SELECT count(*) FROM public.identity_documents WHERE status IN (''VERIFIED'',''REJECTED'') AND reviewed_by IS NULL' INTO issue_count;
        RAISE NOTICE 'Legacy finalized documents missing reviewer metadata: %',issue_count;
    END IF;
    IF to_regclass('public.reviews') IS NOT NULL AND to_regclass('public.service_requests') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM public.reviews r WHERE NOT EXISTS (SELECT 1 FROM public.service_requests s WHERE s.worker_id=r.worker_id AND s.customer_id=r.user_id AND s.status=''COMPLETED'')' INTO issue_count;
        RAISE NOTICE 'Reviews without a matching completed request (must reconcile, never fabricate requests): %',issue_count;
    END IF;
END $$;
COMMIT;
