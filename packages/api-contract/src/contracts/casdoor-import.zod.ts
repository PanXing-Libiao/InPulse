import { z } from "zod";

/** 单次 Casdoor 目录预览与导入的账号上限，与管理员用户列表上限一致。 */
export const CASDOOR_IMPORT_LIMIT = 1000;

const casdoorIdentitySchema = z
  .object({
    casdoorId: z.string().trim().min(1).max(200),
    loginName: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(200),
    email: z.string().trim().min(3).max(320).nullable(),
    /** 已过滤为配置组织下、启用中的 Casdoor Physical 组完整路径。 */
    groups: z.array(z.string().min(3).max(512)).max(100),
  })
  .strict();

export const casdoorImportActionSchema = z
  .enum(["create", "link", "refresh", "unchanged", "skip"])
  .meta({ id: "CasdoorImportAction" });

export type CasdoorImportAction = z.infer<typeof casdoorImportActionSchema>;

export const casdoorImportSkipReasonSchema = z
  .enum([
    "account-disabled",
    "account-deleted",
    "subject-bound-to-other-account",
    "email-mismatch",
    "email-taken",
  ])
  .meta({ id: "CasdoorImportSkipReason" });

export type CasdoorImportSkipReason = z.infer<
  typeof casdoorImportSkipReasonSchema
>;

/**
 * 预览条目只包含管理员决定是否导入所需的脱敏目录字段。
 * `skip` 必须带原因；可执行动作的 reason 固定为 null。
 */
export const casdoorImportPreviewItemSchema = casdoorIdentitySchema
  .extend({
    action: casdoorImportActionSchema,
    reason: casdoorImportSkipReasonSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "skip" && value.reason === null) {
      context.addIssue({
        code: "custom",
        message: "跳过的账号必须说明原因",
        path: ["reason"],
      });
    }
    if (value.action !== "skip" && value.reason !== null) {
      context.addIssue({
        code: "custom",
        message: "可导入账号不得携带跳过原因",
        path: ["reason"],
      });
    }
  })
  .meta({ id: "CasdoorImportPreviewItem" });

export type CasdoorImportPreviewItem = z.infer<
  typeof casdoorImportPreviewItemSchema
>;

export const casdoorImportCountsSchema = z
  .object({
    create: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    link: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    refresh: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    unchanged: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    skip: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
  })
  .strict()
  .meta({ id: "CasdoorImportCounts" });

export type CasdoorImportCounts = z.infer<typeof casdoorImportCountsSchema>;

/** 管理员主动触发的目录预览；响应 no-store，不包含任何 Casdoor 凭据字段。 */
export const casdoorImportPreviewResponseSchema = z
  .object({
    organization: z.string().trim().min(1).max(100),
    fetchedAt: z.iso.datetime(),
    scannedUserCount: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    items: z.array(casdoorImportPreviewItemSchema).max(CASDOOR_IMPORT_LIMIT),
    counts: casdoorImportCountsSchema,
  })
  .strict()
  .meta({ id: "CasdoorImportPreviewResponse" });

export type CasdoorImportPreviewResponse = z.infer<
  typeof casdoorImportPreviewResponseSchema
>;

/**
 * 确认导入只接受预览后勾选的 Casdoor 稳定标识。服务端会按当前目录重新
 * 获取账号事实；预览后新增、启用或改组的账号不会因旧预览被静默导入。
 */
export const casdoorImportRequestSchema = z
  .object({
    casdoorUserIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(CASDOOR_IMPORT_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Casdoor 账号标识不能重复",
      }),
  })
  .strict()
  .meta({ id: "CasdoorImportRequest" });

export type CasdoorImportRequest = z.infer<typeof casdoorImportRequestSchema>;

/** 导入结果最小化为计数；不持久化或重放任何目录 PII。 */
export const casdoorImportResultSchema = z
  .object({
    scannedUserCount: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    created: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    linked: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    refreshed: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    skipped: z.number().int().min(0).max(CASDOOR_IMPORT_LIMIT),
    createdOrganizationCount: z.number().int().min(0),
    membershipCount: z.number().int().min(0),
  })
  .strict()
  .meta({ id: "CasdoorImportResult" });

export type CasdoorImportResult = z.infer<typeof casdoorImportResultSchema>;
