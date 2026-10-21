import { text } from 'drizzle-orm/sqlite-core'
import { tenantReference, tenantTable } from '@edgekits/kernel/tenancy'

// ADR-008: no .primaryKey(); tenantTable() keys the table by (org_id, id).
export const projects = tenantTable('projects', {
  id: text('id'),
  name: text('name').notNull(),
})

export const tasks = tenantTable(
  'tasks',
  {
    id: text('id'),
    projectId: text('project_id').notNull(),
  },
  (t) => [tenantReference(t.projectId, projects)],
)

// The DDL drizzle-kit generates for projects, as the test database uses it.
export const createProjectsSql = [
  'CREATE TABLE IF NOT EXISTS projects (id TEXT NOT NULL, name TEXT NOT NULL, org_id TEXT NOT NULL, PRIMARY KEY (org_id, id))',
  'CREATE INDEX IF NOT EXISTS projects_org_id_idx ON projects (org_id)',
]
