# Workspace

## Overview

pnpm workspace monorepo using TypeScript. The main artifact is a **文档结构化抽取** (Document Structured Extraction) web application that uses AI to extract structured information from documents.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: OpenAI via Replit AI Integrations (`@workspace/integrations-openai-ai-server`)
- **Frontend**: React + Vite + TailwindCSS + React Query

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── doc-extractor/      # React + Vite frontend (previewPath: /)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-openai-ai-server/ # OpenAI AI integration (Replit-managed)
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml     # pnpm workspace
├── tsconfig.base.json      # Shared TS options
├── tsconfig.json           # Root TS project references
└── package.json            # Root package
```

## Key Features

### Document Extraction App (`artifacts/doc-extractor`)
- **Home page**: Paste or upload document text, select extraction template (contract/invoice/resume/general/custom), click "开始抽取"
- **Results**: Structured field cards (color-coded by confidence: high=green, medium=yellow, low=red), JSON view, AI summary
- **Export**: JSON and CSV export buttons
- **History page**: View all past extractions, click to see details, delete entries
- **Templates**: 合同关键信息, 发票字段, 简历信息, 通用抽取, 自定义字段

### API Endpoints
- `POST /api/extract` — Extract structured fields from document text using GPT-5.2
- `GET /api/history?limit=N` — Get extraction history
- `GET /api/history/:id` — Get single extraction job
- `DELETE /api/history/:id` — Delete extraction job

## Database Schema

### `extraction_jobs` table
- `id`: serial primary key
- `template`: text (contract/invoice/resume/general/custom)
- `text_preview`: text (first 200 chars)
- `raw_text`: text (full document)
- `fields`: jsonb (array of {key, value, confidence})
- `raw_json`: jsonb (key-value map of extracted fields)
- `summary`: text (AI-generated summary)
- `custom_fields`: jsonb (user-defined field names for custom template)
- `field_count`: integer
- `created_at`: timestamp

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Replit AI proxy URL (auto-provisioned)
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Replit AI key (auto-provisioned)
- `PORT` — Service port (auto-assigned per artifact)

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all lib packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — only emit `.d.ts` files during typecheck

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes in `src/routes/`:
- `health.ts` — GET /api/healthz
- `extract.ts` — POST /api/extract, GET/DELETE /api/history routes

### `artifacts/doc-extractor` (`@workspace/doc-extractor`)

React + Vite frontend. Pages in `src/pages/`:
- `home.tsx` — Main extraction page
- `history.tsx` — History list page
- `history-detail.tsx` — Single extraction detail

### `lib/db` (`@workspace/db`)

Database layer. Schema in `src/schema/extraction_jobs.ts`.

Run migrations: `pnpm --filter @workspace/db run push`

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI spec in `openapi.yaml`. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/integrations-openai-ai-server` (`@workspace/integrations-openai-ai-server`)

Pre-configured OpenAI client using Replit AI Integrations. Import: `import { openai } from "@workspace/integrations-openai-ai-server"`
