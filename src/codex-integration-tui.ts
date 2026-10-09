import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { firstTableIndex, insertDocumentLine, parseDocument, removeDocumentLine, renderDocument } from "./codex-integration-document";
import { MANAGED_AUTO_RECAP_LINE, type PreviousAutoRecapAssignment } from "./codex-integration-shared";

interface AutoRecapSource {
  field?: AST.TOMLKeyValue;
  inline?: AST.TOMLInlineTable;
  table?: AST.TOMLTable;
  tableEnd?: number;
  tablePresent: boolean;
  location: PreviousAutoRecapAssignment["location"];
  value?: "true" | "false";
  rawLine?: string;
}

function findAutoRecap(text: string): AutoRecapSource {
  // Preserve offsets when the document has a BOM or uses CR without LF.
  const ast = parseTOML(text.replace(/^\uFEFF/, " ").replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" });
  const config = getStaticTOMLValue(ast) as { tui?: { auto_recap?: unknown } };
  if (config.tui !== undefined && (!config.tui || typeof config.tui !== "object" || Array.isArray(config.tui))) {
    throw new Error("Codex tui must be a table");
  }
  const value = config.tui?.auto_recap;
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("auto_recap in Codex [tui] must be a boolean");
  }
  const source: AutoRecapSource = { tablePresent: config.tui !== undefined, location: "table" };
  const visit = (entry: AST.TOMLKeyValue, parent: string[], inline?: AST.TOMLInlineTable): void => {
    const path = [...parent, ...getStaticTOMLValue(entry.key)];
    if (path.length === 2 && path[0] === "tui" && path[1] === "auto_recap") {
      source.field = entry;
      source.location = inline ? "inline" : parent.length === 0 ? "dotted" : "table";
    }
    if (path.length === 1 && path[0] === "tui") {
      if (entry.value.type === "TOMLInlineTable") source.inline = entry.value;
    } else if (parent.length === 0 && path[0] === "tui" && path.length > 1 && !source.field) {
      source.location = "dotted";
    }
    if (entry.value.type === "TOMLInlineTable") {
      for (const child of entry.value.body) visit(child, path, entry.value);
    }
  };
  const nodes = ast.body[0].body;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.type === "TOMLTable") {
      if (node.resolvedKey.some(key => typeof key !== "string")) continue;
      const path = node.resolvedKey as string[];
      if (path.length === 1 && path[0] === "tui") {
        source.table = node;
        source.tableEnd = nodes[index + 1]?.loc.start.line;
      }
      for (const entry of node.body) visit(entry, path);
    } else {
      visit(node, []);
    }
  }
  if (source.inline && !source.field) source.location = "inline";
  if (source.field) {
    source.value = value === true ? "true" : "false";
    source.rawLine = source.location === "inline"
      ? text.slice(...source.field.range)
      : parseDocument(text).lines[source.field.loc.start.line - 1];
  }
  return source;
}

function changed(disconnected = false): Error {
  return new Error(`Codex [tui].auto_recap changed ${disconnected ? "while the bridge was disconnected" : "after setup"}; refusing to overwrite the user's newer value`);
}

export function installAutoRecap(text: string): { text: string; previousAutoRecap: PreviousAutoRecapAssignment } {
  const source = findAutoRecap(text);
  const previous: PreviousAutoRecapAssignment = {
    present: Boolean(source.field),
    tablePresent: source.tablePresent,
    location: source.location,
    installedAssignment: "auto_recap = false",
    ...(source.field ? { rawLine: source.rawLine, value: source.value } : {}),
  };
  if (source.field) {
    const [start, end] = source.field.value.range;
    const installedText = text.slice(0, start) + "false" + text.slice(end);
    previous.installedAssignment = findAutoRecap(installedText).rawLine!;
    return { text: installedText, previousAutoRecap: previous };
  }
  if (source.inline) {
    const position = source.inline.body.at(-1)?.range[1] ?? source.inline.range[0] + 1;
    previous.inlineInsertion = `${source.inline.body.length > 0 ? ", " : ""}auto_recap = false`;
    return {
      text: text.slice(0, position) + previous.inlineInsertion + text.slice(position),
      previousAutoRecap: previous,
    };
  }
  const document = parseDocument(text);
  if (source.location === "dotted") {
    const line = `tui.${MANAGED_AUTO_RECAP_LINE}`;
    previous.installedAssignment = line;
    insertDocumentLine(document, firstTableIndex(document.lines), line);
  } else if (source.table) {
    let index = source.tableEnd === undefined ? document.lines.length : source.tableEnd - 1;
    while (index > source.table.loc.start.line && document.lines[index - 1]?.trim() === "") index -= 1;
    previous.installedAssignment = MANAGED_AUTO_RECAP_LINE;
    insertDocumentLine(document, index, MANAGED_AUTO_RECAP_LINE);
  } else {
    // A parent implicit in [tui.child] becomes explicit here and must remain implicit on restore.
    previous.tablePresent = false;
    if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
      insertDocumentLine(document, document.lines.length, "");
      previous.separatorInserted = true;
    }
    insertDocumentLine(document, document.lines.length, "[tui]");
    insertDocumentLine(document, document.lines.length, MANAGED_AUTO_RECAP_LINE);
    previous.installedAssignment = MANAGED_AUTO_RECAP_LINE;
  }
  return { text: renderDocument(document), previousAutoRecap: previous };
}

export function verifyAutoRecap(text: string, previous: PreviousAutoRecapAssignment): void {
  const source = findAutoRecap(text);
  if (source.value !== "false" || source.location !== previous.location || source.rawLine !== previous.installedAssignment) {
    throw changed();
  }
}

export function verifyRestoredAutoRecap(text: string, previous: PreviousAutoRecapAssignment): void {
  const source = findAutoRecap(text);
  if (Boolean(source.field) !== previous.present
    || (previous.present && (source.value !== previous.value || source.rawLine !== previous.rawLine || source.location !== previous.location))) {
    throw changed(true);
  }
}

export function restoreAutoRecap(text: string, previous: PreviousAutoRecapAssignment): string {
  verifyAutoRecap(text, previous);
  const source = findAutoRecap(text);
  const field = source.field!;
  if (previous.present) {
    const [start, end] = field.value.range;
    return text.slice(0, start) + previous.value! + text.slice(end);
  }
  if (source.inline) {
    const fragment = previous.inlineInsertion;
    if (!fragment) throw new Error("Codex integration journal is missing the auto_recap inline insertion");
    const end = field.range[1];
    const start = end - fragment.length;
    if (text.slice(start, end) !== fragment) throw changed();
    if (!fragment.startsWith(",") && source.inline.body.length > 1) {
      // An initially empty inline table can acquire unrelated fields while installed.
      const next = source.inline.body[1]!;
      const comma = text.indexOf(",", end);
      if (comma < 0 || comma >= next.range[0]) throw changed();
      return text.slice(0, start) + text.slice(comma + 1);
    }
    return text.slice(0, start) + text.slice(end);
  }
  const document = parseDocument(text);
  removeDocumentLine(document, field.loc.start.line - 1);
  if (!previous.tablePresent && source.table) {
    const header = source.table.loc.start.line - 1;
    const end = source.tableEnd === undefined ? document.lines.length : source.tableEnd - 2;
    if (document.lines.slice(header + 1, end).every(line => line.trim() === "")) {
      removeDocumentLine(document, header);
      if (previous.separatorInserted && document.lines[header - 1] === "") removeDocumentLine(document, header - 1);
    }
  }
  return renderDocument(document);
}

/** Replacement releases only the assignment whose source still matches the saved installation. */
export function restoreOwnedAutoRecap(text: string, previous: PreviousAutoRecapAssignment): string {
  const source = findAutoRecap(text);
  if (source.value !== "false" || source.location !== previous.location || source.rawLine !== previous.installedAssignment) return text;
  return restoreAutoRecap(text, previous);
}
