import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useExtractDocument, useMarkdownExtract } from "@workspace/api-client-react";
import type { ExtractRequestTemplate, ExtractedField } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button, Card, Textarea, Input, Badge } from "@/components/ui-elements";
import {
  FileText, Upload, Sparkles, AlertCircle, FileJson,
  Table as TableIcon, Download, CheckCircle2, Image as ImageIcon,
  Copy, FileCode2,
} from "lucide-react";
import Papa from "papaparse";
import { downloadFile } from "@/lib/utils";
import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const TEMPLATES: { id: ExtractRequestTemplate; label: string; description: string }[] = [
  { id: "contract", label: "合同关键信息", description: "抽取甲方、乙方、金额、日期等" },
  { id: "invoice", label: "发票字段", description: "抽取发票号、开票人、税额等" },
  { id: "resume", label: "简历信息", description: "抽取姓名、教育经历、技能等" },
  { id: "general", label: "通用抽取", description: "自动识别并抽取核心实体" },
  { id: "custom", label: "自定义字段", description: "指定需要抽取的具体字段名称" },
];

const ACCEPTED_EXTS = ".txt,.md,.pdf,.docx,.doc,.xlsx,.xls,.csv,.pptx,.png,.jpg,.jpeg,.gif,.bmp,.webp";
const ACCEPTED_LABEL = "TXT、MD、PDF（含扫描件）、Word、Excel、CSV、PPT、PNG/JPG 等图片";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function pdfPageToDataUri(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function extractFromExcel(buffer: ArrayBuffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: "array" });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet!);
    if (csv.trim()) parts.push(`【工作表: ${sheetName}】\n${csv}`);
  }
  return parts.join("\n\n");
}

async function extractFromPptx(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  const texts: string[] = [];
  for (const slidePath of slideFiles) {
    const xml = await zip.files[slidePath]!.async("string");
    const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
    const slideText = matches.map((m) => m.replace(/<\/?a:t>/g, "")).join(" ").trim();
    if (slideText) texts.push(slideText);
  }
  return texts.join("\n\n");
}

export type ExtractionInput =
  | { kind: "text"; text: string }
  | { kind: "images"; imageData: string[]; label: string };

async function extractInputFromFile(file: File): Promise<ExtractionInput> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item): item is TextItem => "str" in item && typeof (item as TextItem).str === "string")
        .map((item) => item.str)
        .join(" ")
        .trim();
      pages.push(pageText);
    }
    const fullText = pages.join("\n\n");
    const wordCount = fullText.trim().split(/\s+/).filter(Boolean).length;

    if (wordCount >= 10) {
      return { kind: "text", text: fullText };
    }

    const imageData: string[] = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
      const page = await pdf.getPage(i);
      imageData.push(await pdfPageToDataUri(page));
    }
    return { kind: "images", imageData, label: `${file.name}（扫描版 PDF，共 ${pdf.numPages} 页）` };
  }

  if (
    name.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return { kind: "text", text: result.value };
  }

  if (name.endsWith(".doc") || file.type === "application/msword") {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return { kind: "text", text: result.value };
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls") ||
      file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel") {
    const arrayBuffer = await file.arrayBuffer();
    return { kind: "text", text: await extractFromExcel(arrayBuffer) };
  }

  if (name.endsWith(".csv") || file.type === "text/csv") {
    return { kind: "text", text: await file.text() };
  }

  if (name.endsWith(".pptx") ||
      file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const arrayBuffer = await file.arrayBuffer();
    return { kind: "text", text: await extractFromPptx(arrayBuffer) };
  }

  if (
    name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") ||
    name.endsWith(".gif") || name.endsWith(".bmp") || name.endsWith(".webp") ||
    file.type.startsWith("image/")
  ) {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const mimeType = file.type || "image/png";
    return { kind: "images", imageData: [`data:${mimeType};base64,${base64}`], label: file.name };
  }

  return { kind: "text", text: await file.text() };
}

type AppMode = "extract" | "markdown";

export default function Home() {
  const [mode, setMode] = useState<AppMode>("extract");
  const [text, setText] = useState("");
  const [imageInput, setImageInput] = useState<{ imageData: string[]; label: string } | null>(null);
  const [template, setTemplate] = useState<ExtractRequestTemplate>("general");
  const [customFieldsStr, setCustomFieldsStr] = useState("");
  const [activeTab, setActiveTab] = useState<"visual" | "json">("visual");
  const [markdownTab, setMarkdownTab] = useState<"preview" | "raw">("preview");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractMutation = useExtractDocument();
  const markdownMutation = useMarkdownExtract();

  const handleModeSwitch = (newMode: AppMode) => {
    setMode(newMode);
    extractMutation.reset();
    markdownMutation.reset();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileError(null);
    setImageInput(null);
    setText("");

    setIsLoadingFile(true);
    try {
      const input = await extractInputFromFile(file);
      if (input.kind === "text") {
        setText(input.text);
      } else {
        setImageInput({ imageData: input.imageData, label: input.label });
      }
    } catch {
      setFileError("文件解析失败，请检查文件格式是否正确");
    } finally {
      setIsLoadingFile(false);
      e.target.value = "";
    }
  };

  const handleSubmit = () => {
    const hasText = text.trim().length > 0;
    const hasImages = imageInput && imageInput.imageData.length > 0;
    if (!hasText && !hasImages) return;

    if (mode === "extract") {
      const customFields =
        template === "custom"
          ? customFieldsStr.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;

      extractMutation.mutate({
        data: {
          ...(hasText ? { text } : {}),
          ...(hasImages ? { imageData: imageInput!.imageData } : {}),
          template,
          ...(customFields && customFields.length > 0 ? { customFields } : {}),
        },
      });
    } else {
      markdownMutation.mutate({
        data: {
          ...(hasText ? { text } : {}),
          ...(hasImages ? { imageData: imageInput!.imageData } : {}),
        },
      });
    }
  };

  const handleExportJSON = () => {
    if (!extractMutation.data) return;
    downloadFile(
      JSON.stringify(extractMutation.data.rawJson, null, 2),
      `extraction-${extractMutation.data.id}.json`,
      "application/json"
    );
  };

  const handleExportCSV = () => {
    if (!extractMutation.data) return;
    const csv = Papa.unparse(
      extractMutation.data.fields.map((f) => ({
        字段名: f.key,
        提取值: f.value,
        置信度: f.confidence,
      }))
    );
    downloadFile(csv, `extraction-${extractMutation.data.id}.csv`, "text/csv;charset=utf-8;");
  };

  const handleCopyMarkdown = () => {
    if (!markdownMutation.data) return;
    navigator.clipboard.writeText(markdownMutation.data.markdown).then(() => {
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 2000);
    });
  };

  const handleDownloadMarkdown = () => {
    if (!markdownMutation.data) return;
    downloadFile(markdownMutation.data.markdown, "document.md", "text/markdown;charset=utf-8;");
  };

  const canSubmit = text.trim().length > 0 || (imageInput != null && imageInput.imageData.length > 0);
  const extractResult = extractMutation.data;
  const markdownResult = markdownMutation.data;
  const hasResult = mode === "extract" ? !!extractResult : !!markdownResult;

  const isPending = mode === "extract" ? extractMutation.isPending : markdownMutation.isPending;
  const isError = mode === "extract" ? extractMutation.isError : markdownMutation.isError;

  return (
    <Layout>
      <div className="flex flex-col lg:flex-row gap-6">

        {/* Left Column: Input Form */}
        <motion.div
          layout
          className={`flex flex-col gap-6 transition-all duration-500 ease-in-out ${hasResult ? "lg:w-1/3" : "lg:w-full max-w-3xl mx-auto"}`}
        >
          <div className="text-center lg:text-left mb-2">
            <h1 className="text-3xl font-display font-bold text-slate-900">智能文档抽取</h1>
            <p className="mt-2 text-slate-500">上传或粘贴文本，AI 将自动处理您的文档。</p>
          </div>

          {/* Mode Toggle */}
          <div className="flex rounded-xl bg-slate-100 p-1 gap-1">
            <button
              onClick={() => handleModeSwitch("extract")}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                mode === "extract"
                  ? "bg-white text-primary shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Sparkles className="w-4 h-4 inline mr-1.5 align-text-bottom" />
              结构化抽取
            </button>
            <button
              onClick={() => handleModeSwitch("markdown")}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                mode === "markdown"
                  ? "bg-white text-primary shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <FileCode2 className="w-4 h-4 inline mr-1.5 align-text-bottom" />
              Markdown 转换
            </button>
          </div>

          <Card className="p-1">
            <div className="p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <label className="font-semibold text-slate-900 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  文档内容
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-primary bg-primary/5 hover:bg-primary/10"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoadingFile}
                >
                  <Upload className="w-3 h-3 mr-1.5" />
                  {isLoadingFile ? "解析中..." : "上传文件"}
                </Button>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept={ACCEPTED_EXTS}
                  onChange={handleFileUpload}
                />
              </div>

              {imageInput ? (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-indigo-50 border border-indigo-200/60">
                  <ImageIcon className="w-5 h-5 text-indigo-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-indigo-900 truncate">{imageInput.label}</p>
                    <p className="text-xs text-indigo-600 mt-0.5">图片/扫描件将通过视觉 AI 进行识别</p>
                  </div>
                  <button
                    className="text-xs text-slate-400 hover:text-slate-600 shrink-0"
                    onClick={() => setImageInput(null)}
                  >
                    清除
                  </button>
                </div>
              ) : (
                <Textarea
                  placeholder={`在此粘贴文档内容，或上传文件（支持 ${ACCEPTED_LABEL}）...`}
                  className="h-64 resize-none bg-slate-50/50 border-slate-200/60 focus:bg-white"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              )}

              {fileError && (
                <div className="text-xs text-rose-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fileError}
                </div>
              )}

              <p className="text-xs text-slate-400">
                支持格式：TXT、MD、PDF（含扫描件）、Word（.docx/.doc）、Excel（.xlsx/.xls）、CSV、PPT（.pptx）、图片（PNG/JPG/GIF/BMP/WEBP）
              </p>
            </div>

            {/* Template selector — only in extract mode */}
            <AnimatePresence>
              {mode === "extract" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-slate-100 p-5 flex flex-col gap-4 bg-slate-50/30">
                    <label className="font-semibold text-slate-900">选择抽取模板</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {TEMPLATES.map((tpl) => (
                        <button
                          key={tpl.id}
                          onClick={() => setTemplate(tpl.id)}
                          className={`
                            text-left p-3 rounded-xl border-2 transition-all duration-200
                            ${template === tpl.id
                              ? "border-primary bg-primary/5 shadow-sm"
                              : "border-transparent bg-white shadow-sm hover:border-slate-200"}
                          `}
                        >
                          <div className="font-medium text-sm text-slate-900">{tpl.label}</div>
                          <div className="text-xs text-slate-500 mt-0.5 line-clamp-1">{tpl.description}</div>
                        </button>
                      ))}
                    </div>

                    <AnimatePresence>
                      {template === "custom" && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="pt-2 pb-1">
                            <label className="text-xs font-medium text-slate-700 mb-1.5 block">
                              自定义字段 (用逗号分隔)
                            </label>
                            <Input
                              placeholder="例如：项目名称, 负责人, 截止日期"
                              value={customFieldsStr}
                              onChange={(e) => setCustomFieldsStr(e.target.value)}
                              className="bg-white"
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="p-5 border-t border-slate-100">
              <Button
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={!canSubmit}
                isLoading={isPending}
              >
                {mode === "extract" ? (
                  <>
                    <Sparkles className="w-5 h-5 mr-2" />
                    {isPending ? "AI 正在分析..." : "开始智能抽取"}
                  </>
                ) : (
                  <>
                    <FileCode2 className="w-5 h-5 mr-2" />
                    {isPending ? "AI 正在转换..." : "开始 Markdown 转换"}
                  </>
                )}
              </Button>
              {isError && (
                <div className="mt-3 p-3 bg-rose-50 text-rose-600 rounded-lg text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{mode === "extract" ? "抽取失败，请检查文档内容或稍后重试。" : "转换失败，请检查文档内容或稍后重试。"}</span>
                </div>
              )}
            </div>
          </Card>
        </motion.div>

        {/* Right Column: Results Panel */}
        <AnimatePresence mode="wait">
          {hasResult ? (
            <motion.div
              key={`results-${mode}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex-1 flex flex-col gap-6"
            >
              {mode === "extract" && extractResult ? (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-display font-bold text-slate-900 flex items-center gap-2">
                      <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                      抽取结果
                    </h2>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={handleExportCSV}>
                        <Download className="w-4 h-4 mr-1.5" /> CSV
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleExportJSON}>
                        <Download className="w-4 h-4 mr-1.5" /> JSON
                      </Button>
                    </div>
                  </div>

                  {extractResult.summary && (
                    <Card className="p-5 bg-gradient-to-br from-blue-50 to-indigo-50/30 border-blue-100/50">
                      <h3 className="text-sm font-bold text-blue-900 mb-2 flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-blue-600" />
                        AI 摘要
                      </h3>
                      <p className="text-sm text-slate-700 leading-relaxed">{extractResult.summary}</p>
                    </Card>
                  )}

                  <Card className="flex-1 flex flex-col min-h-[500px]">
                    <div className="flex border-b border-slate-100 bg-slate-50/50 rounded-t-2xl p-1">
                      <button
                        onClick={() => setActiveTab("visual")}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-xl transition-all ${
                          activeTab === "visual" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        <TableIcon className="w-4 h-4 inline mr-2 align-text-bottom" />
                        可视化视图
                      </button>
                      <button
                        onClick={() => setActiveTab("json")}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-xl transition-all ${
                          activeTab === "json" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        <FileJson className="w-4 h-4 inline mr-2 align-text-bottom" />
                        JSON 视图
                      </button>
                    </div>

                    <div className="p-5 flex-1 overflow-auto bg-slate-50/20">
                      {activeTab === "visual" ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {extractResult.fields.map((field, idx) => (
                            <FieldCard key={idx} field={field} />
                          ))}
                          {extractResult.fields.length === 0 && (
                            <div className="col-span-full py-12 text-center text-slate-500">
                              未能抽取到相关字段
                            </div>
                          )}
                        </div>
                      ) : (
                        <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner">
                          <code>{JSON.stringify(extractResult.rawJson, null, 2)}</code>
                        </pre>
                      )}
                    </div>
                  </Card>
                </>
              ) : mode === "markdown" && markdownResult ? (
                <>
                  <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-display font-bold text-slate-900 flex items-center gap-2">
                      <CheckCircle2 className="w-6 h-6 text-emerald-500" />
                      Markdown 转换结果
                    </h2>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={handleCopyMarkdown}>
                        <Copy className="w-4 h-4 mr-1.5" />
                        {copiedMd ? "已复制！" : "复制"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleDownloadMarkdown}>
                        <Download className="w-4 h-4 mr-1.5" /> 下载 .md
                      </Button>
                    </div>
                  </div>

                  <Card className="flex-1 flex flex-col min-h-[500px]">
                    <div className="flex border-b border-slate-100 bg-slate-50/50 rounded-t-2xl p-1">
                      <button
                        onClick={() => setMarkdownTab("preview")}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-xl transition-all ${
                          markdownTab === "preview" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        <FileCode2 className="w-4 h-4 inline mr-2 align-text-bottom" />
                        预览
                      </button>
                      <button
                        onClick={() => setMarkdownTab("raw")}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-xl transition-all ${
                          markdownTab === "raw" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                        }`}
                      >
                        <FileJson className="w-4 h-4 inline mr-2 align-text-bottom" />
                        原始文本
                      </button>
                    </div>

                    <div className="p-5 flex-1 overflow-auto bg-slate-50/20">
                      {markdownTab === "preview" ? (
                        <article className="prose prose-slate max-w-none prose-headings:font-display prose-table:text-sm">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {markdownResult.markdown}
                          </ReactMarkdown>
                        </article>
                      ) : (
                        <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner whitespace-pre-wrap break-words">
                          <code>{markdownResult.markdown}</code>
                        </pre>
                      )}
                    </div>
                  </Card>
                </>
              ) : null}
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, display: "none" }}
              className="hidden lg:flex flex-1 items-center justify-center"
            >
              <div className="max-w-md text-center">
                <img
                  src={`${import.meta.env.BASE_URL}images/empty-state.png`}
                  alt="Awaiting document"
                  className="w-64 h-64 mx-auto mb-6 opacity-80 mix-blend-multiply"
                />
                <h3 className="text-xl font-display font-bold text-slate-800 mb-2">等待文档输入</h3>
                <p className="text-slate-500">
                  {mode === "extract"
                    ? "在左侧输入需要解析的文档文本并点击抽取，AI 将自动理解上下文并提取您需要的关键信息。"
                    : "在左侧上传或粘贴文档内容，AI 将把全文转换为高保真 Markdown 格式。"}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </Layout>
  );
}

type BadgeVariant = "default" | "success" | "warning" | "error";

const CONFIDENCE_CONFIG: Record<string, { color: BadgeVariant; label: string }> = {
  high: { color: "success", label: "高置信度" },
  medium: { color: "warning", label: "中置信度" },
  low: { color: "error", label: "低置信度" },
};

function FieldCard({ field }: { field: ExtractedField }) {
  const conf = CONFIDENCE_CONFIG[field.confidence ?? "medium"] ?? CONFIDENCE_CONFIG["medium"]!;

  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm hover:shadow-md hover:border-primary/30 transition-all group">
      <div className="flex justify-between items-start mb-2 gap-2">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{field.key}</span>
        <Badge variant={conf.color} className="scale-90 origin-top-right opacity-80 group-hover:opacity-100 transition-opacity">
          {conf.label}
        </Badge>
      </div>
      <div className="text-sm font-medium text-slate-900 break-words leading-relaxed">
        {field.value || <span className="text-slate-400 italic">空</span>}
      </div>
    </div>
  );
}
