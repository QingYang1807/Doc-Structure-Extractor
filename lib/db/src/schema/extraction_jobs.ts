import { pgTable, serial, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const extractionJobsTable = pgTable("extraction_jobs", {
  id: serial("id").primaryKey(),
  template: text("template").notNull(),
  textPreview: text("text_preview").notNull(),
  rawText: text("raw_text").notNull(),
  fields: jsonb("fields").notNull().$type<Array<{ key: string; value: string; confidence: string }>>(),
  rawJson: jsonb("raw_json").notNull().$type<Record<string, unknown>>(),
  summary: text("summary").notNull().default(""),
  customFields: jsonb("custom_fields").$type<string[]>(),
  fieldCount: integer("field_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertExtractionJobSchema = createInsertSchema(extractionJobsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertExtractionJob = z.infer<typeof insertExtractionJobSchema>;
export type ExtractionJob = typeof extractionJobsTable.$inferSelect;
