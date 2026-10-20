import { integer, text } from 'drizzle-orm/sqlite-core'
import { tenantTable } from '@edgekits/kernel/tenancy'

export const projects = tenantTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

export const createProjectsSql = [
  'CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, org_id TEXT NOT NULL)',
  'CREATE INDEX projects_org_id_idx ON projects (org_id)',
]
