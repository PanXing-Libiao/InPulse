import { beforeEach, describe, expect, it } from "vitest";
import {
  orderProjectsStarredFirst,
  readStarredProjectIds,
  toggleStarredProjectId,
} from "./project-star";

const ACCOUNT_KEY = "inpulse.projects.starred.7";
const OTHER_ACCOUNT_KEY = "inpulse.projects.starred.9";
const LEGACY_KEY = "inpulse.projects.starred";

describe("项目星标本地存储（按账号各一份）", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("没有记录时返回空列表", () => {
    expect(readStarredProjectIds(7)).toEqual([]);
  });

  it("读取当前账号自己的记录", () => {
    globalThis.localStorage.setItem(ACCOUNT_KEY, "[2,5]");
    expect(readStarredProjectIds(7)).toEqual([2, 5]);
  });

  it("只读自己账号那份，不串到其他账号", () => {
    globalThis.localStorage.setItem(OTHER_ACCOUNT_KEY, "[3]");
    expect(readStarredProjectIds(7)).toEqual([]);
    expect(readStarredProjectIds(9)).toEqual([3]);
  });

  it("内容损坏、不是数组或含非法项时都不抛错", () => {
    globalThis.localStorage.setItem(ACCOUNT_KEY, "{oops");
    expect(readStarredProjectIds(7)).toEqual([]);

    globalThis.localStorage.setItem(ACCOUNT_KEY, '{"2":true}');
    expect(readStarredProjectIds(7)).toEqual([]);

    globalThis.localStorage.setItem(ACCOUNT_KEY, '[2,"5",0,-1,3.5,null]');
    expect(readStarredProjectIds(7)).toEqual([2]);
  });

  it("首版全局记录只被接管一次，不会落到下一个登录的账号上", () => {
    globalThis.localStorage.setItem(LEGACY_KEY, "[2]");

    expect(readStarredProjectIds(7)).toEqual([2]);
    expect(globalThis.localStorage.getItem(ACCOUNT_KEY)).toBe("[2]");
    expect(globalThis.localStorage.getItem(LEGACY_KEY)).toBeNull();

    expect(readStarredProjectIds(9)).toEqual([]);
  });

  it("切换不改变其它 ID 的相对顺序", () => {
    expect(toggleStarredProjectId([7, 2, 9], 2)).toEqual([7, 9]);
    expect(toggleStarredProjectId([7, 9], 2)).toEqual([7, 9, 2]);
  });

  it("星标项目置顶，星标组与未标组内保持原顺序", () => {
    const projects = [
      { id: 1, name: "甲" },
      { id: 2, name: "乙" },
      { id: 3, name: "丙" },
      { id: 4, name: "丁" },
    ];
    const starred = new Set([3, 4]);

    expect(
      orderProjectsStarredFirst(projects, (id) => starred.has(id)).map(
        (project) => project.id,
      ),
    ).toEqual([3, 4, 1, 2]);
    expect(projects.map((project) => project.id)).toEqual([1, 2, 3, 4]);
  });
});
