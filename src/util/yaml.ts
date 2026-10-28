// Small YAML subset codec for harness-owned configuration/state files.
// Supports mappings, arrays, strings, numbers, booleans and null. It intentionally
// rejects advanced YAML features so project state stays deterministic and auditable.

type Scalar = string | number | boolean | null;
type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };

function scalar(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === "" || /[:#\[\]{},&*!|>'\"%@`\n\r\t]/.test(value) || /^[-?:]\s/.test(value) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function stringifyYaml(value: YamlValue, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => {
      if (item !== null && typeof item === "object") {
        const rendered = stringifyYaml(item, indent + 2);
        const lines = rendered.split("\n");
        return `${pad}- ${lines[0].trimStart()}${lines.length > 1 ? `\n${lines.slice(1).join("\n")}` : ""}`;
      }
      return `${pad}- ${scalar(item as Scalar)}`;
    }).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, item]) => {
      if (Array.isArray(item) && item.length === 0) return `${pad}${key}: []`;
      if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.values(item).filter((v) => v !== undefined).length === 0) return `${pad}${key}: {}`;
      if (item !== null && typeof item === "object") return `${pad}${key}:\n${stringifyYaml(item, indent + 2)}`;
      return `${pad}${key}: ${scalar(item as Scalar)}`;
    }).join("\n");
  }
  return `${pad}${scalar(value as Scalar)}`;
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === "null" || s === "~") return null;
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) return JSON.parse(s);
  return s;
}

interface Line { indent: number; text: string; line: number }

export function parseYaml(text: string): YamlValue {
  const lines: Line[] = text.split(/\r?\n/)
    .map((raw, i) => ({ indent: raw.match(/^ */)?.[0].length ?? 0, text: raw.trim(), line: i + 1 }))
    .filter((l) => l.text && !l.text.startsWith("#"));
  let pos = 0;

  function parseBlock(indent: number): YamlValue {
    if (pos >= lines.length) return {};
    if (lines[pos].indent === indent && (lines[pos].text === "{}" || lines[pos].text === "[]")) {
      return parseScalar(lines[pos++].text);
    }
    const arrayMode = lines[pos].indent === indent && lines[pos].text.startsWith("- ");
    if (arrayMode) {
      const arr: YamlValue[] = [];
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) {
        const line = lines[pos++];
        const rest = line.text.slice(2).trim();
        if (!rest) arr.push(pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : {});
        else if (!rest.startsWith('"') && rest.includes(":")) {
          const idx = rest.indexOf(":");
          const key = rest.slice(0, idx).trim();
          const val = rest.slice(idx + 1).trim();
          const hasNested = pos < lines.length && (
            lines[pos].indent > indent + 2 ||
            (lines[pos].indent === indent + 2 && lines[pos].text.startsWith("- "))
          );
          const obj: Record<string, YamlValue> = { [key]: val ? parseScalar(val) : (hasNested ? parseBlock(lines[pos].indent) : {}) };
          while (pos < lines.length && lines[pos].indent === indent + 2 && !lines[pos].text.startsWith("- ")) {
            const child = lines[pos++];
            const ci = child.text.indexOf(":");
            if (ci < 0) throw new Error(`Unsupported YAML at line ${child.line}`);
            const ck = child.text.slice(0, ci).trim();
            const cv = child.text.slice(ci + 1).trim();
            obj[ck] = cv ? parseScalar(cv) : (pos < lines.length && lines[pos].indent > indent + 2 ? parseBlock(lines[pos].indent) : {});
          }
          arr.push(obj);
        } else arr.push(parseScalar(rest));
      }
      return arr;
    }

    const obj: Record<string, YamlValue> = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const line = lines[pos++];
      const idx = line.text.indexOf(":");
      if (idx < 0) throw new Error(`Unsupported YAML at line ${line.line}`);
      const key = line.text.slice(0, idx).trim();
      const rest = line.text.slice(idx + 1).trim();
      obj[key] = rest ? parseScalar(rest) : (pos < lines.length && lines[pos].indent > indent ? parseBlock(lines[pos].indent) : {});
    }
    return obj;
  }

  const result = parseBlock(lines[0]?.indent ?? 0);
  if (pos !== lines.length) throw new Error(`Unsupported YAML near line ${lines[pos].line}`);
  return result;
}
