import { ApiError } from "@generated/api";
import {
  SESSION_EXPIRED_INPUT_PRESERVED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
} from "@shared/api/request-messages";

/**
 * 草稿创建/编辑与草稿列表的统一错误文案：输入与幂等键始终保留，提示可重试。
 */
export function recordDraftErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_INPUT_PRESERVED_MESSAGE;
    if (error.status === 404)
      return "草稿或所属范围不存在，或你已无权访问。输入已保留。";
    if (error.status === 403) return "权限或安全校验未通过。输入已保留。";
    if (error.status === 409) return `${error.message}，输入已保留。`;
    if (error.status === 422)
      return "请检查三段必填内容、标题和所属范围。输入已保留。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。输入已保留。";
  }
  return "草稿服务暂时不可用，输入已保留，可重试。";
}

/**
 * 草稿列表读取失败的文案：与创建/编辑失败分开——列表读取不会丢任何未提交输入，
 * 沿用「输入已保留」会让用户以为自己的编辑被暂存了。
 */
export function recordDraftListErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "权限或安全校验未通过，无法读取草稿列表。";
    if (error.status === 404)
      return "该项目不存在或你已无权访问，无法读取草稿。";
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "草稿服务暂时不可用，请重试。";
}

/**
 * 删除草稿的错误文案：删除失败时草稿与弹窗都保留；409 直接透出服务端原因
 * （版本冲突或状态已变化，提示用户加载最新内容后重试）。
 */
export function recordDraftDeleteErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 403) return "权限或安全校验未通过，无法删除。";
    if (error.status === 404) return "草稿不存在，或已经被删除。";
    if (error.status === 409) return error.message;
    if (error.status === 429) return "请求过于频繁，请稍后重试。";
  }
  return "草稿服务暂时不可用，可重试。";
}
