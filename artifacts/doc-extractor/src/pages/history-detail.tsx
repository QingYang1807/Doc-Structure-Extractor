import { useRoute, Link } from "wouter";
import { format } from "date-fns";
import { useGetHistoryItem } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, Button, Badge } from "@/components/ui-elements";
import { ArrowLeft, Calendar, Tag, FileJson, Table as TableIcon, Download } from "lucide-react";
import { downloadFile } from "@/lib/utils";
import Papa from "papaparse";
import { useState } from "react";

export default function HistoryDetailPage() {
  const [, params] = useRoute("/history/:id");
  const id = params?.id ? parseInt(params.id, 10) : 0;
  const { data: job, isLoading, error } = useGetHistoryItem(id);
  const [activeTab, setActiveTab] = useState<"visual" | "json">("visual");

  if (isLoading) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto py-12 text-center text-slate-500">
          加载中...
        </div>
      </Layout>
    );
  }

  if (error || !job) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto py-12 text-center">
          <h2 className="text-xl font-bold text-slate-900 mb-2">未找到该记录</h2>
          <p className="text-slate-500 mb-6">可能已被删除或输入的ID有误。</p>
          <Link href="/history">
            <Button>返回历史记录</Button>
          </Link>
        </div>
      </Layout>
    );
  }

  const handleExportJSON = () => {
    downloadFile(
      JSON.stringify(job.rawJson, null, 2),
      `extraction-${job.id}.json`,
      "application/json"
    );
  };

  const handleExportCSV = () => {
    const csv = Papa.unparse(job.fields.map(f => ({
      "字段名": f.key,
      "提取值": f.value,
      "置信度": f.confidence
    })));
    downloadFile(csv, `extraction-${job.id}.csv`, "text/csv;charset=utf-8;");
  };

  const templateLabels: Record<string, string> = {
    contract: "合同关键信息",
    invoice: "发票字段",
    resume: "简历信息",
    general: "通用抽取",
    custom: "自定义字段",
  };

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <Link href="/history" className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-primary transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            返回列表
          </Link>
        </div>

        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-slate-900 mb-3">
              抽取报告 #{job.id}
            </h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" />
                {format(new Date(job.createdAt), "yyyy年MM月dd日 HH:mm")}
              </span>
              <span className="flex items-center gap-1.5">
                <Tag className="w-4 h-4" />
                模板: {templateLabels[job.template] || job.template}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleExportCSV}>
              <Download className="w-4 h-4 mr-1.5" /> 导出 CSV
            </Button>
            <Button onClick={handleExportJSON}>
              <Download className="w-4 h-4 mr-1.5" /> 导出 JSON
            </Button>
          </div>
        </div>

        {job.summary && (
          <Card className="mb-8 p-6 bg-gradient-to-br from-primary/5 to-transparent border-primary/10">
            <h3 className="text-sm font-bold text-primary mb-2">AI 摘要</h3>
            <p className="text-slate-700 leading-relaxed">{job.summary}</p>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 flex flex-col gap-4">
            <Card className="flex flex-col overflow-hidden">
              <div className="flex border-b border-slate-100 bg-slate-50">
                <button
                  onClick={() => setActiveTab("visual")}
                  className={`flex-1 py-3 text-sm font-medium transition-all ${
                    activeTab === "visual" ? "bg-white text-primary border-b-2 border-primary" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <TableIcon className="w-4 h-4 inline mr-2 align-text-bottom" />
                  提取字段 ({job.fields.length})
                </button>
                <button
                  onClick={() => setActiveTab("json")}
                  className={`flex-1 py-3 text-sm font-medium transition-all ${
                    activeTab === "json" ? "bg-white text-primary border-b-2 border-primary" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <FileJson className="w-4 h-4 inline mr-2 align-text-bottom" />
                  原始 JSON
                </button>
              </div>

              <div className="p-6 bg-slate-50/30">
                {activeTab === "visual" ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {job.fields.map((field, idx) => {
                      const conf = field.confidence === "high" ? "success" 
                                 : field.confidence === "low" ? "error" 
                                 : "warning";
                      return (
                        <div key={idx} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-xs font-semibold text-slate-500 uppercase">{field.key}</span>
                            <Badge variant={conf}>{field.confidence === "high" ? "高" : field.confidence === "low" ? "低" : "中"}</Badge>
                          </div>
                          <div className="text-sm font-medium text-slate-900 break-words">{field.value}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <pre className="p-4 rounded-xl bg-slate-900 text-slate-50 text-sm overflow-x-auto shadow-inner">
                    <code>{JSON.stringify(job.rawJson, null, 2)}</code>
                  </pre>
                )}
              </div>
            </Card>
          </div>

          <div className="lg:col-span-1">
            <Card className="p-5 sticky top-24">
              <h3 className="text-sm font-bold text-slate-900 mb-3 border-b border-slate-100 pb-2">源文本预览</h3>
              <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
                {job.textPreview}
                {job.textPreview.length >= 200 && <span className="text-slate-400">...</span>}
              </p>
            </Card>
          </div>
        </div>

      </div>
    </Layout>
  );
}
