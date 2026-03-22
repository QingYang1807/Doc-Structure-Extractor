import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui-elements";

export default function NotFound() {
  return (
    <Layout>
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="text-9xl font-display font-bold text-slate-200 mb-4">404</h1>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">页面未找到</h2>
        <p className="text-slate-500 mb-8 max-w-md">
          抱歉，您访问的页面不存在或已被移除。
        </p>
        <Link href="/">
          <Button>返回首页</Button>
        </Link>
      </div>
    </Layout>
  );
}
