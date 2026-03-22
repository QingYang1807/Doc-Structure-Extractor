import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useExtractDocument } from "@workspace/api-client-react";
import type { ExtractRequestTemplate, ExtractedField } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button, Card, Textarea, Input, Badge } from "@/components/ui-elements";
import { 
  FileText, Upload, Sparkles, AlertCircle, FileJson, 
  Table as TableIcon, Download, CheckCircle2
} from "lucide-react";
import Papa from "papaparse";
import { downloadFile } from "@/lib/utils";
import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import mammoth from "mammoth";

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

async function extractTextFromFile(file: File): Promise<string> {
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
        .join(" ");
      pages.push(pageText);
    }
    return pages.join("\n\n");
  }

  if (
    name.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  return await file.text();
}

export default function Home() {
  const [text, setText] = useState("");
  const [template, setTemplate] = useState<ExtractRequestTemplate>("general");
  const [customFieldsStr, setCustomFieldsStr] = useState("");
  const [activeTab, setActiveTab] = useState<"visual" | "json">("visual");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractMutation = useExtractDocument();

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileError(null);
    const name = file.name.toLowerCase();
    const supported = name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".pdf") || name.endsWith(".docx");
    if (!supported) {
      setFileError("仅支持 .txt、.md、.pdf、.docx 文件格式");
      return;
    }

    setIsLoadingFile(true);
    try {
      const extracted = await extractTextFromFile(file);
      setText(extracted);
    } catch {
      setFileError("文件解析失败，请检查文件格式");
    } finally {
      setIsLoadingFile(false);
      e.target.value = "";
    }
  };

  const handleSubmit = () => {
    if (!text.trim()) return;
    
    const customFields = template === "custom" 
      ? customFieldsStr.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;

    extractMutation.mutate({
      data: {
        text,
        template,
        ...(customFields && customFields.length > 0 ? { customFields } : {})
      }
    });
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
    const csv = Papa.unparse(extractMutation.data.fields.map(f => ({
      "字段名": f.key,
      "提取值": f.value,
      "置信度": f.confidence
    })));
    downloadFile(csv, `extraction-${extractMutation.data.id}.csv`, "text/csv;charset=utf-8;");
  };

  const result = extractMutation.data;

  return (
    <Layout>
      <div className="flex flex-col lg:flex-row gap-6">
        
        {/* Left Column: Input Form */}
        <motion.div 
          layout
          className={`flex flex-col gap-6 transition-all duration-500 ease-in-out ${result ? 'lg:w-1/3' : 'lg:w-full max-w-3xl mx-auto'}`}
        >
          <div className="text-center lg:text-left mb-2">
            <h1 className="text-3xl font-display font-bold text-slate-900">智能文档抽取</h1>
            <p className="mt-2 text-slate-500">上传或粘贴文本，AI 将自动为您提取结构化关键信息。</p>
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
                  accept=".txt,.md,.pdf,.docx" 
                  onChange={handleFileUpload} 
                />
              </div>
              <Textarea 
                placeholder="在此粘贴文档内容，或上传文件（支持 .txt、.pdf、.docx）..." 
                className="h-64 resize-none bg-slate-50/50 border-slate-200/60 focus:bg-white"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {fileError && (
                <div className="text-xs text-rose-600 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fileError}
                </div>
              )}
            </div>
            
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
                        ? 'border-primary bg-primary/5 shadow-sm' 
                        : 'border-transparent bg-white shadow-sm hover:border-slate-200'}
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
                      <label className="text-xs font-medium text-slate-700 mb-1.5 block">自定义字段 (用逗号分隔)</label>
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

            <div className="p-5 border-t border-slate-100">
              <Button 
                className="w-full" 
                size="lg"
                onClick={handleSubmit}
                disabled={!text.trim()}
                isLoading={extractMutation.isPending}
              >
                <Sparkles className="w-5 h-5 mr-2" />
                {extractMutation.isPending ? "AI 正在分析..." : "开始智能抽取"}
              </Button>
              {extractMutation.isError && (
                <div className="mt-3 p-3 bg-rose-50 text-rose-600 rounded-lg text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>抽取失败，请检查文档内容或稍后重试。</span>
                </div>
              )}
            </div>
          </Card>
        </motion.div>

        {/* Right Column: Results Panel */}
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div 
              key="results"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex-1 flex flex-col gap-6"
            >
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

              {result.summary && (
                <Card className="p-5 bg-gradient-to-br from-blue-50 to-indigo-50/30 border-blue-100/50">
                  <h3 className="text-sm font-bold text-blue-900 mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                    AI 摘要
                  </h3>
                  <p className="text-sm text-slate-700 leading-relaxed">{result.summary}</p>
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
                      {result.fields.map((field, idx) => (
                        <FieldCard key={idx} field={field} />
                      ))}
                      {result.fields.length === 0 && (
                        <div className="col-span-full py-12 text-center text-slate-500">
                          未能抽取到相关字段
                        </div>
                      )}
                    </div>
                  ) : (
                    <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner">
                      <code>{JSON.stringify(result.rawJson, null, 2)}</code>
                    </pre>
                  )}
                </div>
              </Card>
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
                <p className="text-slate-500">在左侧输入需要解析的文档文本并点击抽取，AI 将自动理解上下文并提取您需要的关键信息。</p>
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
  const conf = CONFIDENCE_CONFIG[field.confidence ?? "medium"] ?? CONFIDENCE_CONFIG["medium"];

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
