# Shared API contract
All API routes are /api/..., JSON except file operations. Success {data: T}; error {error: string}, proper status codes. Types src/lib/types.ts.
GET session => User|null. POST auth/login {email,password}=>User; POST auth/register {name,email,password}=>User(client only); POST auth/logout=>null.
GET capabilities => Capabilities.
GET contracts => Contract[] accessible by owner or assigned lawyer or admin.
POST contracts {title?} => Contract empty.
GET contracts/:id => Contract accessible.
POST contracts/:id/chat {message,mode?:'demo'|'live',generate?:boolean} => Contract. Chat persists both messages; generate yields immutable Version + DOCX. Demo mode explicit, clearly source demo. During open review refuse AI modification and ask use review message route.
POST contracts/:id/reviews {versionId,stance,concerns} => Contract frozen review snapshot (requirements = prior messages). Open review duplicate prevented. Unassigned initially.
POST contracts/:id/reviews/:reviewId/assign {lawyerId} => Contract admin only.
POST contracts/:id/reviews/:reviewId/start {} => Contract assigned lawyer only.
POST contracts/:id/reviews/:reviewId/messages {content,requestInfo?:boolean} => Contract owner/assigned lawyer/admin. lawyer requestInfo sets need_info, user response returns reviewing.
POST contracts/:id/reviews/:reviewId/upload multipart file => Contract. Assigned lawyer only; immutable DOCX review version; mark editingVersionId and saved.
POST contracts/:id/reviews/:reviewId/complete {versionId,deliveryNote} => Contract assigned lawyer only; require saved exact review Version, no pending editor save. Freeze final.
GET files/:versionId => DOCX bytes after role ownership check.
GET users => User[] admin only. POST users {name,email,password,role}=>User admin only. PATCH users/:id {name?,disabled?}=>User admin; no privilege self elevation via normal registration.
GET contracts/:id/reviews/:reviewId/editor => ONLYOFFICE config assigned lawyer (and optional view config owner). POST .../editor/save => saving status; force-save token tied to revision.
ONLYOFFICE integration document URL and callback use signed narrow tokens; no public permanent URLs.
