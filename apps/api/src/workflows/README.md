# Workflow 父级写前检查

公开入口 `apps/api/src/workflows/index.ts` 导出
`ProjectWriteAccessWorkflow`、`WorkflowModule` 与相关输入/结果类型。
当前不挂入 `AppModule`，等待首个业务 Workflow 或 Controller 接入后按
`AppModule` 的鉴权装配条件启用。

`ProjectWriteAccessWorkflow` 不开启事务，只接收调用方已经持有的
`TransactionContext`，并按以下顺序检查：

1. `SessionAuthService.resolveActorInTransaction` 解析当前 actor；
2. `ProjectAccessQueryPort.checkProjectForWrite` 锁定并检查项目；
3. `ModuleQueryPort.checkModuleForWrite` 锁定并检查模块。

任一步返回失败后立即停止，不调用后续 Port。失败结果使用类型化
`kind`，由 HTTP 层再映射为 401 / 404 / 409，不在此处抛 Nest HTTP 异常。

```typescript
await this.unitOfWork.run(async (tx) => {
  const access = await this.writeAccess.checkModuleForWrite(tx, {
    cookieHeader,
    projectId,
    moduleId,
  });
  if (access.kind !== "allowed") {
    throw this.mapWriteAccessError(access.kind);
  }
  // 继续使用 access.actor / access.project / access.module。
});
```

验证：`pnpm --filter @inpulse/api exec vitest run test/project-write-access.workflow.test.ts`，
覆盖成功路径与 session、project、module 三层任一失败时的短路行为。
真实数据库行锁语义由 B 的 `write-query-ports.integration.test.ts` 与 A 的
`project-access.integration.test.ts` 分别覆盖；本 Workflow 层只验证编排顺序与结果映射。


## F-19 组合完成

`TaskCompletionModule` 已接入 AppModule 的鉴权装配，提供 `POST /api/v1/tasks/{taskId}/complete`。HTTP 的 IdempotencyRunner 持有唯一 UnitOfWork，TaskCompletionWorkflow 预读完整父级，按项目→模块→任务→组→记录→遗留项顺序调用公开端口；绑定/创建草稿、条件完成任务、v1 发布与全部副作用同事务提交。实现边界、重放与定向真库证据见 [F-19 交审说明](../../../../docs/f19-local-handoff.md)。

旧两条任务状态路由也由本模块的 TaskStatusCompatibilityController 单一调用兼容 Use Case；COMPLETE 复用组合 Workflow，其余三种状态通过 Tasks 公开 TaskStatusCommandPort 保留领域服务行为。旧请求/单任务 DTO 不变，幂等及重放授权升级 2.0.0，旧 Key 返回 409。
## F-20 遗留转任务

LeftoverTaskModule提供转换POST、当前继承预览GET和任务来源GET。Workflow只经FollowupTaskCommandPort/LeftoverRecordCommandPort调用领域实现，唯一显式事务及project→module→record→leftover锁序；新任务创建前已锁全父级。转换原子更新链接/CONVERTED及记录行版本，不修改正式版本或正文；重复引用须实时授权。见[F-20交审说明](../../../../docs/f20-local-handoff.md)。
