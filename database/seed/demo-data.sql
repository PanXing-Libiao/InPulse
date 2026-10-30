--
-- InPulse 演示种子数据（自动生成，请勿手工编辑）
--
-- 由 scripts/export-demo-seed.mjs 从演示库导出，只包含业务数据：
--   * 不含登录会话、CSRF、幂等记录、限流桶、恢复码（运行痕迹）
--   * 含项目审计链：项目动态的来源外键指向它，缺了就无法载入
--   * 不含演示账号的口令哈希，口令列是固定占位值，载入时由 db:seed:demo 统一重置为演示口令
--   * 表顺序是父到子的载入顺序，请勿调整
-- 载入方式：pnpm db:seed:demo（会顺带把演示账号口令重置为演示口令）
--
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: users; Type: TABLE DATA; Schema: app
--

COPY app.users (id, login_name, name, email, avatar_url, password_hash, is_admin, status, auth_version, row_version, password_changed_at, disabled_at, created_at, updated_at, sso_subject, deleted_at) FROM stdin;
2	member	Dev Member	\N	\N	$argon2id$seed-demo-placeholder	f	ACTIVE	1	1	2026-09-10 16:02:58.683013+08	\N	2026-09-10 16:02:58.683013+08	2026-09-10 16:02:58.683013+08	\N	\N
1	dev	Dev Admin	\N	\N	$argon2id$seed-demo-placeholder	t	ACTIVE	2	2	2026-10-26 13:12:04.086128+08	\N	2026-09-10 16:01:26.070288+08	2026-10-26 13:12:04.086128+08	\N	\N
3	shaochenyu	邵晨宇	shaochenyu@libiaorobot.com	\N	$argon2id$seed-demo-placeholder	t	ACTIVE	1	2	2026-09-21 08:56:45.609567+08	\N	2026-09-21 08:56:45.609567+08	2026-10-26 13:14:44.268594+08	8f8a9897-610c-4a0e-ad07-e276ff6fb5b5	\N
\.

--
-- Data for Name: projects; Type: TABLE DATA; Schema: app
--

COPY app.projects (id, code, name, description, created_by, status, row_version, created_at, updated_at, archived_at, first_task_completed_at, created_by_snapshot) FROM stdin;
4	SHOP2	SHOP	2222	1	NOT_STARTED	1	2026-09-10 16:23:46.354695+08	2026-09-10 16:23:46.354695+08	\N	\N	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
5	RCS	RCS	RCS调度	2	NOT_STARTED	1	2026-09-14 09:26:42.898378+08	2026-09-14 09:26:42.898378+08	\N	\N	{"id": 2, "name": "Dev Member", "loginName": "member"}
1	SHOP	商品系统	123	1	ACTIVE	2	2026-09-10 16:23:15.34365+08	2026-10-28 16:50:42.789603+08	\N	2026-10-28 16:50:42.808+08	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
\.

--
-- Data for Name: project_members; Type: TABLE DATA; Schema: app
--

COPY app.project_members (id, project_id, user_id, status, joined_at, removed_at, role, user_snapshot) FROM stdin;
2	1	2	ACTIVE	2026-09-10 16:23:15.34365+08	\N	MEMBER	{"id": 2, "name": "Dev Member", "loginName": "member"}
4	4	2	ACTIVE	2026-09-10 16:23:46.354695+08	\N	MEMBER	{"id": 2, "name": "Dev Member", "loginName": "member"}
5	5	1	ACTIVE	2026-09-14 09:26:42.898378+08	\N	MEMBER	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
1	1	1	ACTIVE	2026-09-10 16:23:15.34365+08	\N	LEADER	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
3	4	1	ACTIVE	2026-09-10 16:23:46.354695+08	\N	LEADER	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
6	5	2	ACTIVE	2026-09-14 09:26:42.898378+08	\N	LEADER	{"id": 2, "name": "Dev Member", "loginName": "member"}
7	1	3	ACTIVE	2026-10-28 16:50:23.446648+08	\N	MEMBER	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
\.

--
-- Data for Name: audit_chain_heads; Type: TABLE DATA; Schema: app
--

COPY app.audit_chain_heads (chain_id, project_id, last_sequence, last_hash, key_version, updated_at) FROM stdin;
PROJECT:4	4	1	\\xb109eabb03312600948df231884a8c1003822df80384498cbdc423d11cac415c	1	2026-09-10 16:23:46.361841+08
PROJECT:5	5	1	\\x38cdeaff1b1a92e7b232ec6f2aba3fa855f31fa3351600c8baa51f5b756c6a33	1	2026-09-14 09:26:42.975474+08
PROJECT:1	1	15	\\xf906d05158f71f990e7a2176edf2f3fee5ded6c839e0f43b2dee204915311a2d	1	2026-10-28 16:58:28.219192+08
SYSTEM	\N	32	\\x91926881988df8203f62cb99907a9691601a9892b2f1f93cd0683ff6acd30b13	1	2026-10-30 13:23:46.653695+08
\.

--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: app
--

COPY app.audit_logs (chain_id, sequence_no, project_id, actor_type, actor_id, action, target_type, target_id, event_payload, request_id, client_request_id, ip_address, user_agent, occurred_at, prev_hash, record_hash, key_version, canonical_version) FROM stdin;
PROJECT:1	1	1	USER	1	project.create	PROJECT	1	{"code": "SHOP", "name": "商品系统", "action": "project.create", "actorId": 1, "targetId": "1", "actorType": "USER", "ipAddress": null, "requestId": "project-bootstrap:1", "userAgent": null, "occurredAt": "2026-09-10T08:23:15.350Z", "targetType": "PROJECT", "description": "123", "clientRequestId": null}	project-bootstrap:1	\N	\N	\N	2026-09-10 16:23:15.35+08	\\x0000000000000000000000000000000000000000000000000000000000000000	\\xfc75bf4b60d349b40fb8c2b13197125c48c59580d2d806bbcb416445758e6946	1	JCS-1
PROJECT:4	1	4	USER	1	project.create	PROJECT	4	{"code": "SHOP2", "name": "SHOP", "action": "project.create", "actorId": 1, "targetId": "4", "actorType": "USER", "ipAddress": null, "requestId": "project-bootstrap:4", "userAgent": null, "occurredAt": "2026-09-10T08:23:46.358Z", "targetType": "PROJECT", "description": "2222", "clientRequestId": null}	project-bootstrap:4	\N	\N	\N	2026-09-10 16:23:46.358+08	\\x0000000000000000000000000000000000000000000000000000000000000000	\\xb109eabb03312600948df231884a8c1003822df80384498cbdc423d11cac415c	1	JCS-1
PROJECT:1	2	1	USER	1	module.create	MODULE	3	{"after": {"id": 3, "kind": "NORMAL", "name": "交易模块", "status": "ACTIVE", "createdAt": "2026-09-10T08:46:10.454Z", "projectId": 1, "sortOrder": 0, "updatedAt": "2026-09-10T08:46:10.454Z", "archivedAt": null, "rowVersion": 1, "description": "222"}, "action": "module.create", "before": null, "reason": null, "actorId": 1, "targetId": "3", "actorType": "USER", "ipAddress": null, "requestId": "07f49811-b693-4f21-a30e-95cbff24df33", "userAgent": null, "occurredAt": "2026-09-10T08:46:10.456Z", "targetType": "MODULE", "clientRequestId": null}	07f49811-b693-4f21-a30e-95cbff24df33	\N	\N	\N	2026-09-10 16:46:10.456+08	\\xfc75bf4b60d349b40fb8c2b13197125c48c59580d2d806bbcb416445758e6946	\\xa7e60f50a8cd39d5abd353c9d5db8a701530d72915274cf4140d01b47b35c526	1	JCS-1
PROJECT:1	3	1	USER	1	module.update	MODULE	1	{"after": {"id": 1, "kind": "UNCLASSIFIED", "name": "未分类模块", "status": "ACTIVE", "createdAt": "2026-09-10T08:23:15.343Z", "projectId": 1, "sortOrder": 0, "updatedAt": "2026-09-10T08:50:11.615Z", "archivedAt": null, "rowVersion": 2, "description": ""}, "action": "module.update", "before": {"id": 1, "kind": "UNCLASSIFIED", "name": "未分类模块", "status": "ACTIVE", "createdAt": "2026-09-10T08:23:15.343Z", "projectId": 1, "sortOrder": 0, "updatedAt": "2026-09-10T08:23:15.343Z", "archivedAt": null, "rowVersion": 1, "description": ""}, "reason": null, "actorId": 1, "targetId": "1", "actorType": "USER", "ipAddress": null, "requestId": "b957cb36-addb-4957-9c5c-b18279e7578a", "userAgent": null, "occurredAt": "2026-09-10T08:50:11.621Z", "targetType": "MODULE", "clientRequestId": null}	b957cb36-addb-4957-9c5c-b18279e7578a	\N	\N	\N	2026-09-10 16:50:11.621+08	\\xa7e60f50a8cd39d5abd353c9d5db8a701530d72915274cf4140d01b47b35c526	\\xe5e9c00b496aa8f6a654c2880525ee553c089f27b5784d8cd83893dfa72df12a	1	JCS-1
PROJECT:1	4	1	USER	1	feature.create	FEATURE	1	{"after": {"id": 1, "code": "SHOP-F-1", "name": "微信支付模块", "tags": ["222"], "status": "ACTIVE", "moduleId": 3, "createdAt": "2026-09-10T08:51:43.021Z", "createdBy": 1, "projectId": 1, "updatedAt": "2026-09-10T08:51:43.021Z", "archivedAt": null, "rowVersion": 1, "currentBehavior": "122122"}, "action": "feature.create", "before": null, "reason": null, "actorId": 1, "targetId": "1", "actorType": "USER", "ipAddress": null, "requestId": "6edfe449-a49f-45a8-b6a0-853e078c14c6", "userAgent": null, "occurredAt": "2026-09-10T08:51:43.029Z", "targetType": "FEATURE", "clientRequestId": null}	6edfe449-a49f-45a8-b6a0-853e078c14c6	\N	\N	\N	2026-09-10 16:51:43.03+08	\\xe5e9c00b496aa8f6a654c2880525ee553c089f27b5784d8cd83893dfa72df12a	\\xab1df1ea20e89ecffedf964815af5a50e83c8f26c313b16a4714963387a11bd0	1	JCS-1
PROJECT:1	5	1	USER	1	task.create	TASK	1	{"after": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-09-10T08:52:43.167Z", "assigneeId": 1, "rowVersion": 1, "workStatus": "TODO", "description": "3333", "lifecycleStatus": "ACTIVE"}, "action": "task.create", "before": null, "actorId": 1, "targetId": "1", "actorType": "USER", "ipAddress": null, "requestId": "aef7c9d3-9f4a-43cf-93a6-e9165efc1f6d", "userAgent": null, "occurredAt": "2026-09-10T08:52:43.178Z", "targetType": "TASK", "clientRequestId": null}	aef7c9d3-9f4a-43cf-93a6-e9165efc1f6d	\N	\N	\N	2026-09-10 16:52:43.178+08	\\xab1df1ea20e89ecffedf964815af5a50e83c8f26c313b16a4714963387a11bd0	\\xd0e00673e7145dcfe03ba89117585a415027a43a3243b46cbc9ba84c5183fe3c	1	JCS-1
PROJECT:1	6	1	USER	1	task.create	TASK	2	{"added": [1], "after": {"id": 2, "code": "SHOP-T-2", "dueAt": null, "title": "支付方式", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T09:58:36.690Z", "creatorId": 1, "featureId": null, "projectId": 1, "scopeType": "MODULE", "updatedAt": "2026-09-10T09:58:36.690Z", "assigneeId": 2, "rowVersion": 1, "workStatus": "TODO", "description": "222", "lifecycleStatus": "ACTIVE", "impactFeatureIds": [1]}, "action": "task.create", "before": null, "actorId": 1, "removed": [], "targetId": "2", "actorType": "USER", "ipAddress": null, "requestId": "adf7d143-350a-4d2b-bdfe-4f3cb1c8ea5f", "userAgent": null, "occurredAt": "2026-09-10T09:58:36.702Z", "targetType": "TASK", "impactsAfter": [{"taskId": 2, "moduleId": 3, "createdAt": "2026-09-10T09:58:36.690Z", "featureId": 1, "projectId": 1, "relationType": "IMPACT"}], "impactsBefore": [], "clientRequestId": null}	adf7d143-350a-4d2b-bdfe-4f3cb1c8ea5f	\N	\N	\N	2026-09-10 17:58:36.702+08	\\xd0e00673e7145dcfe03ba89117585a415027a43a3243b46cbc9ba84c5183fe3c	\\xbc8c66ae29fba3eb016d58db635459f8637869802c2a0e2f6d438e007c667461	1	JCS-1
PROJECT:5	1	5	USER	2	project.create	PROJECT	5	{"code": "RCS", "name": "RCS", "action": "project.create", "actorId": 2, "targetId": "5", "actorType": "USER", "ipAddress": null, "requestId": "project-bootstrap:5", "userAgent": null, "occurredAt": "2026-09-14T01:26:42.934Z", "targetType": "PROJECT", "description": "RCS调度", "clientRequestId": null}	project-bootstrap:5	\N	\N	\N	2026-09-14 09:26:42.934+08	\\x0000000000000000000000000000000000000000000000000000000000000000	\\x38cdeaff1b1a92e7b232ec6f2aba3fa855f31fa3351600c8baa51f5b756c6a33	1	JCS-1
SYSTEM	1	\N	USER	1	AUDIT_LOG_READ	AUDIT_CHAIN	SYSTEM	{"action": "AUDIT_LOG_READ", "actorId": 1, "chainId": "SYSTEM", "filters": {"to": null, "from": null, "action": null, "actorId": null}, "hasMore": false, "targetId": "SYSTEM", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "57079305-c60e-45aa-89d3-96cc1d502ac6", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0", "occurredAt": "2026-09-14T01:33:34.886Z", "targetType": "AUDIT_CHAIN", "returnedCount": 0, "clientRequestId": null}	57079305-c60e-45aa-89d3-96cc1d502ac6	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0	2026-09-14 09:33:34.886+08	\\x0000000000000000000000000000000000000000000000000000000000000000	\\x5598da8722cb3dac3133ab6b773048219cb9244e8cbacdfbf2514691c1b4c9b4	1	JCS-1
PROJECT:1	7	1	USER	1	module.update	MODULE	3	{"after": {"id": 3, "kind": "NORMAL", "name": "交易模块", "stats": {"openTaskCount": 2, "activeFeatureCount": 1}, "status": "ACTIVE", "createdAt": "2026-09-10T08:46:10.454Z", "projectId": 1, "sortOrder": 0, "updatedAt": "2026-09-14T01:47:44.434Z", "archivedAt": null, "rowVersion": 2, "description": "222333"}, "action": "module.update", "before": {"id": 3, "kind": "NORMAL", "name": "交易模块", "stats": {"openTaskCount": 2, "activeFeatureCount": 1}, "status": "ACTIVE", "createdAt": "2026-09-10T08:46:10.454Z", "projectId": 1, "sortOrder": 0, "updatedAt": "2026-09-10T08:46:10.454Z", "archivedAt": null, "rowVersion": 1, "description": "222"}, "reason": null, "actorId": 1, "targetId": "3", "actorType": "USER", "ipAddress": null, "requestId": "8f3ea050-47ee-4e00-881d-be8e2d280e27", "userAgent": null, "occurredAt": "2026-09-14T01:47:44.484Z", "targetType": "MODULE", "clientRequestId": null}	8f3ea050-47ee-4e00-881d-be8e2d280e27	\N	\N	\N	2026-09-14 09:47:44.484+08	\\xbc8c66ae29fba3eb016d58db635459f8637869802c2a0e2f6d438e007c667461	\\x199ca003c53f75b582fe85f2aa8b49e42795a0f81637eb4b97cfb3a6d7dea440	1	JCS-1
PROJECT:1	8	1	USER	1	feature.update	FEATURE	1	{"after": {"id": 1, "code": "SHOP-F-1", "name": "微信支付模块", "tags": ["222"], "stats": {"recordCount": 0, "openTaskCount": 2}, "status": "ACTIVE", "moduleId": 3, "createdAt": "2026-09-10T08:51:43.021Z", "createdBy": 1, "projectId": 1, "updatedAt": "2026-09-14T01:51:43.864Z", "archivedAt": null, "rowVersion": 2, "currentBehavior": "122122"}, "action": "feature.update", "before": {"id": 1, "code": "SHOP-F-1", "name": "微信支付模块", "tags": ["222"], "stats": {"recordCount": 0, "openTaskCount": 2}, "status": "ACTIVE", "moduleId": 3, "createdAt": "2026-09-10T08:51:43.021Z", "createdBy": 1, "projectId": 1, "updatedAt": "2026-09-10T08:51:43.021Z", "archivedAt": null, "rowVersion": 1, "currentBehavior": "122122"}, "reason": null, "actorId": 1, "targetId": "1", "actorType": "USER", "ipAddress": null, "requestId": "568018c8-115d-4b61-b949-ffefa3903c64", "userAgent": null, "occurredAt": "2026-09-14T01:51:43.904Z", "targetType": "FEATURE", "clientRequestId": null}	568018c8-115d-4b61-b949-ffefa3903c64	\N	\N	\N	2026-09-14 09:51:43.905+08	\\x199ca003c53f75b582fe85f2aa8b49e42795a0f81637eb4b97cfb3a6d7dea440	\\xd90a57ab12f7d58cdc45966134636d6d9614fc468ac0d1f43c32d693a5b57b97	1	JCS-1
SYSTEM	2	\N	USER	3	auth.sso_account_provisioned	USER	3	{"action": "auth.sso_account_provisioned", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "47baa009-dcd4-49e0-882d-86d8d721466b", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", "occurredAt": "2026-09-21T00:56:45.628Z", "targetType": "USER", "clientRequestId": null}	47baa009-dcd4-49e0-882d-86d8d721466b	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36	2026-09-21 08:56:45.629+08	\\x5598da8722cb3dac3133ab6b773048219cb9244e8cbacdfbf2514691c1b4c9b4	\\x796cb3ff7733b3107b98ff5c8c52605ff57a676be03b8e14810a9bf4832bfba2	1	JCS-1
SYSTEM	3	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "provisioned", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "47baa009-dcd4-49e0-882d-86d8d721466b", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36", "occurredAt": "2026-09-21T00:56:45.638Z", "targetType": "USER", "clientRequestId": null}	47baa009-dcd4-49e0-882d-86d8d721466b	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36	2026-09-21 08:56:45.638+08	\\x796cb3ff7733b3107b98ff5c8c52605ff57a676be03b8e14810a9bf4832bfba2	\\x12be142b1cad71c11dc9bf395cd52a83362fd9854104b018548568dacb6d5fef	1	JCS-1
SYSTEM	4	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "dcf51d34-db3c-4a1c-9fc7-8227cdf5f3d3", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0", "occurredAt": "2026-09-23T01:08:58.151Z", "targetType": "USER", "clientRequestId": null}	dcf51d34-db3c-4a1c-9fc7-8227cdf5f3d3	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0	2026-09-23 09:08:58.151+08	\\x12be142b1cad71c11dc9bf395cd52a83362fd9854104b018548568dacb6d5fef	\\xf71bea665389327205a566aef117d3d841e1340acf901e0c6ae0b4779e87c14f	1	JCS-1
SYSTEM	5	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "bac2f84c-cdc2-40de-afce-7da8d29b0634", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0", "occurredAt": "2026-09-24T01:09:52.673Z", "targetType": "USER", "clientRequestId": null}	bac2f84c-cdc2-40de-afce-7da8d29b0634	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0	2026-09-24 09:09:52.674+08	\\xf71bea665389327205a566aef117d3d841e1340acf901e0c6ae0b4779e87c14f	\\xa72c9db0722e81eeea9677864df450d4fb9a680ef4b5f5b43686655a9b91ef81	1	JCS-1
SYSTEM	6	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "fd38d591-a599-4e5f-a2de-90085854a900", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0", "occurredAt": "2026-09-29T00:56:05.439Z", "targetType": "USER", "clientRequestId": null}	fd38d591-a599-4e5f-a2de-90085854a900	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0	2026-09-29 08:56:05.439+08	\\xa72c9db0722e81eeea9677864df450d4fb9a680ef4b5f5b43686655a9b91ef81	\\x7d2a21ce4c98010b010544e46846f0797deee1a238e59581d30c35704012995f	1	JCS-1
SYSTEM	7	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "ce0aa8a9-55df-4cf6-998e-4ad37f2ed0a5", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0", "occurredAt": "2026-09-30T01:02:56.988Z", "targetType": "USER", "clientRequestId": null}	ce0aa8a9-55df-4cf6-998e-4ad37f2ed0a5	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0	2026-09-30 09:02:56.988+08	\\x7d2a21ce4c98010b010544e46846f0797deee1a238e59581d30c35704012995f	\\xc6d2e57bf33620999f13a074babe34e3f1cfe6a482d6313822073564d4d4070a	1	JCS-1
SYSTEM	8	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "1c3f2121-ddb2-4ab1-8005-c6f1084a8335", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:02:58.295Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 1}	1c3f2121-ddb2-4ab1-8005-c6f1084a8335	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:02:58.295+08	\\xc6d2e57bf33620999f13a074babe34e3f1cfe6a482d6313822073564d4d4070a	\\x29412316de4d1242c10856c54079ea6bf48a519754842dc74525411fd77d1210	1	JCS-1
SYSTEM	9	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "1c3f2121-ddb2-4ab1-8005-c6f1084a8335", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:02:58.311Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	1c3f2121-ddb2-4ab1-8005-c6f1084a8335	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:02:58.311+08	\\x29412316de4d1242c10856c54079ea6bf48a519754842dc74525411fd77d1210	\\x4742217997f35e5b34659bbc26621b273a4a6a4f907ca63de5ce81bb0eea3fb8	1	JCS-1
SYSTEM	10	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "6034f959-4995-49a1-96ff-0bd324837982", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:03:53.401Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	6034f959-4995-49a1-96ff-0bd324837982	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:03:53.401+08	\\x4742217997f35e5b34659bbc26621b273a4a6a4f907ca63de5ce81bb0eea3fb8	\\x23c6ec53b008a5a7e44255b0cb99898e6535d8b5094add102df1b83d3555bfed	1	JCS-1
SYSTEM	11	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "6034f959-4995-49a1-96ff-0bd324837982", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:03:53.408Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	6034f959-4995-49a1-96ff-0bd324837982	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:03:53.408+08	\\x23c6ec53b008a5a7e44255b0cb99898e6535d8b5094add102df1b83d3555bfed	\\x656a8411d3ce9469532977046c4230fda35f503d5d24e16e144d29fa6d25e392	1	JCS-1
SYSTEM	12	\N	USER	1	admin.user.update	USER	3	{"after": {"id": 3, "name": "邵晨宇", "email": "shaochenyu@libiaorobot.com", "status": "ACTIVE", "isAdmin": true, "avatarUrl": null, "deletedAt": null, "loginName": "shaochenyu", "rowVersion": 2, "managedBySso": true, "openTaskCount": 0, "organizations": [{"id": 1, "name": "测试部", "source": "CASDOOR", "groupPath": "libiaorobot.com/测试部"}]}, "action": "admin.user.update", "before": {"id": 3, "name": "邵晨宇", "email": "shaochenyu@libiaorobot.com", "status": "ACTIVE", "isAdmin": false, "avatarUrl": null, "deletedAt": null, "loginName": "shaochenyu", "rowVersion": 1, "managedBySso": true, "openTaskCount": 0, "organizations": [{"id": 1, "name": "测试部", "source": "CASDOOR", "groupPath": "libiaorobot.com/测试部"}]}, "actorId": 1, "targetId": "3", "actorType": "USER", "ipAddress": null, "requestId": "8d7f038e-d55f-489b-bd48-08c2ba2d612d", "userAgent": null, "occurredAt": "2026-10-26T05:14:44.296Z", "targetType": "USER", "actorSnapshot": {"id": 1, "name": "Dev Admin", "loginName": "dev"}, "clientRequestId": null}	8d7f038e-d55f-489b-bd48-08c2ba2d612d	\N	\N	\N	2026-10-26 13:14:44.296+08	\\x656a8411d3ce9469532977046c4230fda35f503d5d24e16e144d29fa6d25e392	\\x447985dad88ce54f3ef93baaadf1fb6d9ad0e8f7327e721c9c569bac7af8b8a5	1	JCS-1
SYSTEM	13	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "20548dce-ef91-4d13-acbc-54511687a3ca", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:15:21.805Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 1}	20548dce-ef91-4d13-acbc-54511687a3ca	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:15:21.806+08	\\x447985dad88ce54f3ef93baaadf1fb6d9ad0e8f7327e721c9c569bac7af8b8a5	\\x9c009054fe90685950ef5b59605addaf2a2071960de47d2fb77cef3032590f7b	1	JCS-1
SYSTEM	14	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "20548dce-ef91-4d13-acbc-54511687a3ca", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:15:21.809Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	20548dce-ef91-4d13-acbc-54511687a3ca	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:15:21.809+08	\\x9c009054fe90685950ef5b59605addaf2a2071960de47d2fb77cef3032590f7b	\\x56436c8f7de4b2a34c00da56f05d4cecc4bd1f06e6c142a7164ea016da97171e	1	JCS-1
SYSTEM	26	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "b84c1fc5-1059-4955-a208-567a551a9bda", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T01:30:26.560Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	b84c1fc5-1059-4955-a208-567a551a9bda	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 09:30:26.56+08	\\x71849b4a81a9b2e419fe30366063cae7f08de09ef9786f8ba7f6b9cb02c3bdb9	\\xf096527aeb35c382264419d67b704f7483b5ad5a54b2851f88b9dfb95c64c38e	1	JCS-1
SYSTEM	15	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "8e95841e-2f40-466e-9f80-ecaa29cc3930", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:16:12.611Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	8e95841e-2f40-466e-9f80-ecaa29cc3930	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:16:12.611+08	\\x56436c8f7de4b2a34c00da56f05d4cecc4bd1f06e6c142a7164ea016da97171e	\\x415811e6149674728a99f8cda7901160c3dcb18dc959d61cc7108324b394cb16	1	JCS-1
SYSTEM	16	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "8e95841e-2f40-466e-9f80-ecaa29cc3930", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T05:16:12.625Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	8e95841e-2f40-466e-9f80-ecaa29cc3930	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 13:16:12.626+08	\\x415811e6149674728a99f8cda7901160c3dcb18dc959d61cc7108324b394cb16	\\x71e0ea2a93dbd801b40c989ca5cb5f4ad838cc0d1a3a177815472dc93933ff8a	1	JCS-1
SYSTEM	17	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "aa529888-ca4c-4966-9f29-c4642759a796", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T07:49:17.763Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	aa529888-ca4c-4966-9f29-c4642759a796	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 15:49:17.764+08	\\x71e0ea2a93dbd801b40c989ca5cb5f4ad838cc0d1a3a177815472dc93933ff8a	\\x43e46ec4566894744c41a8c6e6202775bf24e5f30fff9321d53bb3bf495b83be	1	JCS-1
SYSTEM	18	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "aa529888-ca4c-4966-9f29-c4642759a796", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0", "groupCount": 1, "occurredAt": "2026-10-26T07:49:17.777Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	aa529888-ca4c-4966-9f29-c4642759a796	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0	2026-10-26 15:49:17.778+08	\\x43e46ec4566894744c41a8c6e6202775bf24e5f30fff9321d53bb3bf495b83be	\\xa9ea210e829a153b4618c8b562eeff4f98ded0f62211a5c7d9c583dc810822dd	1	JCS-1
SYSTEM	19	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "75ec5292-1916-40ec-bce7-124e482806c5", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-28T07:22:39.857Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 1}	75ec5292-1916-40ec-bce7-124e482806c5	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 15:22:39.857+08	\\xa9ea210e829a153b4618c8b562eeff4f98ded0f62211a5c7d9c583dc810822dd	\\x31decae023b6a4bfc07dcc0e6303048e72e174a035e6ae6e2cb41dcbc47554da	1	JCS-1
SYSTEM	20	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "75ec5292-1916-40ec-bce7-124e482806c5", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-28T07:22:39.883Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	75ec5292-1916-40ec-bce7-124e482806c5	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 15:22:39.883+08	\\x31decae023b6a4bfc07dcc0e6303048e72e174a035e6ae6e2cb41dcbc47554da	\\xdc99e424751c595c3bb0f6e7d3212826a958b28b3c1df58bb8a736d2cb71b507	1	JCS-1
PROJECT:1	9	1	USER	3	project.wecomGroup.webhook.create	PROJECT_WECOM_GROUP	1	{"label": "test", "action": "project.wecomGroup.webhook.create", "actorId": 3, "urlHint": "4c05", "targetId": "1", "actorType": "USER", "ipAddress": "127.0.0.1", "projectId": 1, "requestId": "4a26ac5a-2968-4852-b2c7-6304e2a455da", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:50:08.029Z", "targetType": "PROJECT_WECOM_GROUP", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "webhookBindingId": 1}	4a26ac5a-2968-4852-b2c7-6304e2a455da	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:50:08.029+08	\\xd90a57ab12f7d58cdc45966134636d6d9614fc468ac0d1f43c32d693a5b57b97	\\x0089e21926f87096ae7ac0199224c246a2c18e2da9a785f5b7ccdc4f96db07de	1	JCS-1
PROJECT:1	10	1	USER	3	project.member.add	USER	3	{"role": "MEMBER", "action": "project.member.add", "userId": 3, "actorId": 3, "joinedAt": "2026-10-28T08:50:23.446Z", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "projectId": 1, "requestId": "e21386af-a9c3-4404-b087-c024e3d79657", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:50:23.486Z", "targetType": "USER", "membershipId": 7, "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null}	e21386af-a9c3-4404-b087-c024e3d79657	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:50:23.486+08	\\x0089e21926f87096ae7ac0199224c246a2c18e2da9a785f5b7ccdc4f96db07de	\\x048b84744556e3716ec4a13ad1241c73d770fe58007623dfa91e3cfa0238ee8e	1	JCS-1
PROJECT:1	11	1	USER	3	task.status	TASK	1	{"mode": "WITHOUT_RECORD", "after": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:50:42.808Z", "assigneeId": 1, "rowVersion": 2, "workStatus": "DONE", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "action": "task.status", "before": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-09-10T08:52:43.167Z", "assigneeId": 1, "rowVersion": 1, "workStatus": "TODO", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "actorId": 3, "targetId": "1", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "df612ebf-824e-449b-a449-b10476f154e9", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:50:42.812Z", "targetType": "TASK", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "completionNote": "测试验证，不涉及功能变化", "clientRequestId": null}	df612ebf-824e-449b-a449-b10476f154e9	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:50:42.812+08	\\x048b84744556e3716ec4a13ad1241c73d770fe58007623dfa91e3cfa0238ee8e	\\x088d7beb60568acc6a2cdc811ab3053b17901ae7dc77f8ea3d044ad01c5b71c0	1	JCS-1
PROJECT:1	12	1	USER	3	project.status.change	PROJECT	1	{"after": {"status": "ACTIVE"}, "action": "project.status.change", "before": {"status": "NOT_STARTED"}, "taskId": 1, "actorId": 3, "trigger": "TASK_COMPLETED", "targetId": "1", "actorType": "USER", "automatic": true, "ipAddress": "127.0.0.1", "requestId": "df612ebf-824e-449b-a449-b10476f154e9", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:50:42.808Z", "targetType": "PROJECT", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null}	df612ebf-824e-449b-a449-b10476f154e9	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:50:42.808+08	\\x088d7beb60568acc6a2cdc811ab3053b17901ae7dc77f8ea3d044ad01c5b71c0	\\x7985701526e54b1e104db104fc6ee2300bf29d5c309f7e354495b3b08d4c99d2	1	JCS-1
PROJECT:1	13	1	USER	3	task.status	TASK	1	{"after": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:51:00.259Z", "assigneeId": 1, "rowVersion": 3, "workStatus": "TODO", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "action": "task.status", "before": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:50:42.808Z", "assigneeId": 1, "rowVersion": 2, "workStatus": "DONE", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "actorId": 3, "command": {"action": "REOPEN", "reason": null}, "targetId": "1", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "5781e84b-201a-4fb7-ad46-4bee5e95d4d1", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:51:00.269Z", "targetType": "TASK", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "completionNote": null, "clientRequestId": null}	5781e84b-201a-4fb7-ad46-4bee5e95d4d1	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:51:00.269+08	\\x7985701526e54b1e104db104fc6ee2300bf29d5c309f7e354495b3b08d4c99d2	\\x7eb72e915c0b7da019fe5e39182dec019eb8cb61562ef67c252bd74c508d025a	1	JCS-1
PROJECT:1	14	1	USER	3	task.status	TASK	1	{"mode": "WITHOUT_RECORD", "after": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:58:12.069Z", "assigneeId": 1, "rowVersion": 4, "workStatus": "DONE", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "action": "task.status", "before": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:51:00.259Z", "assigneeId": 1, "rowVersion": 3, "workStatus": "TODO", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "actorId": 3, "targetId": "1", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "10bc118f-0ec4-412e-aa0a-eabf81cbf300", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:58:12.077Z", "targetType": "TASK", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "completionNote": "测试验证，不涉及功能变化", "clientRequestId": null}	10bc118f-0ec4-412e-aa0a-eabf81cbf300	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:58:12.078+08	\\x7eb72e915c0b7da019fe5e39182dec019eb8cb61562ef67c252bd74c508d025a	\\xe2a3c13698f9ec3e56818f43ece7fc80c7a546bb59280e354a1334af27f7a492	1	JCS-1
PROJECT:1	15	1	USER	3	task.status	TASK	1	{"after": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:58:28.203Z", "assigneeId": 1, "rowVersion": 5, "workStatus": "TODO", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "action": "task.status", "before": {"id": 1, "code": "SHOP-T-1", "dueAt": "2026-09-10T08:52:00.000Z", "title": "支付接入", "moduleId": 3, "priority": "NORMAL", "createdAt": "2026-09-10T08:52:43.167Z", "creatorId": 1, "featureId": 1, "projectId": 1, "scopeType": "FEATURE", "updatedAt": "2026-10-28T08:58:12.069Z", "assigneeId": 1, "rowVersion": 4, "workStatus": "DONE", "assigneeIds": [1], "creatorName": "Dev Admin", "description": "3333", "assigneeNames": ["Dev Admin"], "lifecycleStatus": "ACTIVE"}, "actorId": 3, "command": {"action": "REOPEN", "reason": null}, "targetId": "1", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "100b7f02-03dc-4adb-9e40-6cbb8b292483", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "occurredAt": "2026-10-28T08:58:28.215Z", "targetType": "TASK", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "completionNote": null, "clientRequestId": null}	100b7f02-03dc-4adb-9e40-6cbb8b292483	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 16:58:28.215+08	\\xe2a3c13698f9ec3e56818f43ece7fc80c7a546bb59280e354a1334af27f7a492	\\xf906d05158f71f990e7a2176edf2f3fee5ded6c839e0f43b2dee204915311a2d	1	JCS-1
SYSTEM	21	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "3835599d-b007-438c-9ae2-0122b2cd273f", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-28T09:27:15.099Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	3835599d-b007-438c-9ae2-0122b2cd273f	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 17:27:15.099+08	\\xdc99e424751c595c3bb0f6e7d3212826a958b28b3c1df58bb8a736d2cb71b507	\\x1deee1d02c4548bef36855b85517267d772bdd17c5f5b9ca6f7d343bfc477946	1	JCS-1
SYSTEM	22	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "3835599d-b007-438c-9ae2-0122b2cd273f", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-28T09:27:15.109Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	3835599d-b007-438c-9ae2-0122b2cd273f	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-28 17:27:15.109+08	\\x1deee1d02c4548bef36855b85517267d772bdd17c5f5b9ca6f7d343bfc477946	\\x8df078f80c8e63d1b9dc6937e086473aec59631b7005ee97d94186988dcfc89d	1	JCS-1
SYSTEM	23	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "367ef7db-cc96-438c-9fe2-9ef08111af88", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-29T06:26:17.008Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	367ef7db-cc96-438c-9fe2-9ef08111af88	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-29 14:26:17.009+08	\\x8df078f80c8e63d1b9dc6937e086473aec59631b7005ee97d94186988dcfc89d	\\x76b3fdaafd3ad920e4e07ca7fcade6e8d92184f780435755fc75f1baac4a1b46	1	JCS-1
SYSTEM	24	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "367ef7db-cc96-438c-9fe2-9ef08111af88", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-29T06:26:17.030Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	367ef7db-cc96-438c-9fe2-9ef08111af88	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-29 14:26:17.031+08	\\x76b3fdaafd3ad920e4e07ca7fcade6e8d92184f780435755fc75f1baac4a1b46	\\xd8fb0e2acc2ea1004a13fe55d52240ea089b2043ec12c77a47f052b0b3ed6d32	1	JCS-1
SYSTEM	25	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "b84c1fc5-1059-4955-a208-567a551a9bda", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T01:30:26.543Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	b84c1fc5-1059-4955-a208-567a551a9bda	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 09:30:26.543+08	\\xd8fb0e2acc2ea1004a13fe55d52240ea089b2043ec12c77a47f052b0b3ed6d32	\\x71849b4a81a9b2e419fe30366063cae7f08de09ef9786f8ba7f6b9cb02c3bdb9	1	JCS-1
SYSTEM	27	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "88faa748-0e13-4c50-8513-abd902868563", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T02:00:18.532Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	88faa748-0e13-4c50-8513-abd902868563	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 10:00:18.532+08	\\xf096527aeb35c382264419d67b704f7483b5ad5a54b2851f88b9dfb95c64c38e	\\xc87ee8dfb7fda67dfc93a7f31c82fe743db48817e01f8a4819c97ebd5f7f65ad	1	JCS-1
SYSTEM	28	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "88faa748-0e13-4c50-8513-abd902868563", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T02:00:18.536Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	88faa748-0e13-4c50-8513-abd902868563	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 10:00:18.536+08	\\xc87ee8dfb7fda67dfc93a7f31c82fe743db48817e01f8a4819c97ebd5f7f65ad	\\x8dcaabd46145eac5e1d0b15be75f11630678667d051fe27dc96a35f90157cb25	1	JCS-1
SYSTEM	29	\N	USER	3	auth.sso_organizations_synced	USER	3	{"action": "auth.sso_organizations_synced", "actorId": 3, "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "ecfc9136-2412-4641-a047-a5aa2bc90256", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T02:00:42.355Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "membershipCount": 1, "groupsClaimPresent": true, "createdOrganizationCount": 0}	ecfc9136-2412-4641-a047-a5aa2bc90256	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 10:00:42.355+08	\\x8dcaabd46145eac5e1d0b15be75f11630678667d051fe27dc96a35f90157cb25	\\xc9e22a0ca0c457fb9f32fcde1cc74d2f96bdb26e9f7b0bf4aaa6317e21c84038	1	JCS-1
SYSTEM	30	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "ecfc9136-2412-4641-a047-a5aa2bc90256", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T02:00:42.363Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	ecfc9136-2412-4641-a047-a5aa2bc90256	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 10:00:42.363+08	\\xc9e22a0ca0c457fb9f32fcde1cc74d2f96bdb26e9f7b0bf4aaa6317e21c84038	\\xb4236832a1a3e892e39945fc54c4a5b5bfa7cae4ce6ec12ec94da339c766995b	1	JCS-1
SYSTEM	31	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "f5642180-349f-40ff-a6a5-9b0465f57cbd", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T02:14:54.153Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	f5642180-349f-40ff-a6a5-9b0465f57cbd	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 10:14:54.154+08	\\xb4236832a1a3e892e39945fc54c4a5b5bfa7cae4ce6ec12ec94da339c766995b	\\xffdcd015aed134214c1da882f6c74675802d9e146256b67b4a01c314713374a7	1	JCS-1
SYSTEM	32	\N	USER	3	auth.sso_login	USER	3	{"action": "auth.sso_login", "actorId": 3, "outcome": "subject", "targetId": "3", "actorType": "USER", "ipAddress": "127.0.0.1", "requestId": "498304d9-3f94-4816-b1fb-89f2bc82a10d", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0", "groupCount": 1, "occurredAt": "2026-10-30T05:23:46.648Z", "targetType": "USER", "actorSnapshot": {"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}, "clientRequestId": null, "groupsClaimPresent": true}	498304d9-3f94-4816-b1fb-89f2bc82a10d	\N	127.0.0.1	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0	2026-10-30 13:23:46.648+08	\\xffdcd015aed134214c1da882f6c74675802d9e146256b67b4a01c314713374a7	\\x91926881988df8203f62cb99907a9691601a9892b2f1f93cd0683ff6acd30b13	1	JCS-1
\.

--
-- Data for Name: modules; Type: TABLE DATA; Schema: app
--

COPY app.modules (id, project_id, name, description, kind, status, sort_order, created_by, row_version, created_at, updated_at, archived_at, code, deleted_at, deleted_by, created_by_snapshot, deleted_by_snapshot) FROM stdin;
3	1	交易模块	222333	NORMAL	ACTIVE	0	1	3	2026-09-10 16:46:10.454239+08	2026-09-14 09:47:44.434132+08	\N	SHOP-M-2	\N	\N	{"id": 1, "name": "Dev Admin", "loginName": "dev"}	\N
\.

--
-- Data for Name: tasks; Type: TABLE DATA; Schema: app
--

COPY app.tasks (id, project_id, module_id, code, title, description, creator_id, priority, work_status, lifecycle_status, completion_note, completed_at, due_at, row_version, created_at, updated_at, deleted_at, deleted_by, creator_snapshot, deleted_by_snapshot) FROM stdin;
2	1	3	SHOP-T-2	支付方式	222	1	NORMAL	TODO	ACTIVE	\N	\N	\N	1	2026-09-10 17:58:36.690888+08	2026-09-10 17:58:36.690888+08	\N	\N	{"id": 1, "name": "Dev Admin", "loginName": "dev"}	\N
1	1	3	SHOP-T-1	支付接入	3333	1	NORMAL	TODO	ACTIVE	\N	\N	2026-09-10 16:52:00+08	5	2026-09-10 16:52:43.167407+08	2026-10-28 16:58:28.203861+08	\N	\N	{"id": 1, "name": "Dev Admin", "loginName": "dev"}	\N
\.

--
-- Data for Name: task_assignees; Type: TABLE DATA; Schema: app
--

COPY app.task_assignees (task_id, user_id, project_id, created_at, user_snapshot) FROM stdin;
1	1	1	2026-09-29 08:54:17.051954+08	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
2	2	1	2026-09-29 08:54:17.051954+08	{"id": 2, "name": "Dev Member", "loginName": "member"}
\.

--
-- Data for Name: task_groups; Type: TABLE DATA; Schema: app
--

COPY app.task_groups (id, project_id, code, name, status, created_by, row_version, created_at, updated_at, closed_at, created_by_snapshot) FROM stdin;
\.

--
-- Data for Name: task_group_members; Type: TABLE DATA; Schema: app
--

COPY app.task_group_members (id, group_id, task_id, project_id, role, source_kind, status, original_work_status, original_assignee_id, joined_at, detached_at, detached_by, detach_reason, original_assignee_snapshot, detached_by_snapshot) FROM stdin;
\.

--
-- Data for Name: task_status_history; Type: TABLE DATA; Schema: app
--

COPY app.task_status_history (id, task_id, project_id, from_work_status, to_work_status, completed_at_snapshot, completion_note_snapshot, reason, changed_by, changed_at, changed_by_snapshot) FROM stdin;
1	1	1	\N	TODO	\N	\N	\N	1	2026-09-10 16:52:43.167407+08	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
2	2	1	\N	TODO	\N	\N	\N	1	2026-09-10 17:58:36.690888+08	{"id": 1, "name": "Dev Admin", "loginName": "dev"}
3	1	1	TODO	DONE	2026-10-28 16:50:42.808065+08	测试验证，不涉及功能变化	测试验证	3	2026-10-28 16:50:42.808065+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
4	1	1	DONE	TODO	2026-10-28 16:50:42.808065+08	测试验证，不涉及功能变化	\N	3	2026-10-28 16:51:00.259022+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
5	1	1	TODO	DONE	2026-10-28 16:58:12.069159+08	测试验证，不涉及功能变化	测试验证	3	2026-10-28 16:58:12.069159+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
6	1	1	DONE	TODO	2026-10-28 16:58:12.069159+08	测试验证，不涉及功能变化	\N	3	2026-10-28 16:58:28.203861+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
\.

--
-- Data for Name: change_records; Type: TABLE DATA; Schema: app
--

COPY app.change_records (id, project_id, task_id, module_id, code, title, handler_id, author_id, status, current_version, current_payload, published_at, voided_at, void_reason, row_version, created_at, updated_at, handler_snapshot, author_snapshot) FROM stdin;
\.

--
-- Data for Name: change_record_versions; Type: TABLE DATA; Schema: app
--

COPY app.change_record_versions (record_id, project_id, version_no, title_snapshot, payload, created_by, created_at, created_by_snapshot) FROM stdin;
\.

--
-- Data for Name: change_record_leftover_items; Type: TABLE DATA; Schema: app
--

COPY app.change_record_leftover_items (id, record_id, project_id, status, created_by, row_version, created_at, updated_at, created_by_snapshot) FROM stdin;
\.

--
-- Data for Name: change_record_version_leftovers; Type: TABLE DATA; Schema: app
--

COPY app.change_record_version_leftovers (record_id, version_no, leftover_item_id, project_id, content_snapshot) FROM stdin;
\.

--
-- Data for Name: leftover_task_links; Type: TABLE DATA; Schema: app
--

COPY app.leftover_task_links (leftover_item_id, task_id, project_id, created_by, created_at, created_by_snapshot) FROM stdin;
\.

--
-- Data for Name: external_links; Type: TABLE DATA; Schema: app
--

COPY app.external_links (id, project_id, display_url, normalized_url, provider, kind, repository, external_number, external_sha, title_snapshot, state_snapshot, created_by, created_at, created_by_snapshot) FROM stdin;
\.

--
-- Data for Name: project_external_links; Type: TABLE DATA; Schema: app
--

COPY app.project_external_links (project_id, link_id, created_at, is_root_repository) FROM stdin;
\.

--
-- Data for Name: task_external_links; Type: TABLE DATA; Schema: app
--

COPY app.task_external_links (project_id, task_id, link_id, created_at) FROM stdin;
\.

--
-- Data for Name: change_record_external_links; Type: TABLE DATA; Schema: app
--

COPY app.change_record_external_links (project_id, change_record_id, link_id, created_at) FROM stdin;
\.

--
-- Data for Name: activity_projection; Type: TABLE DATA; Schema: app
--

COPY app.activity_projection (id, project_id, source_chain_id, source_sequence, source_entity_type, source_entity_id, activity_type, actor_id, summary, metadata, visibility_scope, source_status, source_row_version, occurred_at, actor_snapshot) FROM stdin;
1	1	PROJECT:1	1	PROJECT	1	PROJECT_CREATED	1	创建了项目 商品系统	{"code": "SHOP"}	MEMBER	ACTIVE	1	2026-09-10 16:23:15.35+08	\N
2	4	PROJECT:4	1	PROJECT	4	PROJECT_CREATED	1	创建了项目 SHOP	{"code": "SHOP2"}	MEMBER	ACTIVE	1	2026-09-10 16:23:46.358+08	\N
3	1	PROJECT:1	2	MODULE	3	module.create	1	模块创建：交易模块	{"moduleId": 3}	MEMBER	ACTIVE	1	2026-09-10 16:46:10.454+08	\N
4	1	PROJECT:1	3	MODULE	1	module.update	1	模块更新：未分类模块	{"moduleId": 1}	MEMBER	ACTIVE	2	2026-09-10 16:50:11.615+08	\N
5	1	PROJECT:1	4	FEATURE	1	feature.create	1	功能创建：微信支付模块	{"moduleId": 3, "featureId": 1}	MEMBER	ACTIVE	1	2026-09-10 16:51:43.021+08	\N
6	1	PROJECT:1	5	TASK	1	task.create	1	任务创建：支付接入	{"taskId": 1, "moduleId": 3, "featureId": 1}	MEMBER	TODO	1	2026-09-10 16:52:43.167+08	\N
7	1	PROJECT:1	6	TASK	2	task.create	1	任务创建：支付方式	{"taskId": 2, "moduleId": 3, "featureId": null}	MEMBER	TODO	1	2026-09-10 17:58:36.69+08	\N
8	5	PROJECT:5	1	PROJECT	5	PROJECT_CREATED	2	创建了项目 RCS	{"code": "RCS"}	MEMBER	ACTIVE	1	2026-09-14 09:26:42.934+08	\N
9	1	PROJECT:1	7	MODULE	3	module.update	1	模块更新：交易模块	{"moduleId": 3}	MEMBER	ACTIVE	2	2026-09-14 09:47:44.434+08	\N
10	1	PROJECT:1	8	FEATURE	1	feature.update	1	功能更新：微信支付模块	{"moduleId": 3, "featureId": 1}	MEMBER	ACTIVE	2	2026-09-14 09:51:43.864+08	\N
11	1	PROJECT:1	10	PROJECT	1	PROJECT_MEMBER_ADDED	3	将用户 邵晨宇 添加为项目成员	{"role": "MEMBER", "userId": 3, "membershipId": 7}	MEMBER	NOT_STARTED	1	2026-10-28 16:50:23.486+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
12	1	PROJECT:1	11	TASK	1	task.complete	3	任务完成：支付接入	{"taskId": 1, "moduleId": 3, "featureId": 1}	MEMBER	DONE	2	2026-10-28 16:50:42.808+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
13	1	PROJECT:1	12	PROJECT	1	PROJECT_STATUS_CHANGED	3	项目开工：商品系统 由未开始进入进行中	{"code": "SHOP", "taskId": 1, "trigger": "TASK_COMPLETED"}	MEMBER	ACTIVE	2	2026-10-28 16:50:42.808+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
14	1	PROJECT:1	13	TASK	1	task.reopen	3	任务重新打开：支付接入	{"taskId": 1, "moduleId": 3, "featureId": 1}	MEMBER	TODO	3	2026-10-28 16:51:00.259+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
15	1	PROJECT:1	14	TASK	1	task.complete	3	任务完成：支付接入	{"taskId": 1, "moduleId": 3, "featureId": 1}	MEMBER	DONE	4	2026-10-28 16:58:12.069+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
16	1	PROJECT:1	15	TASK	1	task.reopen	3	任务重新打开：支付接入	{"taskId": 1, "moduleId": 3, "featureId": 1}	MEMBER	TODO	5	2026-10-28 16:58:28.203+08	{"id": 3, "name": "邵晨宇", "loginName": "shaochenyu"}
\.

--
-- Data for Name: notifications; Type: TABLE DATA; Schema: app
--

COPY app.notifications (id, recipient_id, project_id, source_chain_id, source_sequence, notification_type, title, body, target_path, created_at, read_at) FROM stdin;
1	1	1	PROJECT:1	1	PROJECT_JOINED	已加入项目 商品系统	你已成为该项目的初始成员	/projects/1/activity	2026-09-10 16:23:15.35+08	\N
2	2	1	PROJECT:1	1	PROJECT_JOINED	已加入项目 商品系统	你已成为该项目的初始成员	/projects/1/activity	2026-09-10 16:23:15.35+08	\N
3	1	4	PROJECT:4	1	PROJECT_JOINED	已加入项目 SHOP	你已成为该项目的初始成员	/projects/4/activity	2026-09-10 16:23:46.358+08	\N
4	2	4	PROJECT:4	1	PROJECT_JOINED	已加入项目 SHOP	你已成为该项目的初始成员	/projects/4/activity	2026-09-10 16:23:46.358+08	\N
5	1	1	PROJECT:1	5	task.assigned	任务指派：支付接入	SHOP-T-1	/projects/1/modules/3/features/1?taskId=1	2026-09-10 16:52:43.167+08	\N
6	2	1	PROJECT:1	6	task.assigned	任务指派：支付方式	SHOP-T-2	/projects/1/modules/3/tasks?taskId=2	2026-09-10 17:58:36.69+08	\N
7	1	5	PROJECT:5	1	PROJECT_JOINED	已加入项目 RCS	你已成为该项目的初始成员	/projects/5/activity	2026-09-14 09:26:42.934+08	\N
8	2	5	PROJECT:5	1	PROJECT_JOINED	已加入项目 RCS	你已成为该项目的初始成员	/projects/5/activity	2026-09-14 09:26:42.934+08	\N
9	3	1	PROJECT:1	10	PROJECT_JOINED	已加入项目 商品系统	你已被系统管理员添加为项目成员	/projects/1/activity	2026-10-28 16:50:23.486+08	\N
10	1	1	PROJECT:1	11	task.complete	任务完成：支付接入	SHOP-T-1	/projects/1/modules/3/features/1?taskId=1	2026-10-28 16:50:42.808+08	\N
11	1	1	PROJECT:1	12	project.status.change	项目已开始：商品系统	项目 SHOP 由未开始进入进行中。	/projects/1	2026-10-28 16:50:42.808+08	\N
12	2	1	PROJECT:1	12	project.status.change	项目已开始：商品系统	项目 SHOP 由未开始进入进行中。	/projects/1	2026-10-28 16:50:42.808+08	\N
13	3	1	PROJECT:1	12	project.status.change	项目已开始：商品系统	项目 SHOP 由未开始进入进行中。	/projects/1	2026-10-28 16:50:42.808+08	\N
14	1	1	PROJECT:1	13	task.reopen	任务重新打开：支付接入	SHOP-T-1	/projects/1/modules/3/features/1?taskId=1	2026-10-28 16:51:00.259+08	\N
15	1	1	PROJECT:1	14	task.complete	任务完成：支付接入	SHOP-T-1	/projects/1/modules/3/features/1?taskId=1	2026-10-28 16:58:12.069+08	\N
16	1	1	PROJECT:1	15	task.reopen	任务重新打开：支付接入	SHOP-T-1	/projects/1/modules/3/features/1?taskId=1	2026-10-28 16:58:28.203+08	\N
\.

--
-- Data for Name: search_projection; Type: TABLE DATA; Schema: app
--

COPY app.search_projection (id, project_id, entity_type, entity_id, title, summary, raw_text, normalized_search_text, visibility_scope, source_status, source_row_version, updated_at, module_id, record_id) FROM stdin;
2	4	PROJECT	4	SHOP	2222	SHOP2 SHOP 2222	shop2 shop 2222	MEMBER	ACTIVE	1	2026-09-10 16:23:46.354695+08	\N	\N
8	5	PROJECT	5	RCS	RCS调度	RCS RCS RCS调度	rcs rcs rcs调度	MEMBER	ACTIVE	1	2026-09-14 09:26:42.898378+08	\N	\N
3	1	MODULE	3	交易模块	222333	交易模块\n222333	交易模块 222333	MEMBER	ACTIVE	2	2026-09-14 09:47:44.434132+08	\N	\N
7	1	TASK	2	支付方式	222	SHOP-T-2\n支付方式\n222	shop-t-2 支付方式 222	MEMBER	TODO	1	2026-09-10 17:58:36.690888+08	3	\N
1	1	PROJECT	1	商品系统	123	SHOP 商品系统 123	shop 商品系统 123	MEMBER	ACTIVE	2	2026-10-28 16:50:42.789603+08	\N	\N
6	1	TASK	1	支付接入	3333	SHOP-T-1\n支付接入\n3333	shop-t-1 支付接入 3333	MEMBER	TODO	5	2026-10-28 16:58:28.173812+08	3	\N
\.

--
-- Data for Name: code_sequences; Type: TABLE DATA; Schema: app
--

COPY app.code_sequences (project_id, entity_type, last_number) FROM stdin;
1	TASK	2
5	MODULE	1
4	MODULE	1
1	MODULE	2
\.

--
-- Sequence values
--

SELECT pg_catalog.setval('app.activity_projection_id_seq', 16, true);

SELECT pg_catalog.setval('app.change_record_leftover_items_id_seq', 1, false);

SELECT pg_catalog.setval('app.change_records_id_seq', 1, false);

SELECT pg_catalog.setval('app.external_links_id_seq', 1, false);

SELECT pg_catalog.setval('app.modules_id_seq', 4, true);

SELECT pg_catalog.setval('app.notifications_id_seq', 16, true);

SELECT pg_catalog.setval('app.project_members_id_seq', 7, true);

SELECT pg_catalog.setval('app.projects_id_seq', 5, true);

SELECT pg_catalog.setval('app.search_projection_id_seq', 15, true);

SELECT pg_catalog.setval('app.task_group_members_id_seq', 1, false);

SELECT pg_catalog.setval('app.task_groups_id_seq', 1, false);

SELECT pg_catalog.setval('app.task_status_history_id_seq', 6, true);

SELECT pg_catalog.setval('app.tasks_id_seq', 2, true);

SELECT pg_catalog.setval('app.users_id_seq', 3, true);
