# Notted — Corporate Notes Platform

## Project Overview

Notted is a corporate-grade notes management system built as a full-stack SaaS application. It features a clean, white A4/Letter page-size paper layout for an intuitive writing experience. The platform supports both project-based and standalone note organization, rich text editing with image handling, checklists, attachments, and team collaboration capabilities. The architecture is designed for self-hosting via Docker Compose, using only open-source technologies with zero recurring SaaS costs beyond a VPS server and optional AI API usage.

The primary purpose is to showcase advanced full-stack development skills, DevOps capabilities, enterprise architecture design, and AI integration — serving as a portfolio piece for corporate clients, freelancers, and SaaS product development.

---

## Tech Stack

| Layer | Technology | Version | License | Purpose |
|-------|-----------|---------|---------|---------|
| **Frontend** | Next.js | 16.x | MIT | React framework with App Router, Server Components |
| **Frontend Language** | TypeScript | 5.x | Apache 2.0 | End-to-end type safety |
| **Frontend Styling** | Tailwind CSS | 4.x | MIT | Utility-first CSS framework |
| **UI Components** | Shadcn UI | latest | MIT | Accessible, customizable React components |
| **Rich Text Editor** | TipTap | 2.x | MIT | ProseMirror-based editor with extensions |
| **Backend Framework** | NestJS | 10.x | MIT | Enterprise Node.js framework with DI, modules |
| **Backend Language** | TypeScript | 5.x | Apache 2.0 | Type-safe API development |
| **API Protocol** | tRPC | 11.x | MIT | End-to-end type-safe APIs |
| **Database** | PostgreSQL | 16 | PostgreSQL License | Primary relational database |
| **Vector Extension** | pgvector | 0.7.x | PostgreSQL | Vector storage for semantic search |
| **ORM** | Drizzle ORM | 0.30.x | Apache 2.0 | Type-safe SQL ORM |
| **Authentication** | Better Auth | latest | MIT | Self-hosted auth with SSO/SAML support |
| **Cache / Sessions** | Redis | 7.x | BSD | Session storage, rate limiting, pub/sub |
| **Full-Text Search** | Meilisearch | 1.x | MIT | Fast typo-tolerant search engine |
| **Object Storage** | MinIO | latest | AGPL v3 | S3-compatible file storage |
| **Email** | Nodemailer | latest | MIT | Email sending (SMTP configurable) |
| **Background Jobs** | BullMQ | 5.x | MIT | Redis-backed job queues |
| **Queue Dashboard** | Bull Board | latest | MIT | Web UI for monitoring job queues |
| **Real-Time** | Socket.io | 4.x | MIT | WebSocket connections for collaboration |
| **PDF Export** | Puppeteer | 22.x | Apache 2.0 | Headless Chrome for server-side PDF generation |
| **Image Processing** | Sharp | 0.33.x | Apache 2.0 | Image resizing, compression, format conversion |
| **Containerization** | Docker | 24.x | Apache 2.0 | Application containerization |
| **Orchestration** | Docker Compose | 2.x | Apache 2.0 | Multi-container deployment |

---

## Project Structure

```
Notted/
├── apps/
│   ├── web/                          # Next.js 16 frontend
│   │   ├── src/
│   │   │   ├── app/                  # App Router (Next.js 13+)
│   │   │   │   ├── (auth)/           # Auth route group
│   │   │   │   │   ├── login/
│   │   │   │   │   ├── register/
│   │   │   │   │   ├── forgot-password/
│   │   │   │   │   └── reset-password/
│   │   │   │   ├── (dashboard)/      # Main app route group
│   │   │   │   │   ├── layout.tsx    # Dashboard shell with sidebar
│   │   │   │   │   ├── page.tsx      # Home / recent notes
│   │   │   │   │   ├── workspaces/
│   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   └── [workspaceId]/
│   │   │   │   │   │       ├── page.tsx
│   │   │   │   │   │       ├── settings/
│   │   │   │   │   │       ├── members/
│   │   │   │   │   │       ├── projects/
│   │   │   │   │   │       │   ├── page.tsx
│   │   │   │   │   │       │   └── [projectId]/
│   │   │   │   │   │       │       ├── page.tsx
│   │   │   │   │   │       │       └── notes/
│   │   │   │   │   │       │           └── [noteId]/
│   │   │   │   │   │       │               └── page.tsx
│   │   │   │   │   │       └── notes/      # Standalone notes
│   │   │   │   │   │           └── [noteId]/
│   │   │   │   │   │               └── page.tsx
│   │   │   │   │   ├── templates/
│   │   │   │   │   ├── trash/
│   │   │   │   │   └── settings/
│   │   │   │   ├── api/              # Next.js API routes (minimal)
│   │   │   │   │   └── trpc/
│   │   │   │   │       └── [trpc]/
│   │   │   │   │           └── route.ts
│   │   │   │   └── layout.tsx        # Root layout
│   │   │   ├── components/
│   │   │   │   ├── editor/           # TipTap editor components
│   │   │   │   │   ├── TiptapEditor.tsx
│   │   │   │   │   ├── EditorToolbar.tsx
│   │   │   │   │   ├── SlashCommandMenu.tsx
│   │   │   │   │   ├── ImageResizeHandle.tsx
│   │   │   │   │   └── extensions/
│   │   │   │   │       ├── CustomImage.ts
│   │   │   │   │       ├── ChecklistItem.ts
│   │   │   │   │       ├── PageBreak.ts
│   │   │   │   │       └── Mention.ts
│   │   │   │   ├── layout/           # Layout components
│   │   │   │   │   ├── DashboardShell.tsx
│   │   │   │   │   ├── Sidebar.tsx
│   │   │   │   │   ├── TopBar.tsx
│   │   │   │   │   ├── WorkspaceSwitcher.tsx
│   │   │   │   │   └── Breadcrumb.tsx
│   │   │   │   ├── notes/            # Note-specific components
│   │   │   │   │   ├── NoteCard.tsx
│   │   │   │   │   ├── NoteList.tsx
│   │   │   │   │   ├── NoteTree.tsx
│   │   │   │   │   ├── PageContainer.tsx
│   │   │   │   │   ├── VersionHistory.tsx
│   │   │   │   │   └── ShareModal.tsx
│   │   │   │   ├── projects/         # Project components
│   │   │   │   │   ├── ProjectCard.tsx
│   │   │   │   │   ├── ProjectGrid.tsx
│   │   │   │   │   └── CreateProjectModal.tsx
│   │   │   │   ├── search/           # Search components
│   │   │   │   │   ├── SearchBar.tsx
│   │   │   │   │   ├── SearchResults.tsx
│   │   │   │   │   └── FilterPanel.tsx
│   │   │   │   └── ui/               # Shadcn UI components
│   │   │   ├── hooks/
│   │   │   │   ├── useAuth.ts
│   │   │   │   ├── useWorkspace.ts
│   │   │   │   ├── useNotes.ts
│   │   │   │   ├── useProjects.ts
│   │   │   │   ├── useSearch.ts
│   │   │   │   ├── useRealtime.ts
│   │   │   │   └── useEditor.ts
│   │   │   ├── lib/
│   │   │   │   ├── trpc.ts           # tRPC client setup
│   │   │   │   ├── utils.ts
│   │   │   │   ├── constants.ts
│   │   │   │   └── validators.ts
│   │   │   ├── styles/
│   │   │   │   ├── globals.css
│   │   │   │   ├── editor.css        # TipTap custom styles
│   │   │   │   └── print.css         # Print-specific styles
│   │   │   └── types/
│   │   │       └── index.ts
│   │   ├── public/
│   │   │   └── images/
│   │   ├── Dockerfile
│   │   ├── next.config.js
│   │   ├── tailwind.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── api/                          # NestJS backend
│       ├── src/
│       │   ├── main.ts               # Application entry point
│       │   ├── app.module.ts         # Root module
│       │   ├── config/               # Configuration
│       │   │   ├── database.config.ts
│       │   │   ├── redis.config.ts
│       │   │   ├── minio.config.ts
│       │   │   ├── meilisearch.config.ts
│       │   │   ├── email.config.ts
│       │   │   └── app.config.ts
│       │   ├── common/               # Shared utilities
│       │   │   ├── decorators/
│       │   │   ├── filters/
│       │   │   ├── guards/
│       │   │   ├── interceptors/
│       │   │   ├── pipes/
│       │   │   └── utils/
│       │   ├── database/             # Database module
│       │   │   ├── database.module.ts
│       │   │   ├── schema/           # Drizzle schema definitions
│       │   │   │   ├── index.ts
│       │   │   │   ├── users.ts
│       │   │   │   ├── workspaces.ts
│       │   │   │   ├── workspaceMembers.ts
│       │   │   │   ├── projects.ts
│       │   │   │   ├── notes.ts
│       │   │   │   ├── noteVersions.ts
│       │   │   │   ├── attachments.ts
│       │   │   │   ├── tags.ts
│       │   │   │   ├── noteTags.ts
│       │   │   │   ├── noteEmbeddings.ts
│       │   │   │   ├── comments.ts
│       │   │   │   ├── auditLogs.ts
│       │   │   │   └── apiKeys.ts
│       │   │   ├── migrations/       # Drizzle migrations
│       │   │   └── seed.ts
│       │   ├── auth/                 # Authentication module
│       │   │   ├── auth.module.ts
│       │   │   ├── auth.controller.ts
│       │   │   ├── auth.service.ts
│       │   │   ├── auth.guard.ts
│       │   │   ├── better-auth.setup.ts
│       │   │   └── strategies/
│       │   │       ├── local.strategy.ts
│       │   │       ├── oauth.strategy.ts
│       │   │       └── jwt.strategy.ts
│       │   ├── users/                # Users module
│       │   │   ├── users.module.ts
│       │   │   ├── users.controller.ts
│       │   │   ├── users.service.ts
│       │   │   └── dto/
│       │   ├── workspaces/           # Workspaces module
│       │   │   ├── workspaces.module.ts
│       │   │   ├── workspaces.controller.ts
│       │   │   ├── workspaces.service.ts
│       │   │   └── dto/
│       │   ├── projects/             # Projects module
│       │   │   ├── projects.module.ts
│       │   │   ├── projects.controller.ts
│       │   │   ├── projects.service.ts
│       │   │   └── dto/
│       │   ├── notes/                # Notes module
│       │   │   ├── notes.module.ts
│       │   │   ├── notes.controller.ts
│       │   │   ├── notes.service.ts
│       │   │   ├── notes.gateway.ts  # Socket.io gateway
│       │   │   └── dto/
│       │   ├── attachments/          # Attachments module
│       │   │   ├── attachments.module.ts
│       │   │   ├── attachments.controller.ts
│       │   │   ├── attachments.service.ts
│       │   │   └── dto/
│       │   ├── search/               # Search module
│       │   │   ├── search.module.ts
│       │   │   ├── search.controller.ts
│       │   │   ├── search.service.ts
│       │   │   └── dto/
│       │   ├── ai/                   # AI integration module
│       │   │   ├── ai.module.ts
│       │   │   ├── ai.controller.ts
│       │   │   ├── ai.service.ts
│       │   │   └── dto/
│       │   ├── export/               # Export module
│       │   │   ├── export.module.ts
│       │   │   ├── export.controller.ts
│       │   │   ├── export.service.ts
│       │   │   └── templates/
│       │   ├── queue/                # Background jobs module
│       │   │   ├── queue.module.ts
│       │   │   ├── queue.service.ts
│       │   │   ├── queue.processor.ts
│       │   │   └── jobs/
│       │   │       ├── email.job.ts
│       │   │       ├── indexing.job.ts
│       │   │       ├── embedding.job.ts
│       │   │       ├── export.job.ts
│       │   │       └── cleanup.job.ts
│       │   ├── realtime/             # Real-time collaboration
│       │   │   ├── realtime.module.ts
│       │   │   ├── realtime.gateway.ts
│       │   │   ├── realtime.service.ts
│       │   │   └── yjs/
│       │   └── webhooks/             # Webhooks module
│       │       ├── webhooks.module.ts
│       │       ├── webhooks.controller.ts
│       │       ├── webhooks.service.ts
│       │       └── dto/
│       ├── test/
│       ├── Dockerfile
│       ├── nest-cli.json
│       ├── tsconfig.json
│       └── package.json
│
├── packages/
│   ├── shared-types/                 # Shared TypeScript types
│   │   ├── src/
│   │   │   ├── auth.ts
│   │   │   ├── workspace.ts
│   │   │   ├── project.ts
│   │   │   ├── note.ts
│   │   │   ├── attachment.ts
│   │   │   ├── search.ts
│   │   │   └── api.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared-validators/            # Shared Zod schemas
│       ├── src/
│       │   ├── auth.schema.ts
│       │   ├── workspace.schema.ts
│       │   ├── project.schema.ts
│       │   ├── note.schema.ts
│       │   └── common.schema.ts
│       ├── package.json
│       └── tsconfig.json
│
├── compose.yaml                       # Complete development stack
├── docker/
│   ├── Dockerfile.dev                 # Shared development workspace image
│   ├── compose.debug-ports.yml        # Optional host-tooling ports
│   ├── init-scripts/
│   │   └── init-postgres.sql
│   └── minio-source/                  # Source-pinned MinIO builds
│
├── scripts/
│   ├── setup.sh                      # Initial server setup
│   ├── deploy.sh                     # Deployment script
│   ├── backup.sh                     # Database backup
│   ├── restore.sh                    # Database restore
│   └── migrate.sh                    # Run migrations
│
├── docs/
│   ├── README.md
│   ├── API.md
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT.md
│
├── CLAUDE.md                         # AI coding conventions
├── Makefile                          # Common commands
├── .gitignore
├── .dockerignore
├── package.json                      # Root workspace config
├── turbo.json                        # Turborepo config
└── pnpm-workspace.yaml               # pnpm workspace
```

---

## Docker Compose Configuration

### Production Stack (`docker/docker-compose.yml`)

```yaml
version: "3.8"

services:
  # PostgreSQL Database
  postgres:
    image: ankane/pgvector:latest
    container_name: notted-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER:-notted}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME:-notted}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-scripts/init-postgres.sql:/docker-entrypoint-initdb.d/init.sql
      - ./backups:/backups
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-notted} -d ${DB_NAME:-notted}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - notted-network

  # Redis Cache & Sessions
  redis:
    image: redis:7-alpine
    container_name: notted-redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - notted-network

  # Meilisearch Full-Text Search
  meilisearch:
    image: getmeili/meilisearch:v1.7
    container_name: notted-meilisearch
    restart: unless-stopped
    environment:
      MEILI_MASTER_KEY: ${MEILI_MASTER_KEY}
      MEILI_NO_ANALYTICS: "true"
    volumes:
      - meilisearch_data:/meili_data
    ports:
      - "127.0.0.1:7700:7700"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7700/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - notted-network

  # MinIO Object Storage
  minio:
    image: minio/minio:latest
    container_name: notted-minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_BROWSER_REDIRECT_URL: ${MINIO_CONSOLE_URL:-http://localhost:9001}
    volumes:
      - minio_data:/data
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3
    networks:
      - notted-network

  # Create MinIO buckets on startup
  minio-init:
    image: minio/mc:latest
    container_name: notted-minio-init
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      /usr/bin/mc alias set local http://minio:9000 ${MINIO_ROOT_USER} ${MINIO_ROOT_PASSWORD};
      /usr/bin/mc mb local/notted-attachments --ignore-existing;
      /usr/bin/mc mb local/notted-exports --ignore-existing;
      /usr/bin/mc anonymous set download local/notted-exports;
      /usr/bin/mc policy set public local/notted-exports;
      exit 0;
      "
    networks:
      - notted-network

  # NestJS API Backend
  api:
    build:
      context: ../
      dockerfile: apps/api/Dockerfile
    container_name: notted-api
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3001
      DATABASE_URL: postgres://${DB_USER:-notted}:${DB_PASSWORD}@postgres:5432/${DB_NAME:-notted}
      REDIS_URL: redis://redis:6379
      MINIO_ENDPOINT: minio
      MINIO_PORT: 9000
      MINIO_USE_SSL: "false"
      MINIO_ACCESS_KEY: ${MINIO_ROOT_USER}
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
      MINIO_BUCKET_ATTACHMENTS: notted-attachments
      MINIO_BUCKET_EXPORTS: notted-exports
      MEILISEARCH_HOST: http://meilisearch:7700
      MEILISEARCH_API_KEY: ${MEILI_MASTER_KEY}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      BETTER_AUTH_URL: ${APP_URL:-http://localhost:3000}
      EMAIL_SMTP_HOST: ${EMAIL_SMTP_HOST}
      EMAIL_SMTP_PORT: ${EMAIL_SMTP_PORT:-587}
      EMAIL_SMTP_USER: ${EMAIL_SMTP_USER}
      EMAIL_SMTP_PASSWORD: ${EMAIL_SMTP_PASSWORD}
      EMAIL_FROM: ${EMAIL_FROM:-noreply@notted.app}
      AI_OPENAI_API_KEY: ${AI_OPENAI_API_KEY}
      AI_OPENAI_MODEL: ${AI_OPENAI_MODEL:-gpt-4o}
      AI_CLAUDE_API_KEY: ${AI_CLAUDE_API_KEY}
      AI_CLAUDE_MODEL: ${AI_CLAUDE_MODEL:-claude-3-5-sonnet-20241022}
      APP_URL: ${APP_URL:-http://localhost:3000}
      API_URL: ${API_URL:-http://localhost:3001}
    ports:
      - "127.0.0.1:3001:3001"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      meilisearch:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    volumes:
      - api_uploads:/app/uploads
    networks:
      - notted-network

  # Next.js Frontend
  web:
    build:
      context: ../
      dockerfile: apps/web/Dockerfile
    container_name: notted-web
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      NEXT_PUBLIC_API_URL: ${API_URL:-http://localhost:3001}
      NEXT_PUBLIC_APP_URL: ${APP_URL:-http://localhost:3000}
      NEXT_PUBLIC_WS_URL: ${WS_URL:-ws://localhost:3001}
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      - api
    networks:
      - notted-network

volumes:
  postgres_data:
  redis_data:
  meilisearch_data:
  minio_data:
  api_uploads:

networks:
  notted-network:
    driver: bridge
```

### Development Stack (`compose.yaml`)

The root `compose.yaml` is the canonical development stack. `docker compose up` installs
locked dependencies, continuously compiles shared contracts, applies migrations, seeds the
development fixture on first startup, and runs PostgreSQL/pgvector, Redis, Meilisearch,
MinIO, Mailpit, NestJS, and Next.js. Source is mounted read-only and generated output uses
named volumes. Only web, API, and the Mailpit UI bind loopback ports by default; use
`docker/compose.debug-ports.yml` only for host-side data tooling. Image versions and digests,
health checks, dependency ordering, networks, volume policy, and development defaults live
in the Compose file and ADR 0008 rather than being duplicated here.

---

## Database Schema (Drizzle ORM)

### Users Table

```typescript
// apps/api/src/database/schema/users.ts
import { pgTable, uuid, varchar, timestamp, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  avatarUrl: text("avatar_url"),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Workspaces Table

```typescript
// apps/api/src/database/schema/workspaces.ts
import { pgTable, uuid, varchar, timestamp, text, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { users } from "./users";

export const workspacePlanEnum = pgEnum("workspace_plan", ["free", "pro", "enterprise"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  description: text("description"),
  logoUrl: text("logo_url"),
  domain: varchar("domain", { length: 255 }).unique(),
  plan: workspacePlanEnum("plan").default("free").notNull(),
  settings: jsonb("settings").default({}).notNull(),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Workspace Members Table

```typescript
// apps/api/src/database/schema/workspaceMembers.ts
import { pgTable, uuid, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { users } from "./users";

export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "editor", "viewer"]);

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: memberRoleEnum("role").default("editor").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Projects Table

```typescript
// apps/api/src/database/schema/projects.ts
import { pgTable, uuid, varchar, timestamp, text, boolean, pgEnum } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { users } from "./users";

export const projectStatusEnum = pgEnum("project_status", ["active", "archived", "completed"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  coverImageUrl: text("cover_image_url"),
  color: varchar("color", { length: 7 }).default("#3b82f6"),
  status: projectStatusEnum("status").default("active").notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  isArchived: boolean("is_archived").default(false).notNull(),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Notes Table

```typescript
// apps/api/src/database/schema/notes.ts
import { pgTable, uuid, varchar, timestamp, text, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { projects } from "./projects";
import { users } from "./users";

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  parentId: uuid("parent_id").references(() => notes.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 500 }).notNull(),
  content: jsonb("content").default({ type: "doc", content: [] }).notNull(),
  contentPlain: text("content_plain").default(""),
  isTemplate: boolean("is_template").default(false).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  isArchived: boolean("is_archived").default(false).notNull(),
  isDeleted: boolean("is_deleted").default(false).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  pageSize: varchar("page_size", { length: 10 }).default("a4").notNull(), // a4 or letter
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  updatedById: uuid("updated_by_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Note Versions Table

```typescript
// apps/api/src/database/schema/noteVersions.ts
import { pgTable, uuid, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { notes } from "./notes";
import { users } from "./users";

export const noteVersions = pgTable("note_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }).notNull(),
  content: jsonb("content").notNull(),
  contentPlain: text("content_plain").default(""),
  version: integer("version").notNull(),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Attachments Table

```typescript
// apps/api/src/database/schema/attachments.ts
import { pgTable, uuid, varchar, timestamp, integer, text } from "drizzle-orm/pg-core";
import { notes } from "./notes";
import { workspaces } from "./workspaces";
import { users } from "./users";

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  originalName: varchar("original_name", { length: 255 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  width: integer("width"),
  height: integer("height"),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Tags & Note Tags Tables

```typescript
// apps/api/src/database/schema/tags.ts
import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 50 }).notNull(),
  color: varchar("color", { length: 7 }).default("#6b7280"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// apps/api/src/database/schema/noteTags.ts
import { pgTable, uuid } from "drizzle-orm/pg-core";
import { notes } from "./notes";
import { tags } from "./tags";

export const noteTags = pgTable("note_tags", {
  noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }).notNull(),
  tagId: uuid("tag_id").references(() => tags.id, { onDelete: "cascade" }).notNull(),
});
```

### Note Embeddings Table (Semantic Search)

```typescript
// apps/api/src/database/schema/noteEmbeddings.ts
import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { vector } from "pgvector/drizzle-orm";
import { notes } from "./notes";

export const noteEmbeddings = pgTable("note_embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }).notNull().unique(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  embeddingIndex: index("embedding_index").using("hnsw", table.embedding.op("vector_cosine_ops")),
}));
```

### Comments Table

```typescript
// apps/api/src/database/schema/comments.ts
import { pgTable, uuid, timestamp, text, boolean } from "drizzle-orm/pg-core";
import { notes } from "./notes";
import { users } from "./users";

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }).notNull(),
  parentId: uuid("parent_id").references(() => comments.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  isResolved: boolean("is_resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedById: uuid("resolved_by_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Audit Logs Table

```typescript
// apps/api/src/database/schema/auditLogs.ts
import { pgTable, uuid, timestamp, varchar, jsonb } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { users } from "./users";

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 50 }).notNull(), // create, update, delete, export, share
  entityType: varchar("entity_type", { length: 50 }).notNull(), // note, project, workspace
  entityId: uuid("entity_id").notNull(),
  metadata: jsonb("metadata").default({}),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### API Keys Table

```typescript
// apps/api/src/database/schema/apiKeys.ts
import { pgTable, uuid, varchar, timestamp, boolean } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { users } from "./users";

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  createdById: uuid("created_by_id").references(() => users.id).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  keyHash: varchar("key_hash", { length: 255 }).notNull(),
  keyPrefix: varchar("key_prefix", { length: 8 }).notNull(),
  scopes: varchar("scopes", { length: 255 }).default("read,write").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

---

## Core Features Specification

### 1. White A4/Letter Page Layout

The editor must render a fixed-width page container that visually resembles physical paper:

- **A4 Dimensions**: 210mm × 297mm (approx 794px × 1123px at 96 DPI)
- **Letter Dimensions**: 8.5" × 11" (approx 816px × 1056px at 96 DPI)
- **Page Margins**: 25mm top/bottom, 20mm left/right (configurable in settings)
- **Background**: White page (`#ffffff`) with subtle shadow (`box-shadow: 0 0 20px rgba(0,0,0,0.08)`) on a light gray workspace background (`#f5f5f5`)
- **Page Breaks**: Visual dashed line indicator when content exceeds one page height
- **Print Mode**: `@media print` CSS hides all UI chrome (sidebar, toolbar, headers) and outputs clean pages with proper margins
- **Focus Mode**: Toggle to hide sidebar and top bar, showing only the page and a floating minimal toolbar
- **Zoom Controls**: 50%, 75%, 100%, 125%, 150%, Fit to Width, Fit to Page
- **Page Size Toggle**: Switch between A4 and Letter in note settings (per-note or global default)

**Component**: `PageContainer.tsx` wraps the TipTap editor, applies page dimensions via CSS, handles zoom transforms, and manages page break visual indicators.

### 2. Rich Text Editor (TipTap)

The editor is the core interaction surface. Use TipTap 2.x with the following extensions and custom features:

**Basic Formatting Extensions**:
- `StarterKit` (bold, italic, strike, code, heading, bulletList, orderedList, blockquote, horizontalRule, hardBreak)
- `Underline` extension
- `TextStyle` + `FontSize` (font sizes: 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72px)
- `TextAlign` (left, center, right, justify)
- `Color` (text color picker)
- `Highlight` (background color)
- `Subscript` / `Superscript`
- `CodeBlockLowlight` with syntax highlighting

**Advanced Extensions**:
- `Table` (create, resize, merge cells, add/remove rows and columns)
- `TaskList` + `TaskItem` (checklists with nested support)
- `Placeholder` (show "Start writing..." when empty)
- `Gapcursor` (click between blocks)
- `Dropcursor` (visual indicator during drag)
- `History` (undo/redo with keyboard shortcuts)

**Custom Extensions**:
- `CustomImage`: Handles image upload, resize, caption, alt text
- `PageBreak`: Insert visual page break for print layout
- `Mention`: `@username` to mention workspace members
- `SlashCommand`: Type `/` to open command menu

**Slash Commands Menu**:
Triggered by typing `/` at the start of a line. Options include:
- `/heading 1` through `/heading 3`
- `/paragraph`
- `/bullet-list`
- `/ordered-list`
- `/task-list`
- `/table`
- `/blockquote`
- `/code-block`
- `/divider`
- `/image`
- `/page-break`

**Markdown Shortcuts** (type and space to convert):
- `#` → Heading 1
- `##` → Heading 2
- `###` → Heading 3
- `>` → Blockquote
- `-` or `*` → Bullet list
- `1.` → Ordered list
- `[]` or `[ ]` → Task item
- `---` or `***` → Horizontal rule
- ` ``` ` → Code block
- `**text**` → Bold (auto-format while typing)

**Keyboard Shortcuts**:
- `Ctrl/Cmd + B` → Bold
- `Ctrl/Cmd + I` → Italic
- `Ctrl/Cmd + U` → Underline
- `Ctrl/Cmd + K` → Insert link
- `Ctrl/Cmd + Z` → Undo
- `Ctrl/Cmd + Shift + Z` → Redo
- `Ctrl/Cmd + Shift + S` → Strikethrough

**Component**: `TiptapEditor.tsx` is the main editor instance. `EditorToolbar.tsx` is the floating/fixed toolbar with formatting controls.

### 3. Image Handling

Images in notes support multiple input methods and manipulations:

**Paste from Clipboard**:
- Detect `image/*` in clipboard on `paste` event
- Show temporary base64 placeholder immediately for instant feedback
- Upload to MinIO in background via API
- Replace placeholder with permanent URL once upload completes
- Show upload progress indicator on the placeholder

**Drag and Drop**:
- Accept image files dragged from desktop onto the editor
- Show visual drop zone indicator (border highlight) when dragging over editor
- Handle multiple files dropped at once
- Insert images at the drop position (cursor location)
- Same upload flow as paste (placeholder → permanent URL)

**Upload Button**:
- Toolbar button opens file picker (`accept="image/*"`)
- Support multiple file selection
- Same upload flow

**Image Manipulation**:
- **Resize**: Drag corner handles to resize, maintain aspect ratio by default (hold Shift to freeform)
- **Caption**: Click below image to add caption text
- **Alt Text**: Right-click context menu or sidebar panel
- **Alignment**: Left, center, right, full-width
- **Wrap Text**: Inline or break text (figure style)

**Image Processing**:
- Server-side compression with Sharp before MinIO storage
- Generate multiple sizes: thumbnail (200px width), medium (800px), full (original)
- Store original + processed variants in MinIO
- Lazy load images with blur-up placeholder

**Supported Formats**: JPEG, PNG, GIF, WebP, SVG, HEIC (convert to JPEG)

**Storage**: MinIO bucket `notted-attachments` with path pattern `{workspaceId}/{noteId}/{timestamp}-{filename}`

### 4. Checklists and Task Management

Checklists are first-class content within notes and can also exist as standalone task notes.

**Inline Checklists** (within rich notes):
- Use TipTap `TaskList` + `TaskItem` extensions
- Nested checklist items (indent with Tab, outdent with Shift+Tab)
- Click checkbox to toggle complete/incomplete
- Visual strikethrough on completed items
- Progress indicator in note list view (e.g., "5/12 done")

**Standalone Task Notes**:
- Note type toggle: "Document" vs "Task List"
- Task List notes have simplified editor (no rich text, just tasks)
- Each task has: checkbox, text, due date, assignee, priority
- Drag to reorder tasks
- Bulk actions: select multiple, mark complete, delete, assign

**Task Properties**:
- **Due Date**: Date picker, optional time
- **Assignee**: Dropdown of workspace members
- **Priority**: Low (gray), Medium (yellow), High (red), Urgent (purple)
- **Tags**: Link to workspace tags
- **Recurring**: Daily, Weekly, Monthly, Custom (cron expression)

**Task Views**:
- **List View**: Flat or grouped by status
- **Board View**: Kanban columns (To Do, In Progress, Done, Custom)
- **Calendar View**: Tasks on calendar by due date

**Progress Tracking**:
- Note card shows circular progress indicator
- Project view shows aggregate progress across all task notes
- Dashboard widget: "My Tasks" with overdue highlighting

### 5. Project vs. Standalone Notes

**Projects** are containers that group related notes:

**Project Structure**:
- Name, description, cover image (upload or color gradient)
- Color tag for visual identification
- Status: Active, Archived, Completed
- Due date (optional)
- Member list with roles
- Created date, last activity

**Project Views**:
- **Grid View**: Card layout with cover images
- **List View**: Compact list with metadata
- **Board View**: Notes as cards in columns (customizable)
- **Timeline View**: Gantt-style timeline

**Standalone Notes** exist outside projects at the workspace root level:

**Organization Methods**:
- **Tags**: Multiple tags per note, tag cloud in sidebar
- **Favorites**: Pin important notes to top
- **Recent**: Auto-sorted by last edited
- **Folders**: Optional folder structure (nested up to 3 levels)

**Note Hierarchy**:
- Notes can have child notes (parent-child relationship)
- Child notes appear as nested items in sidebar
- Collapse/expand parent notes
- Drag to reorder or reparent

### 6. Attachments

Non-image file attachments support:

**Supported File Types**:
- Documents: PDF, DOCX, TXT, RTF, MD
- Spreadsheets: XLSX, CSV
- Archives: ZIP, RAR, 7Z, TAR
- Code files: JS, TS, HTML, CSS, JSON, XML, PY, etc.
- Max file size: 50MB per file (configurable per workspace plan)

**Upload Flow**:
- Drag and drop files onto note or use attachment button
- Upload to MinIO `notted-attachments` bucket
- Display as attachment card in note (filename, size, type icon)
- Click to download with original filename preserved
- Optional: inline preview for PDFs (PDF.js viewer)

**Attachment Card UI**:
- File type icon (PDF icon, ZIP icon, etc.)
- Filename (truncated if long)
- File size (human-readable: KB, MB)
- Upload date
- Download button
- Delete button (with confirmation)

**Storage Management**:
- Total storage used shown in workspace settings
- Orphaned attachment cleanup (files not linked to any note)
- Storage quota enforcement per workspace plan

### 7. Version History

Every note save creates a version snapshot:

**Version Storage**:
- On each update, copy current content to `note_versions` table
- Increment version number
- Store who made the change and when

**Version UI**:
- Sidebar panel showing version list (timestamp + author)
- Click version to preview read-only
- Side-by-side diff view (highlight additions in green, deletions in red)
- "Restore this version" button (creates new version with restored content, does not delete history)

**Version Limits**:
- Free plan: Last 30 days of versions
- Pro plan: Unlimited versions
- Auto-purge old versions based on plan

### 8. Export Capabilities

**Export Formats**:
- **PDF**: Server-side generation with Puppeteer, preserves A4/Letter layout, page numbers, headers/footers
- **Markdown**: Convert TipTap JSON to Markdown
- **HTML**: Standalone HTML file with embedded styles
- **DOCX**: Microsoft Word format (using `docx` library)
- **TXT**: Plain text extraction

**Export Options**:
- Include/exclude attachments (as separate files in ZIP)
- Include/exclude comments
- Include/exclude version history
- Custom header/footer text

**Export Flow**:
- User selects format and options
- API creates background job (BullMQ)
- Job generates file, uploads to MinIO `notted-exports` bucket
- Email notification with download link when ready
- Download link expires after 7 days

### 9. Search

**Full-Text Search** (Meilisearch):
- Index all notes on create/update
- Search across: title, content (plain text), tags
- Typo tolerance (1-2 character mistakes)
- Highlight matching terms in results
- Filters: workspace, project, author, date range, has attachments
- Sort by: relevance, date created, date updated

**Semantic Search** (pgvector):
- Generate embeddings on note create/update (background job)
- Search using natural language: "notes about Q3 budget"
- Return results ranked by cosine similarity
- Hybrid search: combine Meilisearch text + semantic results

**Search UI**:
- Global search bar (Cmd/Ctrl + K shortcut)
- Inline search within project/workspace
- Recent searches
- Search suggestions

### 10. Real-Time Collaboration (Socket.io)

**Live Presence**:
- Show list of users currently viewing a note
- Display colored cursor positions with user name labels
- "User is typing..." indicators

**Live Editing**:
- Operational Transform or Yjs CRDT for conflict resolution
- Character-level sync (not just save-on-blur)
- Optimistic updates with server reconciliation

**Live Comments**:
- Inline comment threads on selected text
- Real-time comment updates
- Resolve/unresolve threads
- Email notifications for mentions (background job)

**Connection Management**:
- Reconnect on network interruption
- Queue offline changes, sync on reconnect
- Presence heartbeat (every 30 seconds)

### 11. AI Features

**Smart Summarize**:
- One-click summary of long notes
- Adjustable length: brief (1 paragraph), medium (3 paragraphs), detailed (bullet points)
- Streaming response displayed in sidebar panel

**Continue Writing**:
- AI suggests continuation based on current content and context
- Triggered by `Ctrl/Cmd + Enter` or toolbar button
- Accept, regenerate, or dismiss suggestions

**Tone Rewrite**:
- Transform selected text: Professional, Casual, Concise, Elaborate, Simplify
- Replace selected text or insert as new paragraph

**Meeting Notes Extractor**:
- Paste raw meeting transcript (from Zoom, Teams, etc.)
- AI structures into: Attendees, Agenda, Discussion Points, Action Items, Decisions
- Action items auto-converted to checklist

**Auto-Tagging**:
- AI analyzes note content on save
- Suggests relevant tags from workspace tag pool
- User confirms or rejects suggestions

**Grammar & Style Check**:
- Underline potential issues (spelling, grammar, clarity)
- Hover to see suggestion, click to apply
- Toggle on/off per user preference

**AI Configuration**:
- Workspace admin selects default AI provider (OpenAI, Claude, or disabled)
- API keys stored encrypted in database
- Usage tracking and quotas per workspace

### 12. Authentication & Authorization

**Better Auth Setup**:
- Self-hosted, all user data in PostgreSQL
- Session storage in Redis (faster lookups, TTL expiry)

**Auth Methods**:
- Email + Password (with strength requirements: min 8 chars, mixed case, number, symbol)
- Magic Link (passwordless email login)
- OAuth 2.0: Google, GitHub, Microsoft (configurable per workspace)
- Two-Factor Authentication (TOTP via authenticator app)
- Passkeys (WebAuthn) for passwordless biometric login

**Session Management**:
- JWT access tokens (15-minute expiry)
- Refresh tokens stored in httpOnly cookies
- Session list in user settings (view active sessions, revoke remotely)
- "Remember me" option (30-day session vs 1-day)

**Workspace Roles**:
- **Owner**: Full control, billing, delete workspace
- **Admin**: Manage members, settings, all notes
- **Editor**: Create/edit notes, manage own content
- **Viewer**: Read-only access, can comment

**Permissions Matrix**:
| Action | Owner | Admin | Editor | Viewer |
|--------|-------|-------|--------|--------|
| View notes | Yes | Yes | Yes | Yes |
| Create notes | Yes | Yes | Yes | No |
| Edit any note | Yes | Yes | Yes* | No |
| Delete any note | Yes | Yes | No | No |
| Manage members | Yes | Yes | No | No |
| Change settings | Yes | Yes | No | No |
| View billing | Yes | No | No | No |
| Delete workspace | Yes | No | No | No |

*Editors can edit notes they created or that are explicitly shared with them

### 13. Background Jobs (BullMQ)

**Job Types**:
- **Email Jobs**: Send welcome emails, password resets, mention notifications, export ready notifications
- **Indexing Jobs**: Sync note changes to Meilisearch index
- **Embedding Jobs**: Generate vector embeddings for semantic search
- **Export Jobs**: Generate PDF/DOCX files (CPU-intensive, run on separate worker)
- **Cleanup Jobs**: Purge old versions, delete orphaned attachments, archive inactive projects
- **AI Jobs**: Process AI requests (summarize, rewrite, extract) with rate limiting

**Queue Configuration**:
- Default queue: High-priority jobs (indexing, emails)
- Export queue: CPU-intensive with concurrency limit of 2
- AI queue: Rate-limited to prevent API quota exhaustion
- Failed jobs: Retry 3 times with exponential backoff, then move to dead letter queue

**Bull Board Dashboard**:
- Mount at `/admin/queues` (admin only)
- View queue stats, active jobs, completed jobs, failed jobs
- Retry failed jobs manually
- Clean completed/failed jobs

### 14. Email System

**Nodemailer Configuration**:
- SMTP transport configurable via environment variables
- Support for: Gmail, Outlook, AWS SES, SendGrid SMTP, Mailgun SMTP, or any SMTP server
- Development: Mailpit container captures all emails at `http://localhost:8025`

**Email Templates** (React Email):
- Welcome email (after registration)
- Magic link login
- Password reset
- Email verification
- Mention notification ("@username mentioned you in 'Note Title'")
- Export ready notification with download link
- Workspace invitation
- Daily/weekly digest (optional)

**Email Queue**:
- All emails sent via BullMQ job
- Retry on failure (3 attempts)
- Track delivery status

### 15. API & Webhooks

**REST API** (NestJS controllers):
- Full CRUD for all entities
- Pagination, filtering, sorting on list endpoints
- Rate limiting: 100 requests/minute per API key, 1000/minute per authenticated user

**API Keys**:
- Workspace admins can create API keys
- Scoped permissions: read, write, admin
- Key prefix shown in UI, full key shown only once on creation
- Revoke keys instantly

**Webhooks**:
- Workspace admins configure webhook URLs
- Events: note.created, note.updated, note.deleted, project.created, member.joined
- Signature verification with HMAC-SHA256
- Retry failed deliveries (exponential backoff, max 5 attempts)
- Delivery logs visible in workspace settings

### 16. White-Label & Customization

**Workspace Branding**:
- Upload custom logo (replaces Notted logo in header)
- Set primary accent color (affects buttons, links, highlights)
- Custom CSS injection (enterprise feature)

**Custom Domain**:
- Configure DNS CNAME to point to server
- SSL certificate auto-provisioned (via Let's Encrypt in Nginx/Traefik)
- Cookies scoped to custom domain

**Email Branding**:
- Emails sent from workspace domain
- Custom email templates with workspace logo

---

## Environment Variables

Create `.env` file from this template:

```bash
# Application
NODE_ENV=production
APP_URL=https://notted.yourdomain.com
API_URL=https://api.notted.yourdomain.com
WS_URL=wss://api.notted.yourdomain.com

# Database
DB_USER=notted
DB_PASSWORD=your_secure_random_password_here
DB_NAME=notted
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}

# Redis
REDIS_URL=redis://redis:6379

# MinIO (Object Storage)
MINIO_ROOT_USER=nottedminio
MINIO_ROOT_PASSWORD=your_secure_minio_password_here
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_BUCKET_ATTACHMENTS=notted-attachments
MINIO_BUCKET_EXPORTS=notted-exports
MINIO_CONSOLE_URL=https://minio-console.yourdomain.com

# Meilisearch
MEILI_MASTER_KEY=your_secure_meili_master_key_here
MEILISEARCH_HOST=http://meilisearch:7700

# Better Auth
BETTER_AUTH_SECRET=your_secure_auth_secret_here_min_32_chars
BETTER_AUTH_URL=${APP_URL}

# Email (SMTP)
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=your-email@gmail.com
EMAIL_SMTP_PASSWORD=your-app-password
EMAIL_FROM=Notted <noreply@yourdomain.com>

# AI Providers (optional - leave blank to disable AI features)
AI_OPENAI_API_KEY=sk-your-openai-key
AI_OPENAI_MODEL=gpt-4o
AI_CLAUDE_API_KEY=sk-your-anthropic-key
AI_CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Security
CORS_ORIGIN=${APP_URL}
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

---

## Deployment Instructions

### Server Requirements

- **OS**: Ubuntu 22.04 LTS (recommended)
- **CPU**: 2+ cores
- **RAM**: 4GB minimum (8GB recommended)
- **Storage**: 40GB SSD minimum
- **Ports**: 80, 443 (web), 22 (SSH)

### Step 1: Server Setup

Run `scripts/setup.sh` on fresh Ubuntu server:

```bash
#!/bin/bash
# scripts/setup.sh

set -e

echo "=== Notted Server Setup ==="

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER

# Install Docker Compose
apt install -y docker-compose-plugin

# Install Node.js (for build process)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install pnpm
npm install -g pnpm

# Install Nginx (reverse proxy)
apt install -y nginx

# Install Certbot (SSL)
apt install -y certbot python3-certbot-nginx

# Create app directory
mkdir -p /opt/notted
chown $USER:$USER /opt/notted

# Setup firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "=== Setup Complete ==="
echo "Reboot or run 'newgrp docker' to apply group changes"
```

### Step 2: SSL Certificate (Let's Encrypt)

```bash
sudo certbot --nginx -d notted.yourdomain.com -d api.notted.yourdomain.com
```

### Step 3: Nginx Configuration

Create `/etc/nginx/sites-available/notted`:

```nginx
# Frontend
server {
    listen 443 ssl http2;
    server_name notted.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/notted.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notted.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# API + WebSocket
server {
    listen 443 ssl http2;
    server_name api.notted.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/notted.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notted.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

Enable:
```bash
sudo ln -s /etc/nginx/sites-available/notted /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 4: Deploy Application

Run `scripts/deploy.sh`:

```bash
#!/bin/bash
# scripts/deploy.sh

set -e

APP_DIR="/opt/notted"
REPO_URL="git@github.com:yourusername/notted.git"

echo "=== Deploying Notted ==="

# Clone or pull latest
if [ -d "$APP_DIR/.git" ]; then
    cd $APP_DIR
    git pull origin main
else
    git clone $REPO_URL $APP_DIR
    cd $APP_DIR
fi

# Install dependencies
pnpm install

# Build packages
pnpm build

# Copy environment file
cp /opt/notted-secrets/.env docker/.env

# Run database migrations
cd apps/api
pnpm drizzle-kit migrate
cd ../..

# Deploy with Docker Compose
cd docker
docker compose down
docker compose up -d --build

# Cleanup old images
docker image prune -f

echo "=== Deployment Complete ==="
```

### Step 5: Database Migrations

Run migrations manually:
```bash
cd apps/api
pnpm drizzle-kit generate  # Generate migration files
pnpm drizzle-kit migrate   # Apply migrations
pnpm drizzle-kit studio    # Open Drizzle Studio (local dev)
```

### Step 6: Backup Script

`scripts/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/opt/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# Backup PostgreSQL
docker exec notted-postgres pg_dump -U notted notted | gzip > $BACKUP_DIR/notted_db_$DATE.sql.gz

# Backup MinIO data
docker run --rm -v notted_minio_data:/data -v $BACKUP_DIR:/backup alpine tar czf /backup/notted_minio_$DATE.tar.gz -C /data .

# Keep only last 7 days
find $BACKUP_DIR -type f -mtime +7 -delete

echo "Backup completed: $DATE"
```

Add to crontab:
```bash
0 2 * * * /opt/notted/scripts/backup.sh >> /var/log/notted-backup.log 2>&1
```

---

## Development Workflow

### Local Development Setup

```bash
# 1. Clone repository
git clone git@github.com:yourusername/notted.git
cd Notted

# 2. Start the complete development environment
docker compose up
```

No host Node.js, pnpm installation, environment copy, migration command, seed command, or
separate application terminal is required. See `docs/README.md` for port overrides,
host-side quality tooling, and lifecycle commands.

### Available Make Commands

Create `Makefile` at root:

```makefile
.PHONY: dev build test deploy migrate backup

dev:
	docker compose up

build:
	pnpm build

test:
	pnpm test

migrate:
	cd apps/api && pnpm drizzle-kit migrate

generate:
	cd apps/api && pnpm drizzle-kit generate

studio:
	cd apps/api && pnpm drizzle-kit studio

seed:
	cd apps/api && pnpm tsx src/database/seed.ts

deploy:
	./scripts/deploy.sh

backup:
	./scripts/backup.sh

logs:
	cd docker && docker compose logs -f

down:
	cd docker && docker compose down

clean:
	cd docker && docker compose down -v
	docker system prune -f
```

---

## AI Coding Conventions (CLAUDE.md)

Create `CLAUDE.md` at repository root:

```markdown
# Notted - AI Coding Conventions

## Architecture
- Frontend: Next.js 16 App Router, Server Components by default
- Backend: NestJS with modular architecture
- API: tRPC for type-safe client-server communication
- Database: PostgreSQL 16 with Drizzle ORM
- All database schemas in apps/api/src/database/schema/
- All API endpoints in NestJS controllers, business logic in services

## Naming Conventions
- Files: kebab-case for components, camelCase for utilities
- Components: PascalCase (e.g., NoteCard.tsx)
- Hooks: camelCase starting with "use" (e.g., useWorkspace.ts)
- Database tables: snake_case
- TypeScript types: PascalCase with descriptive names

## Code Style
- Use TypeScript strict mode
- Prefer explicit types over inference for function parameters
- Use async/await, avoid callbacks
- Error handling: Use NestJS filters for API, try/catch with user-friendly messages in frontend

## Database
- All schema changes require migration generation
- Use transactions for multi-table operations
- Always include created_at and updated_at timestamps
- Soft deletes with is_deleted flag and deleted_at timestamp
- Use UUID primary keys (defaultRandom())

## API Design
- RESTful endpoints with clear resource naming
- Version in URL path: /api/v1/...
- Consistent response format: { success: boolean, data?: T, error?: string }
- Pagination: { data: T[], pagination: { page, limit, total, totalPages } }

## Frontend
- Use Server Components for data fetching when possible
- Client Components only when interactivity needed (use "use client")
- Use React Query (TanStack Query) for client-side data fetching
- Form validation with Zod schemas shared between frontend and backend
- Loading states with Suspense boundaries

## State Management
- Server state: tRPC + React Query
- Client state: Zustand (lightweight)
- Real-time: Socket.io with custom hooks

## Security
- Never expose secrets in frontend code
- Validate all inputs with Zod
- Use parameterized queries (Drizzle handles this)
- Rate limit all API endpoints
- CORS configured to allow only APP_URL

## Testing
- Unit tests with Vitest
- API tests with NestJS testing utilities
- E2E tests with Playwright
- Minimum 70% code coverage

## Docker
- Multi-stage builds for minimal image size
- Use alpine variants where possible
- Health checks on all services
- Non-root user in production containers
```

---

## What This Project Demonstrates

| Capability | Evidence |
|-----------|----------|
| Full-Stack Architecture | Next.js + NestJS + PostgreSQL + Redis |
| Type Safety | TypeScript end-to-end, tRPC, Drizzle ORM |
| Database Design | Multi-tenant schema, RLS, versioning, embeddings |
| DevOps & Infrastructure | Docker Compose, Nginx, SSL, backups |
| Authentication & Security | Self-hosted auth, RBAC, sessions, rate limiting |
| Real-Time Systems | Socket.io, WebSockets, presence |
| Search Engineering | Full-text (Meilisearch) + semantic (pgvector) |
| Background Processing | BullMQ, job queues, workers |
| File Storage & Processing | MinIO, Sharp image processing, PDF generation |
| API Design | RESTful APIs, webhooks, API keys |
| Enterprise Features | White-label, custom domains, SSO-ready, audit logs |
| AI Integration | Streaming AI, embeddings, semantic search |
| Code Quality | Monorepo, shared packages, conventions, testing |

---

## Development Steps

> **Cross-session completion records:** The detailed development sequence is maintained in `Plan.md`. Whenever a numbered plan part is completed, its implementer must create or update `docs/completed-parts/part-NN-short-name.md` using `docs/completed-parts/TEMPLATE.md`. These records are the authoritative handoff reference for future agents and sessions and must include implementation details, decisions, changed files, migrations, verification evidence, and remaining work.

1. Initialize repository with Turborepo: `npx create-turbo@latest` (you are already in root folde of this project)
2. Set up pnpm workspace with apps/web and apps/api
3. Configure Docker Compose development environment
4. Initialize Drizzle ORM with first migration
5. Set up Better Auth with email/password login
6. Build TipTap editor with A4 page container
7. Implement workspace and project CRUD
8. Add note creation with rich text editing
9. Implement image upload to MinIO
10. Add Meilisearch indexing
11. Build search UI
12. Add real-time collaboration with Socket.io
13. Integrate AI features
14. Deploy to VPS with Docker Compose
