import type { TransactionContext } from "../../database/transaction-context.js";
import { ProjectCodePort } from "./project-code.port.js";

export class PostgresProjectCodePort extends ProjectCodePort {
  async allocateChangeRecordCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string> {
    const [project] = await tx.sql<
      { code: string }[]
    >`SELECT code FROM app.projects WHERE id=${projectId}`;
    if (!project) throw new Error("Authorized project missing");
    const [sequence] = await tx.sql<
      { number: string }[]
    >`INSERT INTO app.code_sequences(project_id,entity_type,last_number) VALUES(${projectId},'CHANGE_RECORD',1) ON CONFLICT(project_id,entity_type) DO UPDATE SET last_number=app.code_sequences.last_number+1 RETURNING last_number::text AS number`;
    if (!sequence) throw new Error("Code allocation failed");
    return `${project.code}-CR-${sequence.number}`;
  }
  async allocateTaskCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string> {
    const [project] = await tx.sql<
      { code: string }[]
    >`SELECT code FROM app.projects WHERE id = ${projectId}`;
    if (!project) throw new Error("Authorized project missing");
    const [sequence] = await tx.sql<
      { number: string }[]
    >`INSERT INTO app.code_sequences (project_id, entity_type, last_number) VALUES (${projectId}, 'TASK', 1) ON CONFLICT (project_id, entity_type) DO UPDATE SET last_number = app.code_sequences.last_number + 1 RETURNING last_number::text AS number`;
    if (!sequence) throw new Error("Code allocation failed");
    return `${project.code}-T-${sequence.number}`;
  }
  async findProjectCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string | undefined> {
    const [row] = await tx.sql<
      { code: string }[]
    >`SELECT code FROM app.projects WHERE id = ${projectId}`;
    return row?.code;
  }

  async isCodeAvailable(tx: TransactionContext, code: string) {
    const [row] = await tx.sql<
      { exists: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM app.projects WHERE code = ${code}) AS exists`;
    return row !== undefined && !row.exists;
  }

  async allocateTaskGroupCode(
    tx: TransactionContext,
    projectId: number,
  ): Promise<string> {
    const [project] = await tx.sql<
      { code: string }[]
    >`SELECT code FROM app.projects WHERE id = ${projectId}`;
    if (!project) throw new Error("Authorized project missing");
    const [sequence] = await tx.sql<
      { number: string }[]
    >`INSERT INTO app.code_sequences (project_id, entity_type, last_number) VALUES (${projectId}, 'TASK_GROUP', 1) ON CONFLICT (project_id, entity_type) DO UPDATE SET last_number = app.code_sequences.last_number + 1 RETURNING last_number::text AS number`;
    if (!sequence) throw new Error("Code allocation failed");
    return `${project.code}-TG-${sequence.number}`;
  }
}
