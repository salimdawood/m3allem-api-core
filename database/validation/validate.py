"""Create an empty, explicitly named test database and validate schema behavior.

Uses installed PostgreSQL tools only; never reads DATABASE_URL or the application .env.
Run with --postgres-bin pointing at PostgreSQL's bin directory when not on PATH.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--postgres-bin', default='')
parser.add_argument('--host', default='127.0.0.1')
parser.add_argument('--port', default='55436')
parser.add_argument('--user', default='schema_test')
args = parser.parse_args()
DB = 'm3allem_schema_test_' + str(time.time_ns())
PSQL = str(Path(args.postgres_bin) / 'psql') if args.postgres_bin else 'psql'
CONNECTION = ['-X', '-q', '-A', '-t', '-h', args.host, '-p', args.port, '-U', args.user, '-d', DB, '-v', 'ON_ERROR_STOP=1']
ENV = {**os.environ, 'PGCLIENTENCODING': 'UTF8'}

def run(sql, check=True):
    result = subprocess.run([PSQL, *CONNECTION], input='\\set VERBOSITY verbose\n' + sql,
                            text=True, encoding='utf-8', capture_output=True, env=ENV, timeout=35)
    if check and result.returncode:
        raise AssertionError(result.stderr)
    return result

createdb = str(Path(args.postgres_bin) / 'createdb') if args.postgres_bin else 'createdb'
subprocess.run([createdb, '-h', args.host, '-p', args.port, '-U', args.user, DB], check=True, env=ENV, capture_output=True)
run((ROOT / 'schema.sql').read_text(encoding='utf-8'))
run((ROOT / 'validation/fixture.sql').read_text(encoding='utf-8'))
IDS = json.loads(run('SELECT json_object_agg(name,id) FROM schema_tests.ids;').stdout)

def ident(name):
    return str(IDS[name])

class SchemaTests(unittest.TestCase):
    def scalar(self, sql):
        return run(sql).stdout.strip()

    def valid(self, sql):
        return self.scalar('BEGIN;\n' + sql + '\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;')

    def rejects(self, sql, expected='23514'):
        result = run('BEGIN;\n' + sql + '\nSET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;', check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(expected, result.stderr)

    def test_01_all_resources_have_tombstones_and_guards(self):
        self.assertEqual(self.scalar("SELECT count(*) FROM pg_tables t WHERE schemaname='public' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema=t.schemaname AND c.table_name=t.tablename AND column_name='deleted_at');"), '0')
        self.assertEqual(self.scalar("SELECT count(*) FROM pg_tables WHERE schemaname='public';"), '29')
        self.assertEqual(self.scalar("SELECT count(*) FROM pg_trigger WHERE tgname='a_resource_guard';"), '29')

    def test_02_numeric_entity_keys(self):
        self.assertEqual(self.scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='id' AND data_type<>'bigint';"), '0')

    def test_03_hard_delete_and_truncate_are_rejected(self):
        self.rejects(f'DELETE FROM reviews WHERE worker_id={ident("worker")}; INSERT INTO reviews(worker_id,user_id,request_id,rating) VALUES({ident("worker")},{ident("customer")},{ident("request")},5); DELETE FROM reviews WHERE worker_id={ident("worker")};')
        self.rejects('TRUNCATE favorites;')
        self.rejects(f'DELETE FROM users WHERE id={ident("outsider")};')

    def test_04_profile_needs_primary_type(self):
        self.rejects(f"INSERT INTO worker_profiles(user_id,public_phone_number,category_id,description,latitude,longitude) VALUES({ident('outsider')},'+96170000005',{ident('category')},'Missing primary',1,1);")

    def test_05_cross_category_type_rejected(self):
        self.rejects(f"UPDATE worker_worker_types SET worker_type_id=(SELECT id FROM worker_types WHERE slug='chef') WHERE worker_id={ident('worker')};")

    def test_06_primary_type_cannot_be_soft_deleted_alone(self):
        self.rejects(f"UPDATE worker_worker_types SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')} AND position=0;")

    def test_07_missing_price_dimensions_rejected(self):
        self.rejects(f"UPDATE worker_profiles SET starting_price_currency=NULL WHERE id={ident('worker')};")
        self.rejects(f"UPDATE worker_profiles SET starting_price_amount='NaN' WHERE id={ident('worker')};")

    def test_08_discount_price_changes_and_soft_delete(self):
        prefix=f"INSERT INTO worker_discounts(worker_id,type,value,currency,unit) VALUES({ident('worker')},'FIXED_AMOUNT',20,'USD','PER_JOB');"
        self.rejects(prefix+f"UPDATE worker_profiles SET starting_price_amount=10 WHERE id={ident('worker')};")
        self.rejects(prefix+f"UPDATE worker_profiles SET starting_price_currency='EUR' WHERE id={ident('worker')};")
        self.valid(prefix+f"UPDATE worker_discounts SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')}; UPDATE worker_profiles SET starting_price_amount=10 WHERE id={ident('worker')}; INSERT INTO worker_discounts(worker_id,type,value) VALUES({ident('worker')},'PERCENTAGE',100);")

    def test_09_working_hours_wrap_and_soft_delete(self):
        prefix=f"INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at,end_day_offset) VALUES({ident('worker')},7,'22:00','02:00',1);"
        self.rejects(prefix+f"INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at) VALUES({ident('worker')},1,'01:00','03:00');", '23P01')
        self.valid(prefix+f"UPDATE worker_working_hours SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')}; INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at) VALUES({ident('worker')},1,'01:00','03:00');")
        self.valid(f"INSERT INTO worker_working_hours(worker_id,iso_weekday,opens_at,closes_at) VALUES({ident('worker')},1,'08:00','12:00'),({ident('worker')},1,'12:00','17:00');")

    def test_10_unknown_timezone_rejected(self):
        self.rejects(f"UPDATE worker_profiles SET time_zone='Mars/Nowhere' WHERE id={ident('worker')};")

    def test_11_soft_deleted_identity_does_not_reverify_from_old_document(self):
        result=self.valid(f"UPDATE identity_documents SET deleted_at=clock_timestamp() WHERE id={ident('document')}; SELECT verification_status FROM worker_verification WHERE worker_id={ident('worker')};")
        self.assertEqual(result,'NOT_SUBMITTED')

    def test_12_finalized_document_is_immutable(self):
        self.rejects(f"UPDATE identity_documents SET status='REJECTED',rejection_reason='Changed' WHERE id={ident('document')};")

    def test_13_review_requires_completed_request_and_not_self(self):
        self.rejects(f"INSERT INTO reviews(worker_id,user_id,request_id,rating) VALUES({ident('worker')},{ident('outsider')},{ident('request')},5);")
        self.rejects(f"INSERT INTO reviews(worker_id,user_id,request_id,rating) VALUES({ident('worker')},{ident('owner')},{ident('request')},5);")

    def test_14_review_soft_delete_and_restore_recompute_rating(self):
        result=self.valid(f"INSERT INTO reviews(worker_id,user_id,request_id,rating) VALUES({ident('worker')},{ident('customer')},{ident('request')},5); UPDATE reviews SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')}; SELECT rating_count FROM worker_profiles WHERE id={ident('worker')}; UPDATE reviews SET deleted_at=NULL WHERE worker_id={ident('worker')}; SELECT rating_count FROM worker_profiles WHERE id={ident('worker')};")
        self.assertEqual(result,'0\n1')

    def test_15_cached_rating_cannot_be_fabricated(self):
        self.rejects(f"UPDATE worker_profiles SET rating=5,rating_count=99 WHERE id={ident('worker')};")

    def test_16_message_sender_and_conversation_identity(self):
        self.rejects(f"INSERT INTO messages(conversation_id,sender_id,text) VALUES({ident('conversation')},{ident('outsider')},'intruder');")
        self.rejects(f"UPDATE conversations SET customer_id={ident('outsider')} WHERE id={ident('conversation')};")
        self.rejects(f"INSERT INTO messages(conversation_id,sender_id,text) VALUES({ident('conversation')},{ident('customer')},'  ');")

    def test_17_message_soft_delete_keeps_sequence_and_summary(self):
        result=self.valid(f"INSERT INTO messages(conversation_id,sender_id,text) VALUES({ident('conversation')},{ident('customer')},'one'); UPDATE messages SET deleted_at=clock_timestamp() WHERE conversation_id={ident('conversation')}; INSERT INTO messages(conversation_id,sender_id,text) VALUES({ident('conversation')},{ident('owner')},'two'); SELECT message_number FROM active_messages WHERE conversation_id={ident('conversation')}; SELECT last_message FROM conversation_summaries WHERE id={ident('conversation')};")
        self.assertEqual(result,'2\ntwo')

    def test_18_request_transitions_and_history(self):
        self.rejects(f"UPDATE service_requests SET status='ACCEPTED',status_changed_by={ident('owner')} WHERE id={ident('request')};")
        self.assertEqual(self.scalar(f"SELECT string_agg(to_status::text,',' ORDER BY version) FROM service_request_events WHERE request_id={ident('request')};"),'PENDING,ACCEPTED,COMPLETED')

    def test_19_favorites_soft_delete_and_restore(self):
        result=self.valid(f"INSERT INTO favorites(user_id,worker_id) VALUES({ident('customer')},{ident('worker')}); UPDATE favorites SET deleted_at=clock_timestamp() WHERE user_id={ident('customer')}; SELECT count(*) FROM active_favorites WHERE user_id={ident('customer')}; UPDATE favorites SET deleted_at=NULL WHERE user_id={ident('customer')}; SELECT count(*) FROM active_favorites WHERE user_id={ident('customer')};")
        self.assertEqual(result,'0\n1')
        self.rejects(f"INSERT INTO favorites(user_id,worker_id) VALUES({ident('owner')},{ident('worker')});")

    def test_20_search_tracks_edits_and_deleted_services(self):
        result=self.valid(f"INSERT INTO worker_services(worker_id,name) VALUES({ident('worker')},'ultrararefixtureword'); SELECT count(*) FROM search_workers('ultrararefixtureword'); UPDATE worker_services SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')}; SELECT count(*) FROM search_workers('ultrararefixtureword'); UPDATE users SET full_name='renamedfixtureword' WHERE id={ident('owner')}; SELECT count(*) FROM search_workers('renamedfixtureword');")
        self.assertEqual(result,'1\n0\n1')

    def test_21_catalog_fallback_and_retirement(self):
        self.assertEqual(self.scalar("SELECT name FROM catalog_categories('ar') WHERE slug='home_maintenance';"),'Home & Maintenance')
        self.rejects(f"UPDATE category_translations SET deleted_at=clock_timestamp() WHERE category_id={ident('category')} AND language='en';")
        result=self.valid(f"UPDATE categories SET is_active=FALSE WHERE id={ident('category')}; SELECT count(*) FROM public_worker_profiles WHERE id={ident('worker')};")
        self.assertEqual(result,'0')

    def test_22_banners_language_and_window(self):
        self.rejects("INSERT INTO promo_banners(title,subtitle,icon_key,language) VALUES('Title','Subtitle','home','xx');",'23514')
        self.rejects("INSERT INTO promo_banners(title,subtitle,icon_key,starts_at,ends_at) VALUES('Title','Subtitle','home',now(),now()-interval '1 day');")

    def test_23_notification_targets_and_deliveries(self):
        self.rejects(f"INSERT INTO notifications(recipient_user_id,type,title,body,request_id) VALUES({ident('outsider')},'SERVICE_REQUEST_UPDATED','Title','Body',{ident('request')});")
        result=self.valid(f"INSERT INTO devices(user_id,fcm_token) VALUES({ident('customer')},'fixture-token'); INSERT INTO notifications(recipient_user_id,type,title,body,request_id) VALUES({ident('customer')},'SERVICE_REQUEST_UPDATED','Title','Body',{ident('request')}); SELECT count(*) FROM active_notification_deliveries WHERE recipient_user_id={ident('customer')}; UPDATE notifications SET deleted_at=clock_timestamp() WHERE recipient_user_id={ident('customer')}; SELECT count(*) FROM active_notification_deliveries WHERE recipient_user_id={ident('customer')};")
        self.assertEqual(result,'1\n0')

    def test_24_session_rotation_reuse_and_security_change(self):
        result=self.valid(f"INSERT INTO auth_sessions(user_id,expires_at) VALUES({ident('customer')},clock_timestamp()+interval '1 day'); INSERT INTO refresh_tokens(session_id,token_hash,expires_at) SELECT id,decode(repeat('01',32),'hex'),clock_timestamp()+interval '1 hour' FROM auth_sessions WHERE user_id={ident('customer')}; SELECT outcome FROM rotate_refresh_token(decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),clock_timestamp()+interval '1 hour'); SELECT outcome FROM rotate_refresh_token(decode(repeat('01',32),'hex'),decode(repeat('03',32),'hex'),clock_timestamp()+interval '1 hour'); SELECT count(*) FROM auth_sessions WHERE user_id={ident('customer')} AND revoked_at IS NOT NULL;")
        self.assertEqual(result,'OK\nTOKEN_REUSED\n1')
        result=self.valid(f"INSERT INTO auth_sessions(user_id,expires_at) VALUES({ident('customer')},clock_timestamp()+interval '1 day'); UPDATE users SET phone_number='+96170000999' WHERE id={ident('customer')}; SELECT count(*) FROM auth_sessions WHERE user_id={ident('customer')} AND revoked_at IS NOT NULL;")
        self.assertEqual(result,'1')

    def test_25_otp_failure_counters_consume_and_resend(self):
        prefix="INSERT INTO otp_flows(purpose,destination) VALUES('LOGIN','+96170000888'); INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash) SELECT id,decode(repeat('11',16),'hex'),decode(repeat('22',32),'hex') FROM otp_flows WHERE destination='+96170000888';"
        result=self.valid(prefix+"SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('33',32),'hex')) FROM otp_challenges c; SELECT attempts FROM otp_challenges; SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('22',32),'hex')) FROM otp_challenges c; SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('22',32),'hex')) FROM otp_challenges c;")
        self.assertEqual(result,'INVALID_OTP\n1\nOK\nOTP_EXPIRED')
        self.rejects(prefix+"INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash) SELECT id,decode(repeat('44',16),'hex'),decode(repeat('55',32),'hex') FROM otp_flows WHERE destination='+96170000888';")

    def test_26_suspension_hides_worker_and_revokes_access(self):
        result=self.valid(f"INSERT INTO auth_sessions(user_id,expires_at) VALUES({ident('owner')},clock_timestamp()+interval '1 day'); UPDATE users SET account_status='SUSPENDED',suspension_reason='Support review' WHERE id={ident('owner')}; SELECT count(*) FROM public_worker_profiles WHERE id={ident('worker')}; SELECT count(*) FROM auth_sessions WHERE user_id={ident('owner')} AND revoked_at IS NOT NULL; UPDATE users SET account_status='ACTIVE' WHERE id={ident('owner')}; SELECT count(*) FROM public_worker_profiles WHERE id={ident('worker')};")
        self.assertEqual(result,'0\n1\n1')

    def test_27_account_soft_delete_cascades_without_destroying_history(self):
        result=self.valid(f"UPDATE users SET deleted_at=clock_timestamp() WHERE id={ident('owner')}; SELECT account_status FROM users WHERE id={ident('owner')}; SELECT count(*) FROM active_worker_profiles WHERE id={ident('worker')}; SELECT count(*) FROM worker_profiles WHERE id={ident('worker')}; SELECT count(*) FROM service_requests WHERE worker_id={ident('worker')};")
        self.assertEqual(result,'DELETED\n0\n1\n2')

    def test_28_tombstones_cannot_hide_payload_edits(self):
        self.rejects(f"UPDATE worker_services SET deleted_at=clock_timestamp(),name='hijacked' WHERE worker_id={ident('worker')}; INSERT INTO worker_services(worker_id,name) VALUES({ident('worker')},'original'); UPDATE worker_services SET deleted_at=clock_timestamp(),name='hijacked' WHERE worker_id={ident('worker')};")

    def test_29_attachment_ownership_and_soft_delete(self):
        self.rejects(f"UPDATE file_uploads SET deleted_at=clock_timestamp() WHERE id={ident('identity_upload')};")
        result=self.valid(f"UPDATE identity_documents SET deleted_at=clock_timestamp() WHERE id={ident('document')}; UPDATE file_uploads SET deleted_at=clock_timestamp() WHERE id={ident('identity_upload')}; SELECT count(*) FROM active_file_uploads WHERE id={ident('identity_upload')}; SELECT count(*) FROM file_uploads WHERE id={ident('identity_upload')};")
        self.assertEqual(result,'0\n1')

    def test_30_contact_history_is_automatic_and_typed(self):
        self.assertEqual(self.scalar(f"SELECT count(*) FROM contact_history WHERE customer_id={ident('customer')};"),'2')
        self.rejects(f"INSERT INTO contact_history(customer_id,worker_id,interaction_type,conversation_id) VALUES({ident('outsider')},{ident('worker')},'CHAT',{ident('conversation')});")

    def test_31_concurrent_message_numbers(self):
        count_before=int(self.scalar(f"SELECT count(*) FROM messages WHERE conversation_id={ident('conversation')};"))
        processes=[]
        for label in ['a','b']:
            sql=f"BEGIN; INSERT INTO messages(conversation_id,sender_id,text) VALUES({ident('conversation')},{ident('customer')},'concurrent {label}'); SELECT pg_sleep(0.25); COMMIT;"
            proc=subprocess.Popen([PSQL,*CONNECTION],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=ENV)
            proc.stdin.write(sql);proc.stdin.close();processes.append(proc)
        for proc in processes:
            proc.wait(timeout=20)
            self.assertEqual(proc.returncode,0,proc.stderr.read())
        self.assertEqual(int(self.scalar(f"SELECT count(*) FROM messages WHERE conversation_id={ident('conversation')};")),count_before+2)
        self.assertEqual(self.scalar(f"SELECT count(*)=count(DISTINCT message_number) FROM messages WHERE conversation_id={ident('conversation')};"),'t')

    def test_32_concurrent_reviews_match_stored_aggregate(self):
        processes=[]
        for person,request,rating in [('customer','request',5),('other','other_request',3)]:
            sql=f"BEGIN; INSERT INTO reviews(worker_id,user_id,request_id,rating) VALUES({ident('worker')},{ident(person)},{ident(request)},{rating}); SELECT pg_sleep(0.25); COMMIT;"
            proc=subprocess.Popen([PSQL,*CONNECTION],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=ENV)
            proc.stdin.write(sql);proc.stdin.close();processes.append(proc)
        for proc in processes:
            proc.wait(timeout=20)
            self.assertEqual(proc.returncode,0,proc.stderr.read())
        self.assertEqual(self.scalar(f"SELECT rating=4 AND rating_count=2 FROM worker_profiles WHERE id={ident('worker')};"),'t')

    def test_33_reminder_materialization_and_request_soft_delete(self):
        self.valid(f"""DO $$ DECLARE r BIGINT; m BIGINT;
        BEGIN
          INSERT INTO devices(user_id,fcm_token) VALUES({ident('customer')},'reminder-device');
          INSERT INTO service_requests(worker_id,customer_id,scheduled_at)
          VALUES({ident('worker')},{ident('customer')},clock_timestamp()+interval '5 minutes') RETURNING id INTO r;
          UPDATE service_requests SET status='ACCEPTED',status_changed_by={ident('owner')} WHERE id=r;
          IF (SELECT count(*) FROM active_scheduled_reminders WHERE request_id=r)<>2 THEN RAISE EXCEPTION 'Missing reminders'; END IF;
          SELECT id INTO m FROM active_scheduled_reminders WHERE request_id=r AND recipient_user_id={ident('customer')};
          INSERT INTO notifications(recipient_user_id,type,title,body,request_id,reminder_id)
          VALUES({ident('customer')},'APPOINTMENT_REMINDER','Appointment','Upcoming appointment',r,m);
          IF (SELECT notification_id FROM scheduled_reminders WHERE id=m) IS NULL THEN RAISE EXCEPTION 'Missing materialization link'; END IF;
          UPDATE service_requests SET deleted_at=clock_timestamp() WHERE id=r;
          IF EXISTS(SELECT 1 FROM active_scheduled_reminders WHERE request_id=r) THEN RAISE EXCEPTION 'Reminder remained live'; END IF;
          IF EXISTS(SELECT 1 FROM active_notifications WHERE request_id=r) THEN RAISE EXCEPTION 'Notification remained live'; END IF;
        END $$;""")

    def test_34_delivery_claim_retry_and_device_soft_delete(self):
        self.valid(f"""DO $$ DECLARE d BIGINT; n BIGINT; job BIGINT;
        BEGIN
          INSERT INTO devices(user_id,fcm_token) VALUES({ident('customer')},'claim-device') RETURNING id INTO d;
          INSERT INTO notifications(recipient_user_id,type,title,body,request_id)
          VALUES({ident('customer')},'SERVICE_REQUEST_UPDATED','Title','Body',{ident('request')}) RETURNING id INTO n;
          SELECT id INTO job FROM notification_deliveries WHERE notification_id=n;
          UPDATE notification_deliveries SET status='PROCESSING',attempts=1,claim_version=1,next_attempt_at=NULL,
            lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=job;
          UPDATE notification_deliveries SET status='PENDING',lease_expires_at=NULL,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE id=job;
          UPDATE devices SET deleted_at=clock_timestamp() WHERE id=d;
          IF EXISTS(SELECT 1 FROM active_notification_deliveries WHERE id=job) THEN RAISE EXCEPTION 'Deleted device retained a live delivery'; END IF;
        END $$;""")

    def test_35_latest_identity_submission_and_superseded_review(self):
        self.valid(f"""DO $$ DECLARE f BIGINT; d BIGINT;
        BEGIN
          INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES({ident('owner')},'IDENTITY_DOCUMENT','private-identities','fixture/second.pdf') RETURNING id INTO f;
          UPDATE file_uploads SET status='READY',content_type='application/pdf',size_bytes=100,sha256=decode(repeat('cd',32),'hex') WHERE id=f;
          INSERT INTO identity_documents(worker_id,type,upload_id) VALUES({ident('worker')},'PASSPORT',f) RETURNING id INTO d;
          IF (SELECT verification_status FROM worker_verification WHERE worker_id={ident('worker')})<>'PENDING' THEN RAISE EXCEPTION 'Not pending'; END IF;
          UPDATE identity_documents SET deleted_at=clock_timestamp() WHERE id=d;
          IF (SELECT verification_status FROM worker_verification WHERE worker_id={ident('worker')})<>'NOT_SUBMITTED' THEN RAISE EXCEPTION 'Fell back to older approval'; END IF;
          UPDATE identity_documents SET deleted_at=NULL WHERE id=d;
          IF (SELECT verification_status FROM worker_verification WHERE worker_id={ident('worker')})<>'PENDING' THEN RAISE EXCEPTION 'Restore lost current pointer'; END IF;
        END $$;""")

    def test_36_live_foreign_keys_and_restore_eligibility(self):
        self.rejects(f"UPDATE worker_services SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')}; UPDATE users SET account_status='SUSPENDED',suspension_reason='Testing' WHERE id={ident('outsider')}; INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key) VALUES({ident('outsider')},'PROFILE_IMAGE','images','inactive-owner.jpg');")
        self.rejects(f"INSERT INTO favorites(user_id,worker_id) VALUES({ident('customer')},{ident('worker')}); UPDATE favorites SET deleted_at=clock_timestamp() WHERE user_id={ident('customer')}; UPDATE worker_profiles SET is_listed=FALSE WHERE id={ident('worker')}; UPDATE favorites SET deleted_at=NULL WHERE user_id={ident('customer')};")

    def test_37_profile_photo_attachment_ownership(self):
        self.valid(f"""DO $$ DECLARE f BIGINT;
        BEGIN
          INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES({ident('customer')},'PROFILE_IMAGE','images','fixture/avatar.jpg') RETURNING id INTO f;
          UPDATE file_uploads SET status='READY',content_type='image/jpeg',size_bytes=100,sha256=decode(repeat('cd',32),'hex') WHERE id=f;
          UPDATE users SET profile_image_upload_id=f WHERE id={ident('customer')};
          IF (SELECT cleanup_after FROM file_uploads WHERE id=f) IS NOT NULL THEN RAISE EXCEPTION 'Attached avatar scheduled for cleanup'; END IF;
          UPDATE users SET profile_image_upload_id=NULL WHERE id={ident('customer')};
          UPDATE file_uploads SET deleted_at=clock_timestamp() WHERE id=f;
        END $$;""")

    def test_38_deleted_account_does_not_delete_other_party_history(self):
        result=self.valid(f"UPDATE users SET deleted_at=clock_timestamp() WHERE id={ident('owner')}; SELECT count(*) FROM active_service_requests WHERE worker_id={ident('worker')}; SELECT count(*) FROM active_conversations WHERE worker_id={ident('worker')};")
        self.assertEqual(result,'2\n1')

    def parallel(self, statements):
        processes=[]
        for sql in statements:
            proc=subprocess.Popen([PSQL,*CONNECTION],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=ENV)
            proc.stdin.write(sql);proc.stdin.close();processes.append(proc)
        results=[]
        for proc in processes:
            proc.wait(timeout=25)
            results.append((proc.returncode,proc.stdout.read().strip(),proc.stderr.read()))
        return results

    def test_39_concurrent_otp_consumption(self):
        self.scalar("INSERT INTO otp_flows(purpose,destination) VALUES('LOGIN','+96170000777'); INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash) SELECT id,decode(repeat('77',16),'hex'),decode(repeat('77',32),'hex') FROM active_otp_flows WHERE destination='+96170000777';")
        sql="BEGIN; SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('77',32),'hex')) FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.destination='+96170000777'; SELECT pg_sleep(0.2); COMMIT;"
        results=self.parallel([sql,sql])
        self.assertTrue(all(r[0]==0 for r in results),results)
        self.assertEqual(sorted(r[1].strip() for r in results),['OK','OTP_EXPIRED'])

    def test_40_concurrent_refresh_reuse_revokes_session(self):
        self.scalar(f"INSERT INTO auth_sessions(user_id,expires_at) VALUES({ident('other')},clock_timestamp()+interval '1 day'); INSERT INTO refresh_tokens(session_id,token_hash,expires_at) SELECT max(id),decode(repeat('66',32),'hex'),clock_timestamp()+interval '1 hour' FROM active_auth_sessions WHERE user_id={ident('other')};")
        results=self.parallel([f"BEGIN; SELECT outcome FROM rotate_refresh_token(decode(repeat('66',32),'hex'),decode(repeat('{value}',32),'hex'),clock_timestamp()+interval '1 hour'); SELECT pg_sleep(0.2); COMMIT;" for value in ['67','68']])
        self.assertTrue(all(r[0]==0 for r in results),results)
        self.assertEqual(sorted(r[1].strip() for r in results),['OK','TOKEN_REUSED'])

    def test_41_concurrent_discount_and_price_edit(self):
        results=self.parallel([
            f"BEGIN; INSERT INTO worker_discounts(worker_id,type,value,currency,unit) VALUES({ident('worker')},'FIXED_AMOUNT',20,'USD','PER_JOB'); SELECT pg_sleep(0.2); COMMIT;",
            f"BEGIN; UPDATE worker_profiles SET starting_price_amount=10 WHERE id={ident('worker')}; SELECT pg_sleep(0.2); COMMIT;"])
        self.assertEqual(sum(r[0]==0 for r in results),1,results)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM active_worker_discounts d JOIN active_worker_profiles w ON w.id=d.worker_id WHERE w.id={ident('worker')} AND d.value>w.starting_price_amount;"),'0')

    def test_42_concurrent_review_delete_and_edit(self):
        results=self.parallel([
            f"BEGIN; UPDATE reviews SET deleted_at=clock_timestamp() WHERE worker_id={ident('worker')} AND user_id={ident('customer')}; SELECT pg_sleep(0.2); COMMIT;",
            f"BEGIN; UPDATE reviews SET rating=4 WHERE worker_id={ident('worker')} AND user_id={ident('other')}; SELECT pg_sleep(0.2); COMMIT;"])
        self.assertTrue(all(r[0]==0 for r in results),results)
        self.assertEqual(self.scalar(f"SELECT rating=4 AND rating_count=1 FROM worker_profiles WHERE id={ident('worker')};"),'t')

    def test_43_multilingual_catalog_search_tracks_live_sources(self):
        result=self.valid(f"UPDATE worker_types SET keywords=keywords||ARRAY['rarefixturekeyword'] WHERE id={ident('worker_type')}; SELECT count(*) FROM search_workers('rarefixturekeyword'); INSERT INTO worker_type_translations(worker_type_id,language,name) VALUES({ident('worker_type')},'fr','perceusefixture'); SELECT count(*) FROM search_workers('perceusefixture'); UPDATE worker_type_translations SET deleted_at=clock_timestamp() WHERE worker_type_id={ident('worker_type')} AND language='fr'; SELECT count(*) FROM search_workers('perceusefixture');")
        self.assertEqual(result,'1\n1\n0')

    def test_44_otp_expiry_exhaustion_and_supersession(self):
        # Clock-boundary fixtures only: the isolated test role backdates issuance
        # under replica mode. Application callers must never bypass these guards.
        prefix="INSERT INTO otp_flows(purpose,destination) VALUES('LOGIN','+96170000666'); INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash) SELECT id,decode(repeat('99',16),'hex'),decode(repeat('99',32),'hex') FROM active_otp_flows WHERE destination='+96170000666';"
        result=self.valid(prefix+"SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('00',32),'hex')) FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id CROSS JOIN generate_series(1,5) n WHERE f.destination='+96170000666'; SELECT attempts FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.destination='+96170000666';")
        self.assertEqual(result,'INVALID_OTP\nINVALID_OTP\nINVALID_OTP\nINVALID_OTP\nOTP_EXPIRED\n5')
        result=self.valid(prefix+"SET LOCAL session_replication_role=replica; UPDATE otp_challenges SET created_at=created_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes',resend_after=resend_after-interval '10 minutes' WHERE flow_id=(SELECT id FROM active_otp_flows WHERE destination='+96170000666'); SET LOCAL session_replication_role=origin; SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('99',32),'hex')) FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.destination='+96170000666';")
        self.assertEqual(result,'OTP_EXPIRED')
        result=self.valid(prefix+"SET LOCAL session_replication_role=replica; UPDATE otp_flows SET last_issued_at=last_issued_at-interval '31 seconds' WHERE destination='+96170000666'; SET LOCAL session_replication_role=origin; INSERT INTO otp_challenges(flow_id,issuance_nonce,code_hash) SELECT id,decode(repeat('98',16),'hex'),decode(repeat('98',32),'hex') FROM active_otp_flows WHERE destination='+96170000666'; SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('99',32),'hex')) FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.destination='+96170000666' AND c.issuance_nonce=decode(repeat('99',16),'hex'); SELECT consume_otp_challenge(c.id,c.flow_id,decode(repeat('98',32),'hex')) FROM active_otp_challenges c JOIN active_otp_flows f ON f.id=c.flow_id WHERE f.destination='+96170000666' AND c.issuance_nonce=decode(repeat('98',16),'hex');")
        self.assertEqual(result,'OTP_EXPIRED\nOK')

    def test_45_bootstrap_rejects_occupied_database(self):
        result=run((ROOT/'schema.sql').read_text(encoding='utf-8'),check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Bootstrap requires an empty public schema',result.stderr)
        self.assertEqual(self.scalar("SELECT count(*) FROM pg_tables WHERE schemaname='public';"),'29')

    def test_46_preflight_is_read_only_and_classifies_numeric_schema(self):
        result=run((ROOT/'deployment/preflight.sql').read_text(encoding='utf-8'))
        self.assertIn('NUMERIC:',result.stdout)

    def test_47_legacy_preflight(self):
        legacy_db=DB+'_legacy'
        subprocess.run([createdb,'-h',args.host,'-p',args.port,'-U',args.user,legacy_db],check=True,env=ENV,capture_output=True)
        legacy_connection=[*CONNECTION]
        legacy_connection[legacy_connection.index('-d')+1]=legacy_db
        legacy_schema=(ROOT/'archive/initial-uuid-schema.sql').read_text(encoding='utf-8')
        result=subprocess.run([PSQL,*legacy_connection],input='BEGIN;\n'+legacy_schema+'\nCOMMIT;',text=True,encoding='utf-8',capture_output=True,env=ENV,timeout=35)
        self.assertEqual(result.returncode,0,result.stderr)
        result=subprocess.run([PSQL,*legacy_connection],input=(ROOT/'deployment/preflight.sql').read_text(encoding='utf-8'),text=True,encoding='utf-8',capture_output=True,env=ENV,timeout=35)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('LEGACY_UUID:',result.stdout)

    def test_48_concurrent_catalog_activation_and_translation_delete(self):
        category=int(self.scalar("BEGIN; INSERT INTO categories(slug,icon_key,is_active) VALUES('concurrent_catalog','home',FALSE) RETURNING id; INSERT INTO category_translations(category_id,language,name,description) SELECT id,'en','Concurrency fixture','English fallback' FROM categories WHERE slug='concurrent_catalog'; COMMIT;"))
        results=self.parallel([
            f"BEGIN; UPDATE categories SET is_active=TRUE WHERE id={category}; SELECT pg_sleep(0.2); COMMIT;",
            f"BEGIN; UPDATE category_translations SET deleted_at=clock_timestamp() WHERE category_id={category} AND language='en'; SELECT pg_sleep(0.2); COMMIT;"])
        self.assertEqual(sum(r[0]==0 for r in results),1,results)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM active_categories c WHERE id={category} AND is_active AND NOT EXISTS(SELECT 1 FROM active_category_translations t WHERE t.category_id=c.id AND language='en');"),'0')

    def test_49_primary_keys_and_creation_times_are_immutable(self):
        self.rejects(f"UPDATE categories SET id=DEFAULT WHERE id={ident('category')};")
        self.rejects(f"UPDATE users SET created_at=created_at-interval '1 day' WHERE id={ident('outsider')};")

    def test_50_customer_can_cancel_after_worker_account_deleted(self):
        # Establish committed history first; new links must have live parents at
        # their own commit, while later parent deletion preserves that history.
        request=int(self.scalar(f"INSERT INTO service_requests(worker_id,customer_id,scheduled_at) VALUES({ident('worker')},{ident('customer')},clock_timestamp()+interval '5 minutes') RETURNING id;"))
        self.scalar(f"UPDATE service_requests SET status='ACCEPTED',status_changed_by={ident('owner')} WHERE id={request};")
        self.valid(f"""DO $$ BEGIN
          UPDATE users SET deleted_at=clock_timestamp() WHERE id={ident('owner')};
          UPDATE service_requests SET status='CANCELLED',status_changed_by={ident('customer')} WHERE id={request};
          IF (SELECT status FROM service_requests WHERE id={request})<>'CANCELLED' THEN RAISE EXCEPTION 'Remaining participant cannot cancel'; END IF;
        END $$;""")

    def test_51_account_avatar_is_retained_and_tombstoned(self):
        self.valid(f"""DO $$ DECLARE f BIGINT; BEGIN
          INSERT INTO file_uploads(owner_user_id,purpose,bucket_name,object_key)
          VALUES({ident('customer')},'PROFILE_IMAGE','images','fixture/deleted-avatar.jpg') RETURNING id INTO f;
          UPDATE file_uploads SET status='READY',content_type='image/jpeg',size_bytes=100,sha256=decode(repeat('ad',32),'hex') WHERE id=f;
          UPDATE users SET profile_image_upload_id=f WHERE id={ident('customer')};
          UPDATE users SET deleted_at=clock_timestamp() WHERE id={ident('customer')};
          IF NOT EXISTS(SELECT 1 FROM file_uploads WHERE id=f AND deleted_at IS NOT NULL AND storage_deleted_at IS NULL) THEN
            RAISE EXCEPTION 'Avatar metadata/bytes were purged';
          END IF;
        END $$;""")

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SchemaTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report={'database':DB,'postgres':run('SELECT version();').stdout.strip(),'schema_sha256':hashlib.sha256((ROOT/'schema.sql').read_bytes()).hexdigest(),
            'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'successful':result.wasSuccessful()}
    (ROOT/'validation/latest-result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
