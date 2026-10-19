CREATE SCHEMA schema_tests;
CREATE TABLE schema_tests.ids(name TEXT PRIMARY KEY,id BIGINT NOT NULL);
BEGIN;
DO $$
DECLARE owner_id BIGINT; customer_id BIGINT; other_id BIGINT; admin_id BIGINT; outsider_id BIGINT;
        worker_id BIGINT; upload_id BIGINT; document_id BIGINT; request_id BIGINT; conversation_id BIGINT;
        category_id BIGINT; worker_type_id BIGINT;
BEGIN
    INSERT INTO users(phone_number,full_name) VALUES('+96170000001','Fixture worker') RETURNING id INTO owner_id;
    INSERT INTO users(phone_number,full_name) VALUES('+96170000002','Fixture customer') RETURNING id INTO customer_id;
    INSERT INTO users(phone_number,full_name) VALUES('+96170000003','Fixture other customer') RETURNING id INTO other_id;
    INSERT INTO users(phone_number,full_name,is_admin) VALUES('+96170000004','Fixture admin',TRUE) RETURNING id INTO admin_id;
    INSERT INTO users(phone_number,full_name) VALUES('+96170000005','Fixture outsider') RETURNING id INTO outsider_id;
    SELECT id INTO category_id FROM categories WHERE slug='home_maintenance';
    SELECT id INTO worker_type_id FROM worker_types WHERE slug='electrician';
    INSERT INTO worker_profiles(user_id,public_phone_number,category_id,description,latitude,longitude,
        starting_price_amount,starting_price_unit,starting_price_currency)
    VALUES(owner_id,'+96170000001',category_id,'Generator repair specialist',33.89,35.5,50,'PER_JOB','USD') RETURNING id INTO worker_id;
    INSERT INTO worker_worker_types(worker_id,worker_type_id,category_id,position) VALUES(worker_id,worker_type_id,category_id,0);
    INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
    VALUES(owner_id,'IDENTITY_DOCUMENT','private-identities','fixture/identity.pdf') RETURNING id INTO upload_id;
    UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=100,sha256=decode(repeat('ab',32),'hex') WHERE id=upload_id;
    INSERT INTO identity_documents(worker_id,type,upload_id) VALUES(worker_id,'PASSPORT',upload_id) RETURNING id INTO document_id;
    UPDATE identity_documents SET status='VERIFIED',reviewed_by=admin_id WHERE id=document_id;
    INSERT INTO service_requests(worker_id,customer_id,scheduled_at) VALUES(worker_id,customer_id,clock_timestamp()+interval '10 minutes') RETURNING id INTO request_id;
    INSERT INTO schema_tests.ids VALUES('request',request_id);
    UPDATE service_requests SET status='ACCEPTED',status_changed_by=owner_id WHERE id=request_id;
    UPDATE service_requests SET status='COMPLETED',status_changed_by=owner_id WHERE id=request_id;
    INSERT INTO service_requests(worker_id,customer_id) VALUES(worker_id,other_id) RETURNING id INTO request_id;
    INSERT INTO schema_tests.ids VALUES('other_request',request_id);
    UPDATE service_requests SET status='ACCEPTED',status_changed_by=owner_id WHERE id=request_id;
    UPDATE service_requests SET status='COMPLETED',status_changed_by=owner_id WHERE id=request_id;
    INSERT INTO conversations(customer_id,worker_id) VALUES(customer_id,worker_id) RETURNING id INTO conversation_id;
    INSERT INTO schema_tests.ids VALUES('owner',owner_id),('customer',customer_id),('other',other_id),('admin',admin_id),
        ('outsider',outsider_id),('worker',worker_id),('document',document_id),('identity_upload',upload_id),('conversation',conversation_id),
        ('category',category_id),('worker_type',worker_type_id);
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
