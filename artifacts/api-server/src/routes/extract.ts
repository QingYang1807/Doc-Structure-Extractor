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
  DocumentQaBody,
  ValidateDocumentBody,
  SegmentDocumentBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

function requireDocumentContent(
  body: { text?: string; imageData?: string[] },
  res: import("express").Response
): boolean {
  const hasText = typeof body.text === "string" && body.text.trim().length > 0;
  const hasImages = Array.isArray(body.imageData) && body.imageData.length > 0;
  if (!hasText && !hasImages) {
    res.status(400).json({
      error: "invalid_request",
      message: "请提供文档内容：text（文本）或 imageData（图片数组）必须至少有一项",
    });
    return false;
  }
  return true;
}

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

const VALIDATION_SYSTEM_MESSAGE = `你是一个专业的文档规则校验助手。你将收到从文档中已抽取的结构化字段列表，请对这些字段进行规则校验，检测常见文档异常。

检测规则（重点检查）：
1. 日期矛盾：结束日期早于开始日期、签署日期晚于生效日期等
2. 金额不一致：同一合同中不同位置的金额数字不匹配（如大写与数字不符）
3. 必填字段缺失：合同缺乙方/甲方、发票缺税率、简历缺联系方式等重要字段值为"未找到"
4. 逻辑错误：条款之间的明显矛盾，如付款日期早于合同签署日期
5. 格式错误：日期格式不规范、金额格式异常等

请以JSON格式返回校验结果：
{
  "validation": [
    {
      "field": "涉及的字段名（如：合同截止日期）",
      "severity": "high/medium/low",
      "issue": "对问题的简洁描述（中文，不超过50字）"
    }
  ]
}

severity说明：
- high：严重问题，可能导致合同无效或重大损失（如日期矛盾、金额严重不符）
- medium：中等风险，需要关注（如重要字段缺失）
- low：提示性问题，建议修正（如格式不规范）

重要：
- 只报告真实存在的问题，不要无中生有
- 如果所有字段都正常，返回 {"validation": []}
- 只返回JSON，不要有其他文字`;

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

async function runValidation(
  fields: Array<{ key: string; value: string; confidence: string }>,
): Promise<Array<{ field: string; severity: string; issue: string }>> {
  const fieldText = fields
    .map((f) => `- ${f.key}：${f.value}（置信度：${f.confidence}）`)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 2048,
    messages: [
      { role: "system", content: VALIDATION_SYSTEM_MESSAGE },
      { role: "user", content: `已抽取字段如下：\n${fieldText}` },
    ],
  });

  const responseContent = completion.choices[0]?.message?.content ?? "{}";

  try {
    const parsed = JSON.parse(responseContent) as { validation?: Array<{ field: string; severity: string; issue: string }> };
    return Array.isArray(parsed.validation) ? parsed.validation : [];
  } catch {
    return [];
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

  if (!requireDocumentContent(body, res)) return;

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

    let validation: Array<{ field: string; severity: string; issue: string }> = [];
    if (fields.length > 0) {
      try {
        validation = await runValidation(fields);
        validation = validation.filter((v) =>
          typeof v.field === "string" &&
          typeof v.issue === "string" &&
          (v.severity === "high" || v.severity === "medium" || v.severity === "low")
        );
      } catch (valErr) {
        req.log.warn({ valErr }, "Validation call failed, returning empty validation");
      }
    }

    res.json({
      id: job!.id,
      template: job!.template,
      fields: job!.fields,
      rawJson: job!.rawJson,
      summary: job!.summary,
      validation,
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

  if (!requireDocumentContent(body, res)) return;

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

const VALIDATE_SYSTEM_MESSAGE = `你是一个专业的文档合规审查助手。你的任务是仔细阅读文档，检测其中存在的各类问题，包括但不限于：
1. **日期冲突**：文档内不同日期之间的矛盾（如签订日期晚于截止日期，有效期已过等）
2. **金额不一致**：大写金额与数字金额不符，不同条款中同一金额的描述矛盾
3. **缺少必要字段**：合同类文档缺少甲方/乙方/签章/合同编号/有效期等必要信息
4. **逻辑错误**：条款之间互相矛盾，义务分配不合理，不可能同时成立的条件
5. **格式错误**：明显的格式问题（如日期格式错误、身份证号位数不符等）

严格规则：
- 只报告文档中实际存在的问题，不要凭空臆测
- 每个问题的 evidence 字段必须是文档原文的逐字引用
- severity 按问题严重性分级：error（严重）、warning（警告）、info（提示）
- type 从以下类别中选择：date_conflict、amount_inconsistency、missing_field、logic_error、format_error、other
- 如果文档完全合规，issues 返回空数组，passed 为 true

严格按照以下 JSON 格式返回，不要有任何其他文字：
{
  "passed": true/false,
  "summary": "一句话总结文档合规情况",
  "issues": [
    {
      "severity": "error|warning|info",
      "type": "date_conflict|amount_inconsistency|missing_field|logic_error|format_error|other",
      "description": "问题的具体描述",
      "location": "问题所在的条款/段落/字段（可选）",
      "evidence": "文档中的原始语句（逐字复制，如无则省略此字段）"
    }
  ]
}`;

const SEGMENT_SYSTEM_MESSAGE = `你是一个专业的法律文档结构化分析助手。你的任务是将用户提供的文档切分为具有语义意义的条款卡片，每个卡片代表文档的一个独立条款或段落。

切分原则：
1. 按自然段落、编号条款、或语义完整性进行切分
2. 每个条款卡片应包含语义完整的内容，不要切分得过细
3. content 字段必须包含该条款的完整原文，一字不差
4. label 应简洁明了，2-6个汉字，准确概括该条款的核心内容
5. type 从以下类型中选择最合适的：
   - preamble：序言/前言/背景说明
   - definitions：定义/术语解释
   - obligations：权利义务
   - payment：付款/费用相关
   - deadline：期限/时间节点
   - liability：违约/赔偿/责任
   - termination：解除/终止/撤销
   - dispute：争议/纠纷/仲裁
   - signature：签署/盖章/附件
   - misc：其他/附则/一般条款
6. summary 用一句话简明扼要地概括该条款的核心内容（不超过50字）

严格按照以下 JSON 格式返回，不要有任何其他文字：
{
  "totalClauses": 数字,
  "clauses": [
    {
      "index": 1,
      "label": "条款标题",
      "type": "preamble|definitions|obligations|payment|deadline|liability|termination|dispute|misc|signature",
      "content": "条款完整原文",
      "summary": "一句话摘要"
    }
  ]
}`;

router.post("/validate", async (req, res) => {
  let body: ReturnType<typeof ValidateDocumentBody.parse>;
  try {
    body = ValidateDocumentBody.parse(req.body);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  if (!requireDocumentContent(body, res)) return;

  try {
    const { text, imageData } = body;

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" } };

    const userContent: ContentPart[] = [];

    if (text && text.trim()) {
      userContent.push({ type: "text", text: `文档内容：\n\n${text}` });
    }

    if (imageData && imageData.length > 0) {
      userContent.push({
        type: "text",
        text: `以下是文档的 ${imageData.length} 张页面图片，请仔细审查其中的合规问题：`,
      });
      for (const dataUri of imageData) {
        userContent.push({ type: "image_url", image_url: { url: dataUri, detail: "high" } });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: VALIDATE_SYSTEM_MESSAGE },
        { role: "user", content: userContent },
      ],
    });

    const responseContent = completion.choices[0]?.message?.content ?? "{}";

    let parsed: {
      passed: boolean;
      summary: string;
      issues: Array<{
        severity: string;
        type: string;
        description: string;
        location?: string;
        evidence?: string;
      }>;
    };
    try {
      parsed = JSON.parse(responseContent) as typeof parsed;
    } catch {
      parsed = { passed: false, summary: "无法解析 AI 响应", issues: [] };
    }

    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const hasErrors = issues.some((i) => i.severity === "error");

    res.json({
      passed: parsed.passed ?? !hasErrors,
      summary: parsed.summary ?? "",
      issues,
    });
  } catch (err) {
    req.log.error({ err }, "Error validating document");
    res.status(500).json({ error: "validate_failed", message: String(err) });
  }
});

router.post("/segment", async (req, res) => {
  let body: ReturnType<typeof SegmentDocumentBody.parse>;
  try {
    body = SegmentDocumentBody.parse(req.body);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  if (!requireDocumentContent(body, res)) return;

  try {
    const { text, imageData } = body;

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" } };

    const userContent: ContentPart[] = [];

    if (text && text.trim()) {
      userContent.push({ type: "text", text: `文档内容：\n\n${text}` });
    }

    if (imageData && imageData.length > 0) {
      userContent.push({
        type: "text",
        text: `以下是文档的 ${imageData.length} 张页面图片，请对文档进行条款切分：`,
      });
      for (const dataUri of imageData) {
        userContent.push({ type: "image_url", image_url: { url: dataUri, detail: "high" } });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 16384,
      messages: [
        { role: "system", content: SEGMENT_SYSTEM_MESSAGE },
        { role: "user", content: userContent },
      ],
    });

    const responseContent = completion.choices[0]?.message?.content ?? "{}";

    let parsed: {
      totalClauses: number;
      clauses: Array<{
        index: number;
        label: string;
        type: string;
        content: string;
        summary: string;
      }>;
    };
    try {
      parsed = JSON.parse(responseContent) as typeof parsed;
    } catch {
      parsed = { totalClauses: 0, clauses: [] };
    }

    const clauses = Array.isArray(parsed.clauses) ? parsed.clauses : [];

    res.json({
      totalClauses: parsed.totalClauses ?? clauses.length,
      clauses,
    });
  } catch (err) {
    req.log.error({ err }, "Error segmenting document");
    res.status(500).json({ error: "segment_failed", message: String(err) });
  }
});

const QA_SYSTEM_MESSAGE = `你是一个专业的文档问答助手。你的职责是：根据用户提供的文档内容，回答用户的问题，并且每个回答都必须以文档原文为据。

严格规则：
1. **答案必须来自文档**：只允许使用文档中明确存在的信息作答。如果文档中没有相关内容，必须直接回复"文档中未提及此信息"，绝对不能编造或推断。
2. **引用必须是逐字原文**：evidence 数组中的每个 quote 字段，必须是文档中的原始语句，一字不差地复制，不得改写或概括。
3. **JSON 格式返回**：严格按照以下 JSON 格式返回，不要有任何其他文字：
{
  "answer": "简洁的回答（1-3句话）",
  "evidence": [
    {
      "quote": "文档中的原始语句（逐字复制）",
      "context": "这段引用与问题的关联说明（1句话）"
    }
  ]
}
4. 如果文档中找不到任何相关证据，evidence 返回空数组 []，answer 说明"文档中未提及"。`;

router.post("/qa", async (req, res) => {
  let body: ReturnType<typeof DocumentQaBody.parse>;
  try {
    body = DocumentQaBody.parse(req.body);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", message: zodErrorMessage(err) });
      return;
    }
    res.status(400).json({ error: "invalid_request", message: String(err) });
    return;
  }

  if (!requireDocumentContent(body, res)) return;

  try {
    const { text, imageData, question } = body;

    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" } };

    const userContent: ContentPart[] = [];

    if (text && text.trim()) {
      userContent.push({
        type: "text",
        text: `文档内容：\n\n${text}\n\n---\n\n问题：${question}`,
      });
    }

    if (imageData && imageData.length > 0) {
      userContent.push({
        type: "text",
        text: `以下是文档的 ${imageData.length} 张页面图片，请阅读后回答问题：${question}`,
      });
      for (const dataUri of imageData) {
        userContent.push({ type: "image_url", image_url: { url: dataUri, detail: "high" } });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: QA_SYSTEM_MESSAGE },
        { role: "user", content: userContent },
      ],
    });

    const responseContent = completion.choices[0]?.message?.content ?? "{}";

    let parsed: { answer: string; evidence: Array<{ quote: string; context: string }> };
    try {
      parsed = JSON.parse(responseContent) as typeof parsed;
    } catch {
      parsed = { answer: "无法解析 AI 响应", evidence: [] };
    }

    res.json({
      answer: parsed.answer ?? "",
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    });
  } catch (err) {
    req.log.error({ err }, "Error answering document question");
    res.status(500).json({ error: "qa_failed", message: String(err) });
  }
});

export default router;
