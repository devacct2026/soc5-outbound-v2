-- Seed fixed identities used by later test files (disposable DB only).
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-0000000000' || id)::uuid, email from (values
 ('a1','pic1@test'),('a2','pic2@test'),('b1','ops1@test'),('b2','ops2@test'),('c1','mm@test'),
 ('d1','doc@test'),('e1','admin@test'),('f1','pending@test'),('91','disabled@test'),('71','report@test')) v(id,email);
insert into profiles (id, role, email, account_status, is_admin, reporting_permission)
select ('00000000-0000-0000-0000-0000000000' || id)::uuid, role::user_role, email, st, adm, rep from (values
 ('a1','ops_pic','pic1@test','ACTIVE',false,false),
 ('a2','ops_pic','pic2@test','ACTIVE',false,false),
 ('b1','fte_ops','ops1@test','ACTIVE',false,false),
 ('b2','fte_ops','ops2@test','ACTIVE',false,false),
 ('c1','fte_mm','mm@test','ACTIVE',false,false),
 ('d1','doc_officer','doc@test','ACTIVE',false,false),
 ('e1','fte_ops','admin@test','ACTIVE',true,false),
 ('f1',null,'pending@test','PENDING_APPROVAL',false,false),
 ('91','ops_pic','disabled@test','DISABLED',false,false),
 ('71','doc_officer','report@test','ACTIVE',false,true)) v(id,role,email,st,adm,rep);
