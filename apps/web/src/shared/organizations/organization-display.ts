export interface OrganizationDisplaySource {
  readonly name: string;
  readonly source: "LOCAL" | "CASDOOR";
  readonly groupPath?: string | null | undefined;
}

const CASDOOR_GROUP_LABELS: Readonly<Record<string, string>> = {
  "administration dept": "行政综合部",
  "after-sales dept": "售后部",
  "basic rd": "基础研发",
  "domestic sales dept": "国内销售部",
  "finance dept": "财务部",
  "general manager office": "总经办",
  "germany office": "德国公司",
  "hardware team": "硬件组",
  "hardware technical support": "硬件技术支持",
  "hr dept": "人力资源部",
  "legal dept": "法务部",
  libiaorobot: "立镖机器人",
  "marketing and brand dept": "市场品牌部",
  "mechanical team": "机械组",
  "next hub": "实习生",
  "overseas sales dept": "海外销售部",
  "pre-sales planning dept": "售前规划部",
  "pre-sales planning dept(overseas)": "售前规划部（海外）",
  "product dept": "产品部",
  "production dept": "生产部",
  "project dept": "项目部",
  "purchasing dept": "采购部",
  "quality dept": "品质部",
  "rd dept": "研发部",
  "singapore office": "新加坡公司",
  "software project 1": "软件项目一部",
  "software project 2": "软件项目二部",
  "software project dept": "软件项目部",
  "software technical support": "软件技术支持",
  "u.s. office": "美国公司",
  "warehouse dept": "仓储部",
};

function normalizedGroupName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function casdoorGroupLabel(value: string): string {
  return CASDOOR_GROUP_LABELS[normalizedGroupName(value)] ?? value.trim();
}

/** Casdoor 群组显示名统一在此收口；LOCAL 组织始终显示管理员填写的名称。 */
export function organizationDisplayName(
  organization: OrganizationDisplaySource,
): string {
  return organization.source === "CASDOOR"
    ? casdoorGroupLabel(organization.name)
    : organization.name.trim();
}

/** 完整路径保留 owner 与真实层级；只翻译用户可见的群组段。 */
export function organizationDisplayPath(
  organization: OrganizationDisplaySource,
): string {
  const path = organization.groupPath?.trim();
  if (!path) return organizationDisplayName(organization);
  const segments = path.split("/");
  if (segments.length < 2) return path;
  return [
    segments[0]!,
    ...segments.slice(1).map((segment) => casdoorGroupLabel(segment)),
  ].join("/");
}
