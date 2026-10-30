import type { Sql } from "postgres";

import type { SearchProjectionVisibilityScope } from "./search-projection.types.js";

export type { SearchProjectionVisibilityScope } from "./search-projection.types.js";

export interface SearchProjectionReadInput {
  readonly normalizedQuery: string;
  readonly projectIds: readonly number[];
  readonly visibilityScopes: readonly SearchProjectionVisibilityScope[];
  readonly limit: number;
  readonly afterId: bigint;
}

export interface SearchProjectionItem {
  readonly id: string;
  readonly projectId: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly moduleId: number | null;
  readonly recordId: number | null;
  readonly title: string;
  readonly summary: string;
}

export interface SearchProjectionPage {
  readonly items: readonly SearchProjectionItem[];
  readonly nextAfterId: bigint | null;
}

export interface SearchProjectionReader {
  read(input: SearchProjectionReadInput): Promise<SearchProjectionPage>;
}

interface SearchProjectionRow {
  readonly id: string;
  readonly project_id: number;
  readonly entity_type: string;
  readonly entity_id: number;
  readonly module_id: number | null;
  readonly record_id: number | null;
  readonly title: string;
  readonly summary: string;
}

export class PostgresSearchProjectionReader implements SearchProjectionReader {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async read(input: SearchProjectionReadInput): Promise<SearchProjectionPage> {
    if (input.projectIds.length === 0 || input.visibilityScopes.length === 0) {
      return { items: [], nextAfterId: null };
    }

    const projectIds = [...new Set(input.projectIds)];
    const rows = await this.#sql.unsafe<SearchProjectionRow[]>(
      `SELECT
         sp.id::text AS id,
         project_id,
         entity_type,
         entity_id,
         module_id,
         record_id,
         title,
         summary
       FROM app.search_projection AS sp
      WHERE normalized_search_text &@~
            app.pgroonga_query_escape($1)
        AND project_id = ANY($2::int[])
        AND visibility_scope = ANY($3::text[])
        AND sp.id > $4::bigint
      ORDER BY sp.id ASC
      LIMIT $5`,
      [
        input.normalizedQuery,
        projectIds,
        [...input.visibilityScopes],
        input.afterId.toString(),
        input.limit + 1,
      ],
    );

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        moduleId: row.module_id,
        recordId: row.record_id,
        title: row.title,
        summary: row.summary,
      })),
      nextAfterId: hasMore && last !== undefined ? BigInt(last.id) : null,
    };
  }
}
