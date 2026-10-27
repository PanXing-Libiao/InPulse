export interface OrganizationDisplaySource {
  readonly name: string;
  readonly source: "LOCAL" | "CASDOOR";
  readonly groupPath?: string | null | undefined;
}

const CASDOOR_GROUP_LABELS: Readonly<Record<string, string>> = {
  "mechanical team": "机械团队",
  "basic rd": "基础研发",
  "overseas sales dept": "海外销售部",
  "software technical support": "软件技术支持",
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

/** 完整路径保留 owner 与真实层级；只翻译用户可见的末级部门名。 */
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
