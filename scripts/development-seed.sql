\set ON_ERROR_STOP on
\timing on
BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '15s';
SET LOCAL search_path = public, pg_catalog;
SELECT pg_advisory_xact_lock(734621, 20261016);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM worker_profiles) THEN
    RAISE EXCEPTION 'Seed requires the finalized schema with no application accounts. Create another development database; do not reset retained data.';
  END IF;
END $$;
CREATE TEMP TABLE seed_options AS SELECT :users::integer AS users, :workers::integer AS workers,
  :requests::integer AS requests, :messages::integer AS messages;
\ir development-seed-catalog.sql

\echo 'Seed phase 1/8: accounts, settings and devices'
CREATE TEMP TABLE seed_users(n integer PRIMARY KEY,id bigint UNIQUE NOT NULL);
WITH inserted AS (
  INSERT INTO users(phone_number,full_name,recovery_email,nationality,latitude,longitude,address,is_admin)
  SELECT '+96170'||lpad(n::text,6,'0'),
    CASE n WHEN 1 THEN 'Nour Haddad (Seed Customer)' WHEN 2 THEN 'Karim Khoury (Seed Worker)' WHEN 3 THEN 'Maya Nassar (Seed Admin)'
    ELSE (ARRAY['Rami','Lina','Omar','Sarah','Jad','Rana','Ali','Mira','Fadi','Hala','Yara','Ziad'])[(n-1)%12+1]||' '||
      (ARRAY['Haddad','Khoury','Saad','Nassar','Mansour','Daher','Saliba','Younes','Hamdan','Azar','Saba','Fakhoury'])[((n-1)/12)%12+1]||' '||n END,
    'seed.account.'||n||'@example.test','LB',
    (ARRAY[33.8938,33.9808,34.4367,33.5606,33.2704,33.8463,34.1230,33.8547,33.8886,34.0058])[(n-1)%10+1]+((n%37)-18)*0.0004,
    (ARRAY[35.5018,35.6178,35.8497,35.3758,35.2038,35.9020,35.6519,35.8623,35.4955,36.2181])[(n-1)%10+1]+((n%41)-20)*0.0004,
    (ARRAY['Beirut','Jounieh','Tripoli','Sidon','Tyre','Zahle','Byblos','Baabda','Hamra','Baalbek'])[(n-1)%10+1], n=3
  FROM seed_options CROSS JOIN LATERAL generate_series(1,users) n
  RETURNING id,phone_number
) INSERT INTO seed_users SELECT right(phone_number,6)::integer,id FROM inserted;
INSERT INTO user_settings(user_id,notifications_enabled,reminder_lead_minutes,language)
SELECT id,n%13<>0,(ARRAY[60,5,15,30,120,1440,0])[(n-1)%7+1],(ARRAY['en','fr','ar'])[(n-1)%3+1] FROM seed_users;
INSERT INTO devices(user_id,fcm_token,locale,app_version)
SELECT id,'seed-only-not-a-real-fcm-token-'||n,(ARRAY['en','fr','ar'])[(n-1)%3+1],'2.0.0-seed' FROM seed_users WHERE n%4<>0;
INSERT INTO devices(user_id,fcm_token,locale,app_version)
SELECT id,'seed-only-secondary-fcm-token-'||n,'en','2.0.0-seed' FROM seed_users WHERE n%20=1;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo 'Seed phase 2/8: workers, services, schedules, private fixture metadata'
CREATE TEMP TABLE seed_types AS SELECT row_number() OVER(ORDER BY t.id)::integer AS n,t.id,t.category_id,et.name
  FROM worker_types t JOIN worker_type_translations et ON et.worker_type_id=t.id AND et.language='en'
  WHERE t.deleted_at IS NULL AND t.is_active;
CREATE TEMP TABLE seed_workers(n integer PRIMARY KEY,id bigint UNIQUE NOT NULL,user_id bigint NOT NULL,type_id bigint NOT NULL,category_id bigint NOT NULL);
WITH inserted AS (
  INSERT INTO worker_profiles(user_id,public_phone_number,whatsapp_number,category_id,description,experience_years,
    starting_price_amount,starting_price_unit,starting_price_currency,latitude,longitude,address,time_zone)
  SELECT u.id,account.phone_number,CASE WHEN g.n%3=0 THEN NULL ELSE account.phone_number END,t.category_id,
    t.name||' services in '||account.address||'. Residential and business appointments, repairs and consultations. Synthetic development profile '||g.n,
    g.n%31,CASE WHEN g.n%17=0 THEN NULL WHEN g.n%19=0 THEN 0 ELSE (10+g.n%150)*CASE WHEN g.n%7=0 THEN 95000 ELSE 1 END END,
    CASE WHEN g.n%17=0 THEN NULL ELSE (ARRAY['PER_HOUR','PER_VISIT','PER_JOB','PER_SESSION','PER_DAY']::price_unit[])[(g.n-1)%5+1] END,
    CASE WHEN g.n%17=0 THEN NULL WHEN g.n%7=0 THEN 'LBP' ELSE 'USD' END,account.latitude,account.longitude,account.address,'Asia/Beirut'
  FROM seed_options o CROSS JOIN LATERAL generate_series(1,o.workers) g(n)
  JOIN seed_users u ON u.n=CASE WHEN g.n=1 THEN 2 ELSE g.n+2 END
  JOIN users account ON account.id=u.id
  JOIN seed_types t ON t.n=(g.n-1)%(SELECT count(*) FROM seed_types)+1
  RETURNING id,user_id,category_id
) INSERT INTO seed_workers
  SELECT CASE WHEN u.n=2 THEN 1 ELSE u.n-2 END,w.id,w.user_id,t.id,w.category_id FROM inserted w JOIN seed_users u ON u.id=w.user_id
  JOIN seed_types t ON t.n=((CASE WHEN u.n=2 THEN 1 ELSE u.n-2 END)-1)%(SELECT count(*) FROM seed_types)+1;
INSERT INTO worker_worker_types(worker_id,worker_type_id,category_id,position) SELECT id,type_id,category_id,0 FROM seed_workers;
INSERT INTO worker_worker_types(worker_id,worker_type_id,category_id,position)
SELECT w.id,extra.id,w.category_id,1 FROM seed_workers w
  JOIN LATERAL (SELECT id FROM worker_types WHERE category_id=w.category_id AND id<>w.type_id ORDER BY id LIMIT 1) extra ON true
WHERE w.n%3=0;
INSERT INTO worker_services(worker_id,name,description,price_amount,price_unit,price_currency,sort_order)
SELECT w.id,t.name||' - '||(ARRAY['Consultation','Standard appointment','Extended service'])[s],
  'Synthetic '||lower(t.name)||' service package '||s||' in '||p.address,
  CASE WHEN p.starting_price_amount IS NULL OR (s=1 AND w.n%5=0) THEN NULL WHEN s=1 AND w.n%11=0 THEN 0 ELSE (10+w.n%150)*s*CASE WHEN w.n%7=0 THEN 95000 ELSE 1 END END,
  CASE WHEN s=1 AND w.n%5=0 THEN NULL ELSE p.starting_price_unit END,
  CASE WHEN s=1 AND w.n%5=0 THEN NULL ELSE p.starting_price_currency END,s-1
FROM seed_workers w JOIN worker_profiles p ON p.id=w.id JOIN seed_types t ON t.id=w.type_id CROSS JOIN generate_series(1,3) s;
INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at,end_day_offset)
SELECT id,day,'09:00'::time,'12:00'::time,0 FROM seed_workers CROSS JOIN generate_series(1,6) day;
INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at,end_day_offset)
SELECT id,day,'13:00'::time,'17:00'::time,0 FROM seed_workers CROSS JOIN generate_series(1,6) day;
INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at,end_day_offset)
SELECT id,7,'22:00'::time,'02:00'::time,1 FROM seed_workers WHERE n%11=0;
INSERT INTO worker_discounts(worker_id,type,value,title)
SELECT w.id,'PERCENTAGE',CASE WHEN w.n%25=0 THEN 100 ELSE 5+(w.n%6)*5 END,'Development promotion'
  FROM seed_workers w JOIN worker_profiles p ON p.id=w.id WHERE w.n%5=0 AND p.starting_price_amount>0;
INSERT INTO worker_discounts(worker_id,type,value,currency,unit,title,expires_at)
SELECT w.id,'FIXED_AMOUNT',round(p.starting_price_amount*0.1,2),p.starting_price_currency,p.starting_price_unit,
  'New customer offer',clock_timestamp()+interval '30 days' FROM seed_workers w JOIN worker_profiles p ON p.id=w.id
WHERE w.n%5=1 AND p.starting_price_amount>0;
CREATE TEMP TABLE seed_uploads(worker_id bigint,n integer,round integer,id bigint PRIMARY KEY);
WITH inserted AS (
  INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
  SELECT user_id,'IDENTITY_DOCUMENT','seed-private-identities','identities/worker-'||n||'/submission-1.pdf' FROM seed_workers
  RETURNING id,owner_user_id
) INSERT INTO seed_uploads SELECT w.id,w.n,1,f.id FROM inserted f JOIN seed_workers w ON w.user_id=f.owner_user_id;
UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=:pdf_bytes,sha256=decode(:'pdf_sha256','hex')
WHERE id IN (SELECT id FROM seed_uploads);
INSERT INTO identity_documents(worker_id,type,upload_id)
SELECT worker_id,(ARRAY['NATIONAL_ID','PASSPORT','DRIVERS_LICENSE']::identity_document_type[])[(n-1)%3+1],id FROM seed_uploads;
UPDATE identity_documents SET status='VERIFIED',reviewed_by=(SELECT id FROM seed_users WHERE n=3);
INSERT INTO notifications(recipient_user_id,type,title,body,worker_id)
SELECT user_id,'VERIFICATION_UPDATE','Verification approved','Your development profile is verified.',id FROM seed_workers;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo 'Seed phase 3/8: requests, valid actor transitions, events, reminders'
CREATE TEMP TABLE seed_public_workers AS SELECT row_number() OVER(ORDER BY id)::integer AS n,id,user_id FROM seed_workers;
CREATE TEMP TABLE seed_customers AS SELECT row_number() OVER(ORDER BY u.n)::integer AS n,u.id FROM seed_users u
  WHERE u.n=1 OR u.n>(SELECT workers+2 FROM seed_options);
CREATE TEMP TABLE seed_requests(n integer PRIMARY KEY,id bigint UNIQUE NOT NULL);
-- Numbered details map generated IDs without assigning database identities.
WITH inserted AS (
  INSERT INTO service_requests(worker_id,customer_id,details,scheduled_at)
  SELECT w.id,c.id,'Development request #'||g.n||': '||(ARRAY['Inspection and estimate','Routine maintenance','Repair appointment','Consultation','Installation'])[(g.n-1)%5+1],
    CASE WHEN ((g.n-1)/o.workers+g.n)%10<5 THEN NULL ELSE clock_timestamp()+interval '7 days'+make_interval(hours=>(g.n%168)) END
  FROM seed_options o CROSS JOIN LATERAL generate_series(1,o.requests) g(n)
  JOIN seed_public_workers w ON w.n=(g.n-1)%o.workers+1
  JOIN seed_customers c ON c.n=((g.n-1)/o.workers*37+(g.n-1))%(SELECT count(*) FROM seed_customers)+1
  RETURNING id,details
) INSERT INTO seed_requests SELECT substring(details FROM '#([0-9]+):')::integer,id FROM inserted;
INSERT INTO notifications(recipient_user_id,type,title,body,request_id)
SELECT customer_id,'SERVICE_REQUEST_SENT'::notification_type,'Request submitted','Your development request was submitted.',id FROM service_requests
UNION ALL SELECT worker_user_id,'SERVICE_REQUEST_RECEIVED'::notification_type,'New service request','A customer requested your services.',id FROM service_requests;
UPDATE service_requests r SET status='ACCEPTED',status_changed_by=r.worker_user_id
FROM seed_requests s WHERE s.id=r.id AND ((s.n-1)/(SELECT workers FROM seed_options)+s.n)%10<7;
UPDATE service_requests r SET status='COMPLETED',status_changed_by=r.worker_user_id
FROM seed_requests s WHERE s.id=r.id AND ((s.n-1)/(SELECT workers FROM seed_options)+s.n)%10<5;
UPDATE service_requests r SET status='DECLINED',status_changed_by=r.worker_user_id,status_reason='No availability for this development appointment'
FROM seed_requests s WHERE s.id=r.id AND ((s.n-1)/(SELECT workers FROM seed_options)+s.n)%10=7;
UPDATE service_requests r SET status='CANCELLED',status_changed_by=r.customer_id,status_reason='Customer changed plans'
FROM seed_requests s WHERE s.id=r.id AND ((s.n-1)/(SELECT workers FROM seed_options)+s.n)%10=8;
INSERT INTO notifications(recipient_user_id,type,title,body,request_id)
SELECT r.customer_id,'SERVICE_REQUEST_UPDATED','Request updated','Request status is now '||r.status,r.id
FROM service_requests r WHERE r.status<>'PENDING';
-- One completed request per reviewer/worker pair; do not manufacture review proof.
INSERT INTO reviews(worker_id,user_id,request_id,rating,comment)
SELECT worker_id,customer_id,id,3+(n%3),'Completed development appointment. '||
  (ARRAY['Clear communication.','Arrived on time.','Professional service.'])[(n-1)%3+1]
FROM (SELECT DISTINCT ON (r.worker_id,r.customer_id) r.*,s.n FROM service_requests r JOIN seed_requests s ON s.id=r.id
  WHERE r.status='COMPLETED' ORDER BY r.worker_id,r.customer_id,r.id) eligible;
INSERT INTO notifications(recipient_user_id,type,title,body,worker_id)
SELECT w.user_id,'NEW_REVIEW','New review','A customer reviewed a completed appointment.',r.worker_id FROM reviews r JOIN seed_workers w ON w.id=r.worker_id;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo 'Seed phase 4/8: conversations and 2-way message histories'
CREATE TEMP TABLE seed_conversations(n integer PRIMARY KEY,id bigint UNIQUE NOT NULL);
WITH inserted AS (
  INSERT INTO conversations(customer_id,worker_id)
  SELECT DISTINCT customer_id,worker_id FROM service_requests
  RETURNING id
) INSERT INTO seed_conversations SELECT row_number() OVER(ORDER BY id)::integer,id FROM inserted;
INSERT INTO messages(conversation_id,sender_id,text)
SELECT c.id,CASE WHEN ((g.n-1)/(SELECT count(*) FROM seed_conversations))%2=0 THEN c.customer_id ELSE c.worker_user_id END,
  (ARRAY['Hello, could you help with this appointment?','Yes, please share the details.','What time works for you?','The afternoon is available.','Thank you, see you then.','Please let me know if plans change.'])[(g.n-1)%6+1]||' [development message '||g.n||']'
FROM seed_options o CROSS JOIN LATERAL generate_series(1,o.messages) g(n)
JOIN seed_conversations sc ON sc.n=(g.n-1)%(SELECT count(*) FROM seed_conversations)+1 JOIN conversations c ON c.id=sc.id
ORDER BY g.n;
-- Latest-message inbox previews without copying chat text.
INSERT INTO notifications(recipient_user_id,type,title,body,conversation_id)
SELECT CASE WHEN m.sender_id=c.customer_id THEN c.worker_user_id ELSE c.customer_id END,'NEW_MESSAGE','New message','You received a message.',c.id
FROM conversations c JOIN LATERAL (SELECT sender_id FROM messages WHERE conversation_id=c.id ORDER BY message_number DESC LIMIT 1) m ON true;
INSERT INTO favorites(user_id,worker_id)
SELECT DISTINCT customer_id,worker_id FROM service_requests WHERE id%3=0;
INSERT INTO contact_history(customer_id,worker_id,interaction_type)
SELECT customer_id,worker_id,CASE WHEN id%2=0 THEN 'CALL'::interaction_type ELSE 'WHATSAPP'::interaction_type END FROM service_requests WHERE id%4=0;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo 'Seed phase 5/8: pending/rejected verification and private file lifecycle examples'
WITH inserted AS (
  INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
  SELECT user_id,'IDENTITY_DOCUMENT','seed-private-identities','identities/worker-'||n||'/submission-2.pdf' FROM seed_workers WHERE n>1 AND n%10 IN (1,2,3)
  RETURNING id,owner_user_id
) INSERT INTO seed_uploads SELECT w.id,w.n,2,f.id FROM inserted f JOIN seed_workers w ON w.user_id=f.owner_user_id;
UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=:pdf_bytes,sha256=decode(:'pdf_sha256','hex')
WHERE id IN (SELECT id FROM seed_uploads WHERE round=2);
INSERT INTO identity_documents(worker_id,type,upload_id) SELECT worker_id,'NATIONAL_ID',id FROM seed_uploads WHERE round=2;
UPDATE identity_documents d SET status='REJECTED',reviewed_by=(SELECT id FROM seed_users WHERE n=3),rejection_reason='Synthetic example: document requires resubmission'
FROM seed_uploads f WHERE d.upload_id=f.id AND f.round=2 AND f.n%10=2;
UPDATE identity_documents d SET deleted_at=clock_timestamp()
FROM seed_uploads f WHERE d.upload_id=f.id AND f.round=2 AND f.n%10=3;
INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
SELECT id,'PROFILE_IMAGE','seed-public-avatars','pending/avatar-'||n||'.jpg' FROM seed_users WHERE n%50=0;
INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
SELECT id,'PROFILE_IMAGE','seed-public-avatars','failed/avatar-'||n||'.jpg' FROM seed_users WHERE n%50=1;
UPDATE file_uploads SET status='FAILED',failure_code='SYNTHETIC_STORAGE_WRITE_FAILED' WHERE object_key LIKE 'failed/%';
UPDATE worker_profiles p SET is_available=false FROM seed_workers w WHERE w.id=p.id AND w.n%7=0;
UPDATE worker_profiles p SET is_listed=false FROM seed_workers w WHERE w.id=p.id AND w.n%17=0;
INSERT INTO promo_banners(title,subtitle,language,icon_key,category_id,sort_order,starts_at,ends_at)
SELECT t.name||' - Development','Discover local services near you.',language,c.icon_key,c.id,c.sort_order,
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '90 days'
FROM categories c JOIN category_translations t ON t.category_id=c.id AND t.deleted_at IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo 'Seed phase 6/8: read notifications and retained lifecycle examples'
UPDATE notifications SET read_at=clock_timestamp() WHERE id%3=0;
UPDATE messages SET deleted_at=clock_timestamp() WHERE id%97=0;
UPDATE favorites SET deleted_at=clock_timestamp() WHERE worker_id%19=0;
UPDATE reviews SET deleted_at=clock_timestamp() WHERE id%31=0;
UPDATE conversations SET deleted_at=clock_timestamp() WHERE id%71=0;
UPDATE service_requests SET deleted_at=clock_timestamp() WHERE id%101=0 AND status IN ('COMPLETED','DECLINED','CANCELLED');
UPDATE worker_profiles p SET deleted_at=clock_timestamp() FROM seed_workers w WHERE p.id=w.id AND w.n%47=0;
UPDATE users u SET account_status='SUSPENDED',suspension_reason='Synthetic moderation example'
FROM seed_users s WHERE u.id=s.id AND s.n>3 AND s.n%89=0;
UPDATE users u SET deleted_at=clock_timestamp() FROM seed_users s WHERE u.id=s.id AND s.n>3 AND s.n%113=0;
-- Synthetic tokens must never be attempted against Firebase, even if an API is
-- mistakenly launched with push enabled. Preserve queue history as CANCELLED.
UPDATE active_notification_deliveries SET status='CANCELLED',next_attempt_at=NULL,lease_expires_at=NULL,last_error_code='SYNTHETIC_SEED_NO_EXTERNAL_SEND'
WHERE status='PENDING';
UPDATE active_devices SET deleted_at=clock_timestamp() WHERE fcm_token LIKE 'seed-only-%';
SET CONSTRAINTS ALL IMMEDIATE;

\echo 'Seed phase 7/8: final consistency checks'
DO $$ BEGIN
  IF (SELECT count(*) FROM users)<>(SELECT users FROM seed_options) OR
     (SELECT count(*) FROM worker_profiles)<>(SELECT workers FROM seed_options) OR
     (SELECT count(*) FROM service_requests)<>(SELECT requests FROM seed_options) OR
     (SELECT count(*) FROM messages)<>(SELECT messages FROM seed_options) THEN
    RAISE EXCEPTION 'Seed size mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM worker_profiles w LEFT JOIN LATERAL
      (SELECT count(*) AS n,COALESCE(round(avg(rating)::numeric,1),0) AS rating FROM active_reviews WHERE worker_id=w.id) actual ON true
      WHERE w.deleted_at IS NULL AND (w.rating_count<>actual.n OR w.rating<>actual.rating)) THEN
    RAISE EXCEPTION 'Seed rating aggregate mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM reviews r JOIN service_requests s ON s.id=r.request_id
      WHERE r.worker_id<>s.worker_id OR r.user_id<>s.customer_id OR s.status<>'COMPLETED') THEN
    RAISE EXCEPTION 'Seed review proof mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM active_notification_deliveries WHERE status IN ('PENDING','PROCESSING','SENT')) THEN
    RAISE EXCEPTION 'Synthetic seed must not claim or simulate provider acceptance';
  END IF;
END $$;
COMMIT;
\echo 'Seed phase 8/8: refresh planner statistics'
ANALYZE;
SELECT json_build_object('users',(SELECT count(*) FROM users),'workers',(SELECT count(*) FROM worker_profiles),
 'publicWorkers',(SELECT count(*) FROM public_worker_profiles),'requests',(SELECT count(*) FROM service_requests),
 'requestEvents',(SELECT count(*) FROM service_request_events),'conversations',(SELECT count(*) FROM conversations),
 'messages',(SELECT count(*) FROM messages),'reviews',(SELECT count(*) FROM reviews),'notifications',(SELECT count(*) FROM notifications),
 'deliveries',(SELECT count(*) FROM notification_deliveries),'reminders',(SELECT count(*) FROM scheduled_reminders),
 'uploads',(SELECT count(*) FROM file_uploads),'suspendedAccounts',(SELECT count(*) FROM users WHERE account_status='SUSPENDED'),
 'deletedAccounts',(SELECT count(*) FROM users WHERE account_status='DELETED')) AS seed_summary;
