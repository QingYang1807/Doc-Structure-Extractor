import { Link } from "wouter";
import { format } from "date-fns";
import { useGetHistory, useDeleteHistoryItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, Button, Badge } from "@/components/ui-elements";
import { History as HistoryIcon, Trash2, ArrowRight, FileText, SearchX } from "lucide-react";

export default function HistoryPage() {
  const { data, isLoading } = useGetHistory({ limit: 50 });
  const deleteMutation = useDeleteHistoryItem();
  const queryClient = useQueryClient();

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (confirm("确定要删除这条记录吗？")) {
      await deleteMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: ["/api/history"] });
    }
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
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-slate-900 flex items-center gap-3">
              <HistoryIcon className="w-8 h-8 text-primary" />
              历史记录
            </h1>
            <p className="mt-2 text-slate-500">查看过往的文档抽取结果和数据。</p>
          </div>
        </div>

        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center text-slate-500">正在加载历史记录...</div>
          ) : !data?.items || data.items.length === 0 ? (
            <div className="p-16 flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                <SearchX className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-1">暂无抽取记录</h3>
              <p className="text-slate-500 mb-6">您还没有进行过任何文档抽取。</p>
              <Link href="/">
                <Button>去抽取文档</Button>
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.items.map((job) => (
                <Link key={job.id} href={`/history/${job.id}`}>
                  <div className="group block p-5 hover:bg-slate-50 transition-colors cursor-pointer relative">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <Badge variant="default" className="bg-primary/10 text-primary border-primary/20">
                            {templateLabels[job.template] || job.template}
                          </Badge>
                          <span className="text-sm text-slate-400">
                            {format(new Date(job.createdAt), "yyyy-MM-dd HH:mm")}
                          </span>
                        </div>
                        <div className="flex items-start gap-3">
                          <FileText className="w-5 h-5 text-slate-300 mt-0.5 shrink-0" />
                          <p className="text-sm text-slate-600 line-clamp-2 leading-relaxed">
                            {job.textPreview}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 sm:pl-4 sm:border-l border-slate-200">
                        <div className="text-center px-4 hidden sm:block">
                          <div className="text-2xl font-display font-bold text-slate-900">
                            {job.fields?.length || 0}
                          </div>
                          <div className="text-xs text-slate-500">提取字段</div>
                        </div>
                        
                        <div className="flex items-center gap-2 ml-auto sm:ml-0">
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="text-rose-500 hover:text-rose-600 hover:bg-rose-50 z-10 relative"
                            onClick={(e) => handleDelete(job.id, e)}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-colors text-slate-400">
                            <ArrowRight className="w-4 h-4" />
                          </div>
                        </div>
                      </div>

                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}
