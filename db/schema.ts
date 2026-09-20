import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';
export const users=sqliteTable('users',{id:text('id').primaryKey(),name:text('name').notNull(),email:text('email').notNull().unique(),passwordHash:text('password_hash').notNull(),role:text('role').notNull(),disabled:integer('disabled').notNull().default(0),createdAt:text('created_at').notNull()});
export const sessions=sqliteTable('sessions',{hash:text('hash').primaryKey(),userId:text('user_id').notNull().references(()=>users.id),expiresAt:integer('expires_at').notNull()},t=>[index('sessions_user_idx').on(t.userId)]);
export const contracts=sqliteTable('contracts',{id:text('id').primaryKey(),ownerId:text('owner_id').notNull().references(()=>users.id),state:text('state').notNull(),revision:integer('revision').notNull().default(0),updatedAt:text('updated_at').notNull()},t=>[index('contracts_owner_idx').on(t.ownerId,t.updatedAt)]);
export const limits=sqliteTable('rate_limits',{key:text('key').primaryKey(),window:integer('window').notNull(),attempts:integer('attempts').notNull()});
export const setup=sqliteTable('setup',{id:text('id').primaryKey(),createdAt:text('created_at').notNull()});
