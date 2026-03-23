import { Router, type IRouter } from "express";
import { ZodError } from "zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db } from "@workspace/db";
import { extractionJobsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  ExtractDocumentBody,
  GetHistoryQueryParams,
  GetHistoryItemParams,
  DeleteHistoryItemParams,
  MarkdownExtractBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

const TEMPLATE_PROMPTS: Record<string, string> = {
  contract: `请从以下合同文档中提取关键信息，包括但不限于：
- 合同双方（甲方、乙方）
- 合同标的/服务内容
- 合同金额
- 付款方式
- 合同期限（起始日期、截止日期）
- 违约责任
- 争议解决方式
- 签署日期
- 联系人/负责人`,
  invoice: `请从以下发票/票据中提取关键信息，包括但不限于：
- 发票号码
- 开票日期
- 购买方（买方名称、税号）
- 销售方（卖方名称、税号）
- 商品/服务名称
- 数量
- 单价
- 金额
- 税率
- 税额
- 价税合计
- 开票人`,
  resume: `请从以下简历中提取关键信息，包括但不限于：
- 姓名
- 联系方式（手机、邮箱）
- 出生年月
- 教育背景（学校、专业、学历、时间）
- 工作经历（公司、职位、时间段、主要职责）
- 技能/专长
- 证书/资质
- 自我评价`,
  general: `请从以下文档中提取所有重要的结构化信息，包括：
- 文档类型
- 关键人物/机构名称
- 重要日期
- 金额数字
- 地址/地点
- 联系方式
- 核心内容要点
- 重要条款或约定`,
};

function buildPrompt(template: string, customFields?: string[]): string {
  if (template === "custom" && customFields && customFields.length > 0) {
    const fieldList = customFields.map((f) => `- ${f}`).join("\n");
    return `请从以下文档中提取以下字段的信息：\n${fieldList}`;
  }
  return TEMPLATE_PROMPTS[template] ?? TEMPLATE_PROMPTS.general;
}

function zodErrorMessage(err: ZodError): string {
  return err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
}

const SYSTEM_MESSAGE = `你是一个专业的文档信息抽取助手。请仔细阅读用户提供的文档（文字或图片），按照要求提取结构化信息。
    
请以JSON格式返回结果，格式如下：
{
  "fields": [
    {
      "key": "字段名称",
      "value": "提取的值（若未找到则填写'未找到'）",
      "confidence": "high/medium/low（提取的置信度）"
    }
  ],
  "summary": "对文档内容的简要摘要（2-3句话）"
}

confidence字段规则：
- high: 明确提及，无歧义
- medium: 可以推断，但不完全确定
- low: 仅为猜测或文档中未明确提及

只返回JSON，不要有其他文字。`;

async function runExtraction(
  prompt: string,
  text?: string,
  imageData?: string[],
): Promise<{ fields: Array<{ key: string; value: string; confidence: string }>; summary: string }> {
  type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "high" } };

  const userContent: ContentPart[] = [];

  if (text && text.trim()) {
    userContent.push({ type: "text", text: `${prompt}\n\n文档内容：\n${text}` });
  }

  if (imageData && imageData.length > 0) {
    userContent.push({ type: "text", text: prompt });
    for (const dataUri of imageData) {
      userContent.push({ type: "image_url", image_url: { url: dataUri, detail: "high" } });
    }
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: userContent },
    ],
  });

  const responseContent = completion.choices[0]?.message?.content ?? "{}";

  try {
    return JSON.parse(responseContent) as {
      fields: Array<{ key: string; value: string; confidence: string }>;
      summary: string;
    };
  } catch {
    return { fields: [], summary: "无法解析响应" };
  }
}

router.post("/extract", async (req, res) => {
  let body: ReturnType<typeof ExtractDocumentBody.parse>;
  try {
    body = ExtractDocumentBody.parse(req.body);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  try {
    const { text, imageData, template, customFields } = body;

    const prompt = buildPrompt(template, customFields ?? undefined);
    const parsed = await runExtraction(prompt, text, imageData);

    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];
    const summary = parsed.summary ?? "";
    const rawJson: Record<string, unknown> = {};
    for (const field of fields) {
      rawJson[field.key] = field.value;
    }

    const textPreview = (text ?? (imageData ? `[图片文件，共 ${imageData.length} 张]` : "")).slice(0, 200);

    const [job] = await db
      .insert(extractionJobsTable)
      .values({
        template,
        textPreview,
        rawText: text ?? "",
        fields,
        rawJson,
        summary,
        customFields: customFields ?? null,
        fieldCount: fields.length,
      })
      .returning();

    res.json({
      id: job!.id,
      template: job!.template,
      fields: job!.fields,
      rawJson: job!.rawJson,
      summary: job!.summary,
      createdAt: job!.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error extracting document");
    res.status(500).json({ error: "extraction_failed", message: String(err) });
  }
});

router.get("/history", async (req, res) => {
  let params: ReturnType<typeof GetHistoryQueryParams.parse>;
  try {
    params = GetHistoryQueryParams.parse(req.query);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  try {
    const { limit } = params;
    const jobs = await db
      .select()
      .from(extractionJobsTable)
      .orderBy(desc(extractionJobsTable.createdAt))
      .limit(limit ?? 20);

    const total = await db.$count(extractionJobsTable);

    const items = jobs.map((job) => ({
      id: job.id,
      template: job.template,
      textPreview: job.textPreview,
      fields: job.fields,
      rawJson: job.rawJson,
      summary: job.summary,
      createdAt: job.createdAt,
    }));

    res.json({ items, total });
  } catch (err) {
    req.log.error({ err }, "Error fetching history");
    res.status(500).json({ error: "history_failed", message: String(err) });
  }
});

router.get("/history/:id", async (req, res) => {
  let params: ReturnType<typeof GetHistoryItemParams.parse>;
  try {
    params = GetHistoryItemParams.parse(req.params);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  try {
    const { id } = params;
    const [job] = await db
      .select()
      .from(extractionJobsTable)
      .where(eq(extractionJobsTable.id, id));

    if (!job) {
      res.status(404).json({ error: "not_found", message: "Job not found" });
      return;
    }

    res.json({
      id: job.id,
      template: job.template,
      textPreview: job.textPreview,
      fields: job.fields,
      rawJson: job.rawJson,
      summary: job.summary,
      createdAt: job.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching history item");
    res.status(500).json({ error: "fetch_failed", message: String(err) });
  }
});

router.delete("/history/:id", async (req, res) => {
  let params: ReturnType<typeof DeleteHistoryItemParams.parse>;
  try {
    params = DeleteHistoryItemParams.parse(req.params);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  try {
    const { id } = params;
    const deleted = await db
      .delete(extractionJobsTable)
      .where(eq(extractionJobsTable.id, id))
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: "not_found", message: "Job not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Error deleting history item");
    res.status(500).json({ error: "delete_failed", message: String(err) });
  }
});

const MARKDOWN_SYSTEM_MESSAGE = `你是一个专业的文档转换助手，负责将用户提供的文档（文字或图片）转换成高保真的 Markdown 格式。

请严格遵守以下规则：

1. **全文转换**：保留文档中的全部内容，不得省略或总结任何段落。
2. **结构保留**：用 Markdown 标题（# ## ###）还原文档的层级结构；用有序/无序列表还原列表；用 **粗体** / *斜体* 还原强调；用 \`代码块\` 还原代码或等宽文本；用 > 引用块还原引用内容。
3. **表格合并**：如果文档是多页 PDF，且某个表格跨越两页及以上，请将其合并为一个完整的 Markdown 表格，不得拆分。
4. **图片替换**：文档中的每张内嵌图片、图表、示意图，请用以下格式替换（提供详细的文字描述）：
   > [图片描述：此处用2-4句话详细描述图片/图表的内容、颜色、数据趋势或视觉含义]
5. **脚注与页眉页脚**：保留脚注，格式为 [^n]；页眉页脚（如页码、公司名）可忽略。
6. **只输出 Markdown**：不要添加任何解释性文字、前言或后记，直接输出 Markdown 正文。`;

router.post("/markdown-extract", async (req, res) => {
  let body: ReturnType<typeof MarkdownExtractBody.parse>;
  try {
    body = MarkdownExtractBody.parse(req.body);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  try {
    const { text, imageData } = body;

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" } };

    const userContent: ContentPart[] = [];

    if (text && text.trim()) {
      userContent.push({ type: "text", text: `请将以下文档内容转换为完整 Markdown：\n\n${text}` });
    }

    if (imageData && imageData.length > 0) {
      userContent.push({
        type: "text",
        text: `请将以下 ${imageData.length} 张图片（文档页面）的全部内容转换为完整 Markdown，如果表格跨页请合并：`,
      });
      for (const dataUri of imageData) {
        userContent.push({ type: "image_url", image_url: { url: dataUri, detail: "high" } });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 16384,
      messages: [
        { role: "system", content: MARKDOWN_SYSTEM_MESSAGE },
        { role: "user", content: userContent },
      ],
    });

    const markdown = completion.choices[0]?.message?.content ?? "";

    res.json({ markdown });
  } catch (err) {
    req.log.error({ err }, "Error converting document to Markdown");
    res.status(500).json({ error: "markdown_extract_failed", message: String(err) });
  }
});

export default router;
