import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { expect, test } from "vitest";
import {
  ModuleQueryPort,
  ModulesModule,
} from "../src/modules/modules/index.js";

test("domain Nest modules expose module write-check ports without a database provider", async () => {
  const modules = await NestFactory.createApplicationContext(ModulesModule, {
    logger: false,
  });
  try {
    expect(modules.get(ModuleQueryPort)).toBeInstanceOf(ModuleQueryPort);
  } finally {
    await modules.close();
  }
});
