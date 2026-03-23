import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  useExtractDocument,
  useMarkdownExtract,
  useDocumentQa,
  useValidateDocument,
  useClauseSplit,
} from "@workspace/api-client-react";
import type {
  ExtractRequestTemplate,
  ExtractedField,
  ValidationItem,
  QaEvidenceItem,
  ValidateIssue,
  ClauseItem,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button, Card, Textarea, Input, Badge } from "@/components/ui-elements";
import {
  FileText, Upload, Sparkles, AlertCircle, FileJson,
  Table as TableIcon, Download, CheckCircle2, Image as ImageIcon,
  Copy, FileCode2, MessageCircleQuestion, Quote,
  ShieldCheck, Scissors, ChevronDown, ChevronUp,
  XCircle, Info, TriangleAlert,
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
  | { kind: "images"; imageData: string[]; label: string; truncatedAt?: number; totalPages?: number };

async function pdfToImages(pdf: pdfjsLib.PDFDocumentProxy, maxPages: number, filename: string): Promise<ExtractionInput> {
  const imageData: string[] = [];
  const pageCount = Math.min(pdf.numPages, maxPages);
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    imageData.push(await pdfPageToDataUri(page));
  }
  const truncated = pdf.numPages > maxPages;
  return {
    kind: "images",
    imageData,
    label: `${filename}（${truncated ? `前 ${maxPages} 页 / 共 ${pdf.numPages} 页` : `共 ${pdf.numPages} 页`}）`,
    ...(truncated ? { truncatedAt: maxPages, totalPages: pdf.numPages } : {}),
  };
}

async function extractInputFromFile(file: File, forMarkdown = false): Promise<ExtractionInput> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    if (forMarkdown) {
      return pdfToImages(pdf, 20, file.name);
    }

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

    return pdfToImages(pdf, 10, file.name);
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

type AppMode = "extract" | "markdown" | "qa" | "validate" | "segment";

const SAMPLE_DATA: Record<AppMode, { text: string; question?: string; template?: ExtractRequestTemplate }> = {
  extract: {
    template: "contract",
    text: `技术服务合同

合同编号：JS-2024-0318-001
签订地点：北京市朝阳区

甲方（委托方）：北京星辰科技有限公司
法定代表人：王建国
地址：北京市朝阳区科技路88号星辰大厦12层
联系电话：010-88886666

乙方（服务方）：上海慧算数据服务有限公司
法定代表人：李晓梅
地址：上海市浦东新区张江高科技园区B栋506室
联系电话：021-55557777

一、服务内容
乙方为甲方提供企业数据分析平台的开发与部署服务，具体包括：数据采集模块、可视化报表系统及API接口开发，共计3个功能模块。

二、合同金额
本合同总金额为人民币叁拾伍万元整（¥350,000.00），含税。

三、付款方式
合同签订后7个工作日内，甲方支付首付款人民币壹拾万元整（¥100,000.00）；项目验收通过后15个工作日内，甲方支付尾款人民币贰拾伍万元整（¥250,000.00）。

四、服务期限
本合同服务期限自2024年4月1日起至2024年9月30日止，共6个月。

五、违约责任
任何一方未按约定履行义务，须向对方支付合同总金额10%的违约金，即人民币叁万伍仟元整（¥35,000.00）。

甲方代表（签字）：________________　　日期：2024年3月18日
乙方代表（签字）：________________　　日期：2024年3月18日`,
  },
  markdown: {
    text: `季度销售数据分析报告
报告期间：2024年第一季度（1月—3月）
编制部门：商务数据中心

一、核心业绩指标

本季度总销售额：¥12,486,000
同比增长：+23.7%
环比增长：+8.2%
新签客户数：147家
客户留存率：91.3%

二、各区域销售数据汇总

区域　　 | 销售额（万元）| 同比增长 | 完成率 | 重点客户数
华北区　 |     3,420     |  +31.2% |  108% |    34
华东区　 |     4,158     |  +18.6% |   96% |    51
华南区　 |     2,730     |  +27.4% |  103% |    28
西部区　 |     1,080     |  +15.1% |   89% |    19
海外区　 |     1,098     |  +44.8% |  115% |    15
合计　　 |    12,486     |  +23.7% |  102% |   147

三、产品线销售占比

1. 企业SaaS平台：占比42%，销售额¥5,244,000
2. 数据分析服务：占比28%，销售额¥3,496,000
3. 定制开发项目：占比19%，销售额¥2,372,000
4. 技术培训课程：占比11%，销售额¥1,374,000

四、问题与改进建议

西部区完成率偏低（89%），建议增配销售人员，重点开发成都、西安市场；
海外区增速最快，应加大资源投入，计划Q2增设新加坡办事处。`,
  },
  qa: {
    text: `劳动合同

甲方（用人单位）：深圳市未来智造科技股份有限公司
统一社会信用代码：91440300XXXXXXXX1K
地址：深圳市南山区科技园南区深南大道9988号10层

乙方（劳动者）：陈雨晴
身份证号码：440301199506150022
联系电话：138-0755-8899
家庭住址：深圳市宝安区新安街道宝民一路XX号

一、劳动合同期限
本合同为固定期限劳动合同，合同期限为3年，自2024年3月1日起至2027年2月28日止。其中试用期3个月，即2024年3月1日至2024年5月31日。

二、工作岗位
乙方担任高级产品经理岗位，工作地点为深圳市南山区科技园。

三、劳动报酬
（一）试用期月薪：人民币18,000元整。
（二）转正后月薪：人民币25,000元整，另享有季度绩效奖金，绩效奖金按公司考核制度执行。
（三）甲方于每月10日以银行转账方式支付上月工资。

四、工作时间与休息休假
乙方执行标准工时制度，每日工作8小时，每周工作5天。法定节假日及年假按国家相关规定执行。乙方工龄满1年可享受5天带薪年假。

五、社会保险
甲方依法为乙方缴纳养老保险、医疗保险、失业保险、工伤保险及生育保险。

六、保密与竞业限制
乙方在职期间及离职后2年内不得从事与甲方存在竞争关系的业务，不得向第三方披露甲方商业机密。违反本条款须向甲方支付违约金人民币50,000元。`,
    question: "试用期工资是多少？试用期结束后薪资如何变化？",
  },
  validate: {
    text: `采购合同

合同编号：CG-2024-0215

甲方（买方）：成都绿洲贸易有限公司
乙方（卖方）：广州华丰供应链有限公司

一、采购内容
甲方向乙方采购办公设备一批，含笔记本电脑50台、显示器80台，货物明细见附件一。

二、合同金额
本合同总价款为人民币伍拾万元整（¥280,000.00）。
（注：大写金额与数字金额不符，请核查）

三、交货期限
乙方须于2024年1月15日前完成全部货物交付。
（注：本合同签订日期为2024年2月15日，交货期早于签订日期）

四、付款方式
合同签订后，甲方预付货款30%，即人民币捌万肆仟元整（¥84,000.00）；货物验收合格后10日内付清余款。
（注：30%×280,000=84,000，但大写为壹拾五万元）

五、质量保证
乙方保证所提供货物符合国家标准，质保期为货物验收之日起24个月。

六、违约责任
任何一方违约，须承担合同金额的15%作为违约金。

甲方代表：________________
乙方代表：________________`,
  },
  segment: {
    text: `软件许可与服务协议

甲方（许可方）：杭州云智软件科技有限公司
乙方（被许可方）：重庆山城物流集团有限公司
签订日期：2024年3月20日

第一条　定义
本协议中，"软件"指甲方开发的"云智运营管理系统"（版本号V3.2），包含源代码、目标代码、文档及相关更新；"许可"指甲方授予乙方使用软件的非独占性权利。

第二条　许可授权
甲方授予乙方在中华人民共和国境内，将软件用于乙方内部运营管理目的的非独占、不可转让的使用权。乙方不得将软件出租、出借、转让或分许可给任何第三方。

第三条　付款条款
乙方应于合同签订后5个工作日内支付首年许可费人民币叁拾万元整（¥300,000.00）；此后每年续费金额为首年许可费的85%，即人民币贰拾伍万伍仟元整（¥255,000.00）。

第四条　实施与培训
甲方负责在乙方指定地点完成软件的安装部署，并提供不少于5天的操作培训。首次安装调试期限为合同签订后30个自然日内完成。

第五条　维护支持
合同有效期内，甲方提供5×8小时电话技术支持及年度版本升级服务。严重故障（系统不可用）响应时间不超过4小时，一般故障响应时间不超过1个工作日。

第六条　知识产权
软件的全部知识产权归甲方所有。本协议不转让任何知识产权。乙方承认软件中包含甲方的商业秘密，有义务采取合理措施保护其保密性。

第七条　违约与赔偿
任何一方违反本协议，须在收到对方书面通知后15日内纠正。逾期未纠正的，违约方须支付守约方合同金额20%的违约金，并赔偿守约方因此遭受的实际损失。

第八条　合同解除
出现下列情形之一，任何一方可书面通知解除本协议：（一）对方严重违约且未在规定期限内纠正；（二）对方进入破产、清算程序；（三）因不可抗力致使合同目的无法实现。

第九条　争议解决
因本协议引起的任何争议，双方应首先友好协商；协商不成的，提交杭州仲裁委员会按其仲裁规则进行仲裁，仲裁裁决为终局裁决。

第十条　附则
本协议自双方签字盖章之日起生效，有效期3年。未尽事宜由双方协商补充，补充协议与本协议具有同等法律效力。

甲方（盖章）：________________　　乙方（盖章）：________________
授权代表签字：________________　　授权代表签字：________________`,
  },
};

const MODES: { id: AppMode; label: string; icon: React.ReactNode }[] = [
  { id: "extract", label: "结构化抽取", icon: <Sparkles className="w-3.5 h-3.5" /> },
  { id: "markdown", label: "Markdown 转换", icon: <FileCode2 className="w-3.5 h-3.5" /> },
  { id: "qa", label: "智能问答", icon: <MessageCircleQuestion className="w-3.5 h-3.5" /> },
  { id: "validate", label: "规则校验", icon: <ShieldCheck className="w-3.5 h-3.5" /> },
  { id: "segment", label: "条款切分", icon: <Scissors className="w-3.5 h-3.5" /> },
];

export default function Home() {
  const [mode, setMode] = useState<AppMode>("extract");
  const [text, setText] = useState("");
  const [imageInput, setImageInput] = useState<{ imageData: string[]; label: string; truncatedAt?: number; totalPages?: number } | null>(null);
  const [template, setTemplate] = useState<ExtractRequestTemplate>("general");
  const [customFieldsStr, setCustomFieldsStr] = useState("");
  const [question, setQuestion] = useState("");
  const [activeTab, setActiveTab] = useState<"visual" | "json">("visual");
  const [markdownTab, setMarkdownTab] = useState<"preview" | "raw">("preview");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [copiedMd, setCopiedMd] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractMutation = useExtractDocument();
  const markdownMutation = useMarkdownExtract();
  const qaMutation = useDocumentQa();
  const validateMutation = useValidateDocument();
  const segmentMutation = useClauseSplit();

  const handleModeSwitch = (newMode: AppMode) => {
    setMode(newMode);
    extractMutation.reset();
    markdownMutation.reset();
    qaMutation.reset();
    validateMutation.reset();
    segmentMutation.reset();
  };

  const handleLoadSample = () => {
    const sample = SAMPLE_DATA[mode];
    setImageInput(null);
    setFileError(null);
    setText(sample.text);
    if (sample.question) setQuestion(sample.question);
    if (sample.template) setTemplate(sample.template);
    extractMutation.reset();
    markdownMutation.reset();
    qaMutation.reset();
    validateMutation.reset();
    segmentMutation.reset();
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileError(null);
    setImageInput(null);
    setText("");

    setIsLoadingFile(true);
    try {
      const input = await extractInputFromFile(file, mode === "markdown");
      if (input.kind === "text") {
        setText(input.text);
      } else {
        setImageInput({
          imageData: input.imageData,
          label: input.label,
          truncatedAt: input.truncatedAt,
          totalPages: input.totalPages,
        });
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
    } else if (mode === "markdown") {
      markdownMutation.mutate({
        data: {
          ...(hasText ? { text } : {}),
          ...(hasImages ? { imageData: imageInput!.imageData } : {}),
        },
      });
    } else if (mode === "qa") {
      if (!question.trim()) return;
      qaMutation.mutate({
        data: {
          ...(hasText ? { text } : {}),
          ...(hasImages ? { imageData: imageInput!.imageData } : {}),
          question: question.trim(),
        },
      });
    } else if (mode === "validate") {
      validateMutation.mutate({
        data: {
          ...(hasText ? { text } : {}),
          ...(hasImages ? { imageData: imageInput!.imageData } : {}),
        },
      });
    } else if (mode === "segment") {
      segmentMutation.mutate({
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

  const canSubmit =
    (text.trim().length > 0 || (imageInput != null && imageInput.imageData.length > 0)) &&
    (mode !== "qa" || question.trim().length > 0);

  const currentMutation =
    mode === "extract" ? extractMutation :
    mode === "markdown" ? markdownMutation :
    mode === "qa" ? qaMutation :
    mode === "validate" ? validateMutation :
    segmentMutation;

  const isPending = currentMutation.isPending;
  const isError = currentMutation.isError;

  const hasResult =
    mode === "extract" ? !!extractMutation.data :
    mode === "markdown" ? !!markdownMutation.data :
    mode === "qa" ? !!qaMutation.data :
    mode === "validate" ? !!validateMutation.data :
    !!segmentMutation.data;

  const submitLabel =
    mode === "extract" ? (isPending ? "AI 正在分析..." : "开始智能抽取") :
    mode === "markdown" ? (isPending ? "AI 正在转换..." : "开始 Markdown 转换") :
    mode === "qa" ? (isPending ? "AI 正在检索文档..." : "提交问题") :
    mode === "validate" ? (isPending ? "AI 正在审查..." : "开始规则校验") :
    (isPending ? "AI 正在切分..." : "开始条款切分");

  const submitIcon =
    mode === "extract" ? <Sparkles className="w-5 h-5 mr-2" /> :
    mode === "markdown" ? <FileCode2 className="w-5 h-5 mr-2" /> :
    mode === "qa" ? <MessageCircleQuestion className="w-5 h-5 mr-2" /> :
    mode === "validate" ? <ShieldCheck className="w-5 h-5 mr-2" /> :
    <Scissors className="w-5 h-5 mr-2" />;

  const errorLabel =
    mode === "extract" ? "抽取失败，请检查文档内容或稍后重试。" :
    mode === "markdown" ? "转换失败，请检查文档内容或稍后重试。" :
    mode === "qa" ? "问答失败，请检查文档内容或稍后重试。" :
    mode === "validate" ? "规则校验失败，请检查文档内容或稍后重试。" :
    "条款切分失败，请检查文档内容或稍后重试。";

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
          <div className="grid grid-cols-5 rounded-xl bg-slate-100 p-1 gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => handleModeSwitch(m.id)}
                className={`flex flex-col items-center gap-1 py-2 px-1 text-xs font-semibold rounded-lg transition-all ${
                  mode === m.id
                    ? "bg-white text-primary shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {m.icon}
                <span className="leading-tight text-center">{m.label}</span>
              </button>
            ))}
          </div>

          <Card className="p-1">
            <div className="p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <label className="font-semibold text-slate-900 flex items-center gap-2 shrink-0">
                  <FileText className="w-4 h-4 text-primary" />
                  文档内容
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleLoadSample}
                    className="h-8 px-3 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200/70 rounded-lg transition-colors flex items-center gap-1.5"
                  >
                    <Sparkles className="w-3 h-3" />
                    加载示例
                  </button>
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
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept={ACCEPTED_EXTS}
                  onChange={handleFileUpload}
                />
              </div>

              {imageInput ? (
                <div className="flex flex-col gap-2">
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
                  {imageInput.truncatedAt != null && imageInput.totalPages != null && (
                    <div className="flex items-start gap-1.5 px-1 text-xs text-amber-700 bg-amber-50 border border-amber-200/60 rounded-lg p-2">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                      <span>
                        此 PDF 共 {imageInput.totalPages} 页，Markdown 转换仅处理前 {imageInput.truncatedAt} 页（超出部分将被忽略）。
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <Textarea
                  placeholder={`在此粘贴文档内容，或上传文件（支持 ${ACCEPTED_LABEL}）...`}
                  className="h-48 resize-none bg-slate-50/50 border-slate-200/60 focus:bg-white"
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

            {/* Question input — only in QA mode */}
            <AnimatePresence>
              {mode === "qa" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-slate-100 p-5 flex flex-col gap-3 bg-slate-50/30">
                    <label className="font-semibold text-slate-900 flex items-center gap-2">
                      <MessageCircleQuestion className="w-4 h-4 text-primary" />
                      提问
                    </label>
                    <Input
                      placeholder="输入您想问的问题，例如：合同的甲方是谁？付款金额是多少？"
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      className="bg-white"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && canSubmit && !isPending) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                    />
                    <p className="text-xs text-slate-400">AI 将严格依据文档原文作答，并引用相关原句作为证据</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Validate mode description */}
            <AnimatePresence>
              {mode === "validate" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-slate-100 p-5 bg-slate-50/30">
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-50 border border-blue-100">
                      <ShieldCheck className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-blue-900">规则校验检测内容</p>
                        <ul className="text-xs text-blue-700 mt-1.5 space-y-0.5">
                          <li>• 日期冲突（签订日期、截止日期、有效期等）</li>
                          <li>• 金额不一致（大写与数字不符等）</li>
                          <li>• 缺少必要字段（甲方、乙方、签章等）</li>
                          <li>• 逻辑错误（条款互相矛盾等）</li>
                          <li>• 格式错误（日期格式、身份证号等）</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Segment mode description */}
            <AnimatePresence>
              {mode === "segment" && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-slate-100 p-5 bg-slate-50/30">
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-purple-50 border border-purple-100">
                      <Scissors className="w-5 h-5 text-purple-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-purple-900">条款切分说明</p>
                        <p className="text-xs text-purple-700 mt-1 leading-relaxed">
                          AI 将按语义将文档拆分为条款卡片，每张卡片包含标题、类型、原文和摘要，适合快速浏览合同结构。
                        </p>
                      </div>
                    </div>
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
                {submitIcon}
                {submitLabel}
              </Button>
              {isError && (
                <div className="mt-3 p-3 bg-rose-50 text-rose-600 rounded-lg text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{errorLabel}</span>
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
              {mode === "extract" && extractMutation.data ? (
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

                  {extractMutation.data.summary && (
                    <Card className="p-5 bg-gradient-to-br from-blue-50 to-indigo-50/30 border-blue-100/50">
                      <h3 className="text-sm font-bold text-blue-900 mb-2 flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-blue-600" />
                        AI 摘要
                      </h3>
                      <p className="text-sm text-slate-700 leading-relaxed">{extractMutation.data.summary}</p>
                    </Card>
                  )}

                  {/* Validation Report */}
                  <ValidationReport items={extractMutation.data.validation ?? []} />

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
                          {extractMutation.data.fields.map((field, idx) => (
                            <FieldCard key={idx} field={field} />
                          ))}
                          {extractMutation.data.fields.length === 0 && (
                            <div className="col-span-full py-12 text-center text-slate-500">
                              未能抽取到相关字段
                            </div>
                          )}
                        </div>
                      ) : (
                        <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner">
                          <code>{JSON.stringify(extractMutation.data.rawJson, null, 2)}</code>
                        </pre>
                      )}
                    </div>
                  </Card>
                </>
              ) : mode === "markdown" && markdownMutation.data ? (
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
                            {markdownMutation.data.markdown}
                          </ReactMarkdown>
                        </article>
                      ) : (
                        <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner whitespace-pre-wrap break-words">
                          <code>{markdownMutation.data.markdown}</code>
                        </pre>
                      )}
                    </div>
                  </Card>
                </>
              ) : mode === "qa" && qaMutation.data ? (
                <QaResultPanel question={question} result={qaMutation.data} />
              ) : mode === "validate" && validateMutation.data ? (
                <ValidateResultPanel result={validateMutation.data} />
              ) : mode === "segment" && segmentMutation.data ? (
                <SegmentResultPanel result={segmentMutation.data} />
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
                    : mode === "markdown"
                    ? "在左侧上传或粘贴文档内容，AI 将把全文转换为高保真 Markdown 格式。"
                    : mode === "qa"
                    ? "上传或粘贴文档内容，然后输入您的问题，AI 将从文档原文中找到答案并提供引用证据。"
                    : mode === "validate"
                    ? "上传或粘贴文档内容，AI 将检测日期冲突、金额不一致、缺失字段等合规问题。"
                    : "上传或粘贴文档内容，AI 将按语义将文档拆分为条款卡片，便于快速浏览合同结构。"}
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

const VALIDATION_SEVERITY_CONFIG = {
  high: {
    label: "高风险",
    bgClass: "bg-rose-50 border-rose-200/70",
    labelClass: "bg-rose-100 text-rose-700 border border-rose-200",
    iconClass: "text-rose-500",
    Icon: XCircle,
  },
  medium: {
    label: "中风险",
    bgClass: "bg-amber-50 border-amber-200/70",
    labelClass: "bg-amber-100 text-amber-700 border border-amber-200",
    iconClass: "text-amber-500",
    Icon: TriangleAlert,
  },
  low: {
    label: "低风险",
    bgClass: "bg-blue-50 border-blue-200/70",
    labelClass: "bg-blue-100 text-blue-700 border border-blue-200",
    iconClass: "text-blue-500",
    Icon: Info,
  },
} as const;

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function ValidationReport({ items }: { items: ValidationItem[] }) {
  const passed = items.length === 0;
  const sorted = [...items].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );

  return (
    <Card className="p-5 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4 text-slate-600" />
        校验报告
        <span className="ml-auto text-xs font-normal text-slate-400">{items.length} 条风险项</span>
      </h3>

      {passed ? (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-50 border border-emerald-200/70">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span className="text-sm text-emerald-800 font-medium">校验通过，未发现异常</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((item, idx) => {
            const cfg = VALIDATION_SEVERITY_CONFIG[item.severity as keyof typeof VALIDATION_SEVERITY_CONFIG]
              ?? VALIDATION_SEVERITY_CONFIG.medium;
            const { Icon } = cfg;
            return (
              <div key={idx} className={`flex items-start gap-3 p-3 rounded-xl border ${cfg.bgClass}`}>
                <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${cfg.iconClass}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${cfg.labelClass}`}>{cfg.label}</span>
                    <span className="text-xs font-medium text-slate-600 truncate">{item.field}</span>
                  </div>
                  <p className="text-sm text-slate-800 leading-relaxed">{item.issue}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

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

function EvidenceCard({ item, index }: { item: QaEvidenceItem; index: number }) {
  return (
    <div className="rounded-xl border border-violet-200/60 bg-violet-50/40 overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <Quote className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-xs font-semibold text-violet-600">证据 {index + 1}</span>
      </div>
      <blockquote className="mx-4 mb-3 pl-3 border-l-2 border-violet-300 text-sm text-slate-800 leading-relaxed italic">
        {item.quote}
      </blockquote>
      <div className="px-4 pb-3">
        <p className="text-xs text-slate-500 leading-relaxed">{item.context}</p>
      </div>
    </div>
  );
}

function QaResultPanel({ question, result }: { question: string; result: { answer: string; evidence: QaEvidenceItem[] } }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-display font-bold text-slate-900 flex items-center gap-2">
          <CheckCircle2 className="w-6 h-6 text-emerald-500" />
          问答结果
        </h2>
      </div>

      <Card className="p-5 bg-gradient-to-br from-slate-50 to-slate-100/50 border-slate-200/60">
        <div className="flex items-start gap-2 mb-1">
          <MessageCircleQuestion className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-sm font-semibold text-slate-700">{question}</p>
        </div>
      </Card>

      <Card className="p-5 bg-gradient-to-br from-emerald-50 to-teal-50/30 border-emerald-100/60">
        <h3 className="text-sm font-bold text-emerald-900 mb-2 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          AI 回答
        </h3>
        <p className="text-sm text-slate-800 leading-relaxed">{result.answer}</p>
      </Card>

      {result.evidence.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-bold text-slate-700 flex items-center gap-1.5">
            <Quote className="w-4 h-4 text-violet-500" />
            原文证据（共 {result.evidence.length} 条）
          </h3>
          {result.evidence.map((item, idx) => (
            <EvidenceCard key={idx} item={item} index={idx} />
          ))}
        </div>
      ) : (
        <Card className="p-5 border-amber-200/60 bg-amber-50/40">
          <p className="text-sm text-amber-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            文档中未找到相关原文证据
          </p>
        </Card>
      )}
    </>
  );
}

const SEVERITY_CONFIG = {
  error: {
    icon: <XCircle className="w-4 h-4 text-rose-500 shrink-0" />,
    badge: "error" as BadgeVariant,
    label: "严重",
    cardClass: "border-rose-200/60 bg-rose-50/40",
    headerClass: "text-rose-700",
  },
  warning: {
    icon: <TriangleAlert className="w-4 h-4 text-amber-500 shrink-0" />,
    badge: "warning" as BadgeVariant,
    label: "警告",
    cardClass: "border-amber-200/60 bg-amber-50/40",
    headerClass: "text-amber-700",
  },
  info: {
    icon: <Info className="w-4 h-4 text-blue-500 shrink-0" />,
    badge: "default" as BadgeVariant,
    label: "提示",
    cardClass: "border-blue-200/60 bg-blue-50/40",
    headerClass: "text-blue-700",
  },
};

const ISSUE_TYPE_LABELS: Record<string, string> = {
  date_conflict: "日期冲突",
  amount_inconsistency: "金额不一致",
  missing_field: "缺少字段",
  logic_error: "逻辑错误",
  format_error: "格式错误",
  other: "其他",
};

function IssueCard({ issue }: { issue: ValidateIssue }) {
  const cfg = SEVERITY_CONFIG[issue.severity as keyof typeof SEVERITY_CONFIG] ?? SEVERITY_CONFIG.info;
  return (
    <div className={`rounded-xl border p-4 ${cfg.cardClass}`}>
      <div className="flex items-start gap-2 mb-2">
        {cfg.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${cfg.headerClass}`}>{issue.description}</span>
            <Badge variant={cfg.badge} className="scale-90 origin-left">{cfg.label}</Badge>
            <span className="text-xs text-slate-500 bg-white/70 px-2 py-0.5 rounded-full border border-slate-200/60">
              {ISSUE_TYPE_LABELS[issue.type] ?? issue.type}
            </span>
          </div>
          {issue.location && (
            <p className="text-xs text-slate-500 mt-0.5">位置：{issue.location}</p>
          )}
        </div>
      </div>
      {issue.evidence && (
        <blockquote className="mt-2 pl-3 border-l-2 border-slate-300 text-xs text-slate-600 leading-relaxed italic">
          {issue.evidence}
        </blockquote>
      )}
    </div>
  );
}

function ValidateResultPanel({ result }: { result: { passed: boolean; summary: string; issues: ValidateIssue[] } }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  const infos = result.issues.filter((i) => i.severity === "info");

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-display font-bold text-slate-900 flex items-center gap-2">
          {result.passed ? (
            <CheckCircle2 className="w-6 h-6 text-emerald-500" />
          ) : (
            <XCircle className="w-6 h-6 text-rose-500" />
          )}
          规则校验结果
        </h2>
      </div>

      <Card className={`p-5 ${result.passed
        ? "bg-gradient-to-br from-emerald-50 to-teal-50/30 border-emerald-100/60"
        : "bg-gradient-to-br from-rose-50 to-red-50/30 border-rose-100/60"}`}
      >
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className={`w-4 h-4 ${result.passed ? "text-emerald-600" : "text-rose-600"}`} />
          <span className={`text-sm font-bold ${result.passed ? "text-emerald-900" : "text-rose-900"}`}>
            {result.passed ? "文档通过合规检查" : "文档存在合规问题"}
          </span>
        </div>
        <p className="text-sm text-slate-700 leading-relaxed">{result.summary}</p>

        {result.issues.length > 0 && (
          <div className="mt-3 flex gap-3 flex-wrap">
            {errors.length > 0 && (
              <span className="text-xs font-medium text-rose-700 bg-rose-100 px-2.5 py-1 rounded-full">
                {errors.length} 个严重问题
              </span>
            )}
            {warnings.length > 0 && (
              <span className="text-xs font-medium text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full">
                {warnings.length} 个警告
              </span>
            )}
            {infos.length > 0 && (
              <span className="text-xs font-medium text-blue-700 bg-blue-100 px-2.5 py-1 rounded-full">
                {infos.length} 条提示
              </span>
            )}
          </div>
        )}
      </Card>

      {result.issues.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-bold text-slate-700 flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 text-slate-500" />
            检测到的问题（共 {result.issues.length} 条）
          </h3>
          {result.issues.map((issue, idx) => (
            <IssueCard key={idx} issue={issue} />
          ))}
        </div>
      ) : (
        <Card className="p-5 border-emerald-200/60 bg-emerald-50/40">
          <p className="text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            文档未检测到任何合规问题
          </p>
        </Card>
      )}
    </>
  );
}

const CLAUSE_CATEGORY_PALETTE = [
  { color: "text-blue-600",    bg: "bg-blue-50",     border: "border-blue-200" },
  { color: "text-emerald-600", bg: "bg-emerald-50",  border: "border-emerald-200" },
  { color: "text-orange-600",  bg: "bg-orange-50",   border: "border-orange-200" },
  { color: "text-rose-600",    bg: "bg-rose-50",     border: "border-rose-200" },
  { color: "text-violet-600",  bg: "bg-violet-50",   border: "border-violet-200" },
  { color: "text-yellow-600",  bg: "bg-yellow-50",   border: "border-yellow-200" },
  { color: "text-indigo-600",  bg: "bg-indigo-50",   border: "border-indigo-200" },
  { color: "text-teal-600",    bg: "bg-teal-50",     border: "border-teal-200" },
  { color: "text-red-600",     bg: "bg-red-50",      border: "border-red-200" },
  { color: "text-purple-600",  bg: "bg-purple-50",   border: "border-purple-200" },
  { color: "text-slate-500",   bg: "bg-slate-50",    border: "border-slate-200" },
];

function getCategoryStyle(category: string, categorySet: string[]) {
  const idx = categorySet.indexOf(category);
  return CLAUSE_CATEGORY_PALETTE[idx % CLAUSE_CATEGORY_PALETTE.length] ?? CLAUSE_CATEGORY_PALETTE[CLAUSE_CATEGORY_PALETTE.length - 1]!;
}

function ClauseCardItem({ clause, categorySet }: { clause: ClauseItem; categorySet: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = getCategoryStyle(clause.category, categorySet);
  const clauseNum = clause.id.replace("clause-", "");

  return (
    <div className={`rounded-xl border ${cfg.border} overflow-hidden`}>
      <div
        className={`px-4 py-3 flex items-start gap-3 cursor-pointer hover:brightness-95 transition-all ${cfg.bg}`}
        onClick={() => setExpanded((p) => !p)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-mono text-slate-400">#{clauseNum.padStart(2, "0")}</span>
            <span className="font-semibold text-sm text-slate-900">{clause.title}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
              {clause.category}
            </span>
          </div>
          {clause.tags.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {clause.tags.map((tag) => (
                <span key={tag} className="text-xs text-slate-500 bg-white/70 px-1.5 py-0.5 rounded border border-slate-200/60">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
          : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
        }
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 py-3 border-t border-slate-100 bg-white">
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{clause.text}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SegmentResultPanel({ result }: { result: { clauses: ClauseItem[]; total: number } }) {
  const handleDownloadSegmentJSON = () => {
    downloadFile(
      JSON.stringify({ total: result.total, clauses: result.clauses }, null, 2),
      "clauses.json",
      "application/json"
    );
  };

  const categorySet = Array.from(new Set(result.clauses.map((c) => c.category)));

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-2xl font-display font-bold text-slate-900 flex items-center gap-2">
          <CheckCircle2 className="w-6 h-6 text-emerald-500" />
          条款切分结果
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500 font-normal">共 {result.total} 个条款</span>
          <Button variant="outline" size="sm" onClick={handleDownloadSegmentJSON}>
            <Download className="w-4 h-4 mr-1.5" /> 下载 JSON
          </Button>
        </div>
      </div>

      <Card className="p-5 bg-gradient-to-br from-purple-50 to-indigo-50/30 border-purple-100/60">
        <div className="flex items-center gap-2 mb-2">
          <Scissors className="w-4 h-4 text-purple-600" />
          <span className="text-sm font-bold text-purple-900">文档已按语义切分为 {result.clauses.length} 个条款卡片</span>
        </div>
        <div className="flex gap-2 flex-wrap mt-2">
          {categorySet.map((cat) => {
            const cfg = getCategoryStyle(cat, categorySet);
            const count = result.clauses.filter((c) => c.category === cat).length;
            return (
              <span key={cat} className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
                {cat} × {count}
              </span>
            );
          })}
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        {result.clauses.map((clause) => (
          <ClauseCardItem key={clause.id} clause={clause} categorySet={categorySet} />
        ))}
        {result.clauses.length === 0 && (
          <Card className="p-5 border-amber-200/60 bg-amber-50/40">
            <p className="text-sm text-amber-700">未能从文档中切分出条款</p>
          </Card>
        )}
      </div>
    </>
  );
}
