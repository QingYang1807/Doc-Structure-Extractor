# 智能文档抽取 · DocExtract

基于 GPT-5.2 视觉大模型的智能文档结构化处理平台。支持两种核心模式：**结构化字段抽取**（提取键值对并标注置信度）和 **Markdown 全文转换**（1:1 高保真还原文档为 Markdown）。

---

## 功能概览

### 结构化抽取模式

- 上传或粘贴文档，选择抽取模板，AI 自动提取关键字段并标注置信度（高 / 中 / 低）
- 内置模板：合同关键信息、发票字段、简历信息、通用抽取、自定义字段
- 支持导出为 **JSON** 或 **CSV**
- 结果自动保存至历史记录，可随时查看、删除

### Markdown 转换模式（全文高保真）

- 将任意文档转换为结构完整的 Markdown
- **跨页表格合并**：多页 PDF 中被分页截断的表格自动拼接为完整 Markdown 表格
- **图片替换为描述**：内嵌图片、图表用详细文字描述替换（格式：`> [图片描述：...]`）
- **完整布局保留**：标题层级、列表、粗/斜体、代码块、脚注均用 Markdown 语法还原
- 支持渲染预览（含表格）与原始文本视图，提供一键复制和下载 `.md` 按钮
- 无状态接口，结果不写入历史记录

### 支持的文件格式

| 类别 | 格式 |
|------|------|
| 文本 | `.txt`、`.md` |
| PDF | `.pdf`（含扫描件，自动切换视觉识别） |
| Word | `.docx`、`.doc` |
| 电子表格 | `.xlsx`、`.xls`、`.csv` |
| 演示文稿 | `.pptx` |
| 图片 | `.png`、`.jpg`、`.jpeg`、`.gif`、`.bmp`、`.webp` |

> 扫描版 PDF 或文字量极少的 PDF 会自动以页面截图方式发送给视觉 AI 处理。

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 前端 | React 19 + Vite 7 + TailwindCSS v4 + React Query v5 |
| 后端 | Express 5 + Node.js 24 + TypeScript 5.9 |
| 数据库 | PostgreSQL + Drizzle ORM |
| AI | OpenAI GPT-5.2（via Replit AI Integrations） |
| 校验 | Zod v4 + drizzle-zod |
| API 合约 | OpenAPI 3.1 → Orval 代码生成 |
| 构建 | esbuild（后端），Vite（前端） |
| 包管理 | pnpm workspaces（monorepo） |

---

## 项目结构

```text
.
├── artifacts/                     # 可部署的应用
│   ├── api-server/                # Express API 服务（@workspace/api-server）
│   │   └── src/
│   │       ├── app.ts             # Express 应用入口（中间件、路由挂载）
│   │       ├── index.ts           # 服务启动
│   │       └── routes/
│   │           ├── health.ts      # GET /api/healthz
│   │           └── extract.ts     # /api/extract、/api/markdown-extract、/api/history/*
│   └── doc-extractor/             # React 前端（@workspace/doc-extractor）
│       └── src/
│           ├── pages/
│           │   ├── home.tsx       # 主页（上传/抽取/模式切换）
│           │   ├── history.tsx    # 历史记录列表
│           │   └── history-detail.tsx  # 单条历史记录详情
│           └── components/
├── lib/                           # 共享库
│   ├── api-spec/                  # OpenAPI 规范 + Orval 配置（@workspace/api-spec）
│   │   └── openapi.yaml
│   ├── api-zod/                   # 从 OpenAPI 生成的 Zod 校验模式（@workspace/api-zod）
│   │   └── src/generated/api.ts
│   ├── api-client-react/          # 从 OpenAPI 生成的 React Query hooks（@workspace/api-client-react）
│   │   └── src/generated/
│   │       ├── api.ts             # useExtractDocument、useMarkdownExtract 等 hooks
│   │       └── api.schemas.ts     # TypeScript 接口定义
│   ├── db/                        # Drizzle ORM 模式 + 数据库连接（@workspace/db）
│   │   └── src/schema/
│   │       └── extraction_jobs.ts
│   ├── integrations-openai-ai-server/      # Replit 托管的 OpenAI 客户端（服务端用）
│   ├── integrations-openai-ai-react/       # Replit 托管的 OpenAI 客户端（前端用）
│   └── integrations/
│       └── openai_ai_integrations/         # Replit AI Integrations 底层配置
├── scripts/                       # 工具脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json             # 共享 TypeScript 配置
├── tsconfig.json                  # 根项目引用
└── package.json
```

---

## 本地开发

### 前提条件

- **Node.js** ≥ 24
- **pnpm** ≥ 10（`npm install -g pnpm`）
- **PostgreSQL** 数据库（或直接在 Replit 中使用内置 PostgreSQL）

### 安装依赖

```bash
pnpm install
```

### 环境变量

在项目根目录创建 `.env` 文件（Replit 环境中这些变量已自动注入）：

```env
# PostgreSQL 连接字符串（Replit 自动提供）
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Replit AI Integrations 代理（Replit 自动提供）
AI_INTEGRATIONS_OPENAI_BASE_URL=https://...
AI_INTEGRATIONS_OPENAI_API_KEY=...

# 各 artifact 端口（由 Replit 自动分配，本地开发可手动指定）
PORT=8080
BASE_PATH=/
```

### 数据库迁移

```bash
# 将 Drizzle schema 推送到数据库（创建/更新表结构）
pnpm --filter @workspace/db run push
```

### 启动服务

```bash
# 启动 API 服务（监听 PORT 环境变量，默认 8080）
pnpm --filter @workspace/api-server run dev

# 启动前端开发服务器（另开终端）
pnpm --filter @workspace/doc-extractor run dev
```

前端默认在 `http://localhost:5173`，API 在 `http://localhost:8080`。

### 类型检查 & 构建

```bash
# 类型检查（包含所有 lib 包和 artifacts）
pnpm run typecheck

# 全量构建
pnpm run build
```

---

## API 参考

所有接口均挂载在 `/api` 前缀下。请求体和响应体均为 JSON。

### POST /api/extract

从文档中提取结构化字段，结果保存至数据库历史。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `template` | `"contract" \| "invoice" \| "resume" \| "general" \| "custom"` | 是 | 抽取模板 |
| `text` | `string` | 二选一 | 文档文本内容 |
| `imageData` | `string[]` | 二选一 | Base64 图片 data URI 数组（扫描件/图片） |
| `customFields` | `string[]` | 否 | 自定义字段名列表（`template="custom"` 时有效） |

**响应体**

```json
{
  "id": 42,
  "template": "contract",
  "fields": [
    { "key": "甲方", "value": "北京科技有限公司", "confidence": "high" }
  ],
  "rawJson": { "甲方": "北京科技有限公司" },
  "summary": "这是一份服务合同，...",
  "createdAt": "2026-03-23T08:00:00.000Z"
}
```

---

### POST /api/markdown-extract

将文档转换为高保真 Markdown，**不保存历史**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | `string` | 二选一 | 文档文本 |
| `imageData` | `string[]` | 二选一 | Base64 图片 data URI 数组（PDF 页面截图） |

**响应体**

```json
{
  "markdown": "# 合同标题\n\n## 第一条 ...\n\n| 列1 | 列2 |\n|-----|-----|\n| ... |"
}
```

---

### GET /api/history

获取历史抽取记录列表。

**Query 参数**：`limit`（默认 20，最大 100）

**响应**：`{ items: ExtractionJob[], total: number }`

---

### GET /api/history/:id

获取单条历史记录。返回 `ExtractionJob` 对象，或 `404`。

---

### DELETE /api/history/:id

删除单条历史记录。返回 `{ success: true }` 或 `404`。

---

### GET /api/healthz

健康检查，返回 `{ status: "ok" }`。

---

## 数据库结构

### 表：`extraction_jobs`

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | `serial` PK | 自增主键 |
| `template` | `text` | 使用的模板名称 |
| `text_preview` | `text` | 文档前 200 字符预览 |
| `raw_text` | `text` | 完整文档文本 |
| `fields` | `jsonb` | 字段数组：`[{ key, value, confidence }]` |
| `raw_json` | `jsonb` | 字段键值映射：`{ "字段名": "值" }` |
| `summary` | `text` | AI 生成的文档摘要 |
| `custom_fields` | `jsonb` | 自定义字段名列表（nullable） |
| `field_count` | `integer` | 提取到的字段数 |
| `created_at` | `timestamp` | 创建时间（默认 now()） |

---

## 代码生成（API 合约更新流程）

生成层由 **Orval** 驱动，从 `lib/api-spec/openapi.yaml` 自动生成以下两个包的代码：

- `lib/api-client-react/src/generated/` — React Query hooks + TypeScript 接口
- `lib/api-zod/src/generated/` — Zod 校验模式（后端请求校验用）

当需要修改 API 接口时，按以下顺序操作：

1. **修改 OpenAPI 规范**（`lib/api-spec/openapi.yaml`）
2. **运行代码生成**：
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```
   Orval 会自动重新生成 `lib/api-client-react/src/generated/` 和 `lib/api-zod/src/generated/` 中的所有文件。
3. **重新构建 lib 声明文件**（让 TypeScript 项目引用看到新类型）：
   ```bash
   pnpm run typecheck
   ```
4. **在后端路由** `artifacts/api-server/src/routes/extract.ts` 中添加处理函数
5. **在前端** `artifacts/doc-extractor/src/pages/home.tsx` 中调用新 hook

---

## 扩展指南：添加一个新 API 路由

以添加 `POST /api/summarize` 为例：

**1. 在 OpenAPI 规范中声明**（`lib/api-spec/openapi.yaml`）

```yaml
/summarize:
  post:
    operationId: summarizeDocument
    tags: [extraction]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/SummarizeRequest"
    responses:
      "200":
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/SummarizeResponse"
```

**2. 运行 Orval 代码生成**

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
```

生成后 `lib/api-zod/src/generated/api.ts` 中会自动出现：

```typescript
export const SummarizeBody = zod.object({
  text: zod.string().min(1),
});
```

以及 `lib/api-client-react/src/generated/api.ts` 中的 hook：

```typescript
export const useSummarizeDocument = (options?) =>
  useMutation(getSummarizeDocumentMutationOptions(options));
```

**3. 实现后端路由**（`artifacts/api-server/src/routes/extract.ts`）

```typescript
router.post("/summarize", async (req, res) => {
  const body = SummarizeBody.parse(req.body);
  const result = await openai.chat.completions.create({ ... });
  res.json({ summary: result.choices[0]?.message?.content });
});
```

**4. 在前端调用**（`artifacts/doc-extractor/src/pages/home.tsx`）

```typescript
const summarizeMutation = useSummarizeDocument();
summarizeMutation.mutate({ data: { text } });
```

---

## 项目维护说明

- **TypeScript 复合项目**：所有 `lib/` 包使用 `composite: true`，通过项目引用共享类型。修改 lib 后须先运行 `tsc -p tsconfig.json` 重新生成 `.d.ts` 文件，否则引用方看不到新类型。
- **体积限制**：API 服务的请求体限制为 **50 MB**（`express.json({ limit: "50mb" })`），足以容纳 20 页 PDF 的 Base64 编码图片数据。
- **Markdown 转换 PDF 上限**：单次转换最多处理 **20 页**，超出部分前端会显示截断提示。

---

## License

MIT
