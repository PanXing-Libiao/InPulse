import React from "react";
import { Button, Result } from "antd";
import { useNavigate } from "react-router-dom";
import { navigatePrepared } from "@shared/routing/navigate-prepared";

/**
 * 未匹配路由的兜底页。
 *
 * 根路由必须始终渲染 AppLayout 外壳，未匹配路径只替换内容区，
 * 不允许落到 React Router 默认错误页（那会把侧边栏、顶栏一起换掉）。
 */
export const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div data-testid="route-not-found" style={{ padding: 48 }}>
      <Result
        status="404"
        title="页面不存在"
        subTitle="地址可能已失效或输入有误。你也可以回到任务中心继续工作。"
        extra={
          <>
            <Button
              type="primary"
              onClick={() => void navigatePrepared(navigate, "/tasks")}
            >
              回到任务中心
            </Button>
            <Button onClick={() => navigate(-1)}>返回上一页</Button>
          </>
        }
      />
    </div>
  );
};

export default NotFoundPage;
