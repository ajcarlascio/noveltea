/**
 * Bringing files into the binder.
 *
 * Separate from the chooser that picks them so the interesting half — what lands
 * in the binder, in what order, and what happens when one file of five is
 * unreadable — is testable without a DOM.
 *
 * Every step is local. Reading the file is a `FileReader`, parsing is string work,
 * and the writes go to the SQLite replica through the same commands the New
 * document button uses, which means each import is queued for sync like any other
 * edit and needs no connection to succeed.
 */

import { createDocument } from "@/data/binder";
import { saveDocument } from "@/data/documents";
import type { DatabaseClient } from "@/db/client";
import { summarise } from "@/features/editor/text";
import { documentFromFile, importExtension, titleFromFileName } from "./markdown";

export interface ImportSource {
  fileName: string;
  text: string;
}

export interface ImportOutcome {
  /** Ids of the documents created, in the order the files were given. */
  created: string[];
  /** One sentence per file that could not be imported. */
  errors: string[];
}

/** A file this big is not a manuscript chapter, and reading it would lock the tab. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Creates one document per file, beside whatever is selected.
 *
 * A file that fails takes only itself down: four good chapters out of five is the
 * outcome an author wants, not a refusal to import any of them. The failures come
 * back as sentences rather than being thrown, because every one of them is
 * something the author can act on — a wrong file type, a file too large.
 */
export async function importDocuments(
  db: DatabaseClient,
  projectId: string,
  parentId: string | null,
  sources: ImportSource[],
): Promise<ImportOutcome> {
  const created: string[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    if (importExtension(source.fileName) === null) {
      errors.push(`“${source.fileName}” is not a text or Markdown file.`);
      continue;
    }
    if (source.text.length > MAX_IMPORT_BYTES) {
      errors.push(`“${source.fileName}” is larger than 5 MB.`);
      continue;
    }

    const content = documentFromFile(source.fileName, source.text);
    const { searchText, words } = summarise(content);
    // The binder row first, then the body: saveDocument writes to a document row the
    // create already made, and each is its own transaction with its own queue entry.
    const item = await createDocument(db, projectId, parentId, titleFromFileName(source.fileName));
    await saveDocument(db, projectId, item.id, content, searchText, words);
    created.push(item.id);
  }

  return { created, errors };
}

/**
 * Reads a picked file as text.
 *
 * `file.text()` where the platform has it, `FileReader` where it does not — jsdom
 * has neither reliably, and WebKitGTK is old enough to be worth the fallback.
 */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}
