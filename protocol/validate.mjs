// protocol/validate.mjs
// 一个**有界的** JSON Schema draft 2020-12 校验器 + schema 卫生检查。
//
// 为什么自己写：M0 不允许联网装依赖（任务边界第 4 条），而拿不到 ajv。
// 为什么这样写才诚实：关键字走白名单——遇到本文件没实现的关键字直接报错，
// 而不是悄悄跳过。这样 schema 里不可能藏一个「以为在约束、其实没人执行」的字段。
//
// 支持的子集（够覆盖 protocol/ 全部七个 schema）：
//   $schema $id $defs $comment title description default examples
//   type required properties additionalProperties
//   enum const
//   minLength maxLength pattern format(date-time|uri)
//   minimum maximum exclusiveMinimum exclusiveMaximum
//   items minItems maxItems uniqueItems
//   allOf anyOf oneOf not if/then/else $ref
// 其余关键字一律视为未知并报错。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ANNOTATION_KEYWORDS = [
  "$schema",
  "$id",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
];

const VALIDATION_KEYWORDS = [
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
];

const KNOWN_KEYWORDS = new Set([...ANNOTATION_KEYWORDS, ...VALIDATION_KEYWORDS]);
const KNOWN_FORMATS = new Set(["date-time", "uri"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/;

/** 卫生检查里禁止出现的占位词——「无待定字段」是字面意思。 */
export const FORBIDDEN_PLACEHOLDERS = ["TBD", "TODO", "FIXME", "待定", "未定"];

const SCHEMA_FILE_RE = /\.schema\.json$/;

/** 列出 protocol 目录下的 schema 文件（按文件名排序，保证输出稳定）。 */
export async function listSchemaFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && SCHEMA_FILE_RE.test(e.name))
    .map((e) => join(dir, e.name))
    .sort();
}

/** 读入全部 schema，返回 [{ file, name, schema }]。 */
export async function loadSchemaDocs(dir) {
  const files = await listSchemaFiles(dir);
  const docs = [];
  for (const file of files) {
    const schema = JSON.parse(await readFile(file, "utf8"));
    docs.push({ file, name: file.split("/").pop(), schema });
  }
  return docs;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 用一组 schema 文档构造校验器。
 * @param {Array<{schema:object}>} docs
 */
export function createValidator(docs) {
  const byId = new Map();
  for (const { schema } of docs) {
    if (!schema || typeof schema.$id !== "string") {
      throw new Error("每份 schema 必须有 $id，否则 $ref 无法解析");
    }
    if (byId.has(schema.$id)) throw new Error(`$id 重复: ${schema.$id}`);
    byId.set(schema.$id, schema);
  }

  function resolveRef(ref, baseDoc) {
    const hashAt = ref.indexOf("#");
    const idPart = hashAt === -1 ? ref : ref.slice(0, hashAt);
    const pointer = hashAt === -1 ? "" : ref.slice(hashAt + 1);
    const doc = idPart === "" ? baseDoc : byId.get(idPart);
    if (!doc) throw new Error(`$ref 无法解析: ${ref}`);
    let node = doc;
    if (pointer !== "") {
      for (const raw of pointer.split("/").slice(1)) {
        const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        node = node == null ? undefined : node[key];
      }
    }
    if (node == null) throw new Error(`$ref 指向不存在的节点: ${ref}`);
    return { schema: node, doc };
  }

  function check(schema, doc, data, path, errors, depth = 0) {
    if (depth > 64) throw new Error(`$ref 递归过深: ${path}`);
    if (schema === true || schema == null) return;
    if (typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`schema 节点非法（${path}）`);
    }

    if (schema.$ref) {
      const resolved = resolveRef(schema.$ref, doc);
      check(resolved.schema, resolved.doc, data, path, errors, depth + 1);
      // draft 2020-12 允许 $ref 的兄弟关键字同时生效，继续往下跑。
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const t of types) {
        if (!JSON_TYPES.has(t)) throw new Error(`未知 type: ${t}`);
      }
      if (!types.some((t) => matchesType(data, t))) {
        errors.push({ path, keyword: "type", message: `期望 ${types.join("|")}，实际 ${typeOf(data)}` });
        return; // 类型都不对，继续查其它关键字会产出噪音
      }
    }

    if (schema.const !== undefined && !deepEqual(data, schema.const)) {
      errors.push({ path, keyword: "const", message: `必须等于 ${JSON.stringify(schema.const)}` });
    }

    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum)) throw new Error(`enum 必须是数组（${path}）`);
      if (!schema.enum.some((v) => deepEqual(data, v))) {
        errors.push({ path, keyword: "enum", message: `必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(" | ")} 之一` });
      }
    }

    if (typeof data === "string") {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        errors.push({ path, keyword: "minLength", message: `长度 ${data.length} < ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        errors.push({ path, keyword: "maxLength", message: `长度 ${data.length} > ${schema.maxLength}` });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(data)) {
        errors.push({ path, keyword: "pattern", message: `不匹配 ${schema.pattern}` });
      }
      if (schema.format !== undefined) {
        if (!KNOWN_FORMATS.has(schema.format)) throw new Error(`未实现的 format: ${schema.format}`);
        const re = schema.format === "date-time" ? DATE_TIME_RE : URI_RE;
        if (!re.test(data)) {
          errors.push({ path, keyword: "format", message: `不是合法的 ${schema.format}: ${data}` });
        }
      }
    }

    if (typeof data === "number") {
      if (schema.minimum !== undefined && data < schema.minimum) {
        errors.push({ path, keyword: "minimum", message: `${data} < ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        errors.push({ path, keyword: "maximum", message: `${data} > ${schema.maximum}` });
      }
      if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
        errors.push({ path, keyword: "exclusiveMinimum", message: `${data} <= ${schema.exclusiveMinimum}` });
      }
      if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
        errors.push({ path, keyword: "exclusiveMaximum", message: `${data} >= ${schema.exclusiveMaximum}` });
      }
    }

    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        errors.push({ path, keyword: "minItems", message: `元素 ${data.length} < ${schema.minItems}` });
      }
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        errors.push({ path, keyword: "maxItems", message: `元素 ${data.length} > ${schema.maxItems}` });
      }
      if (schema.uniqueItems === true) {
        for (let i = 0; i < data.length; i += 1) {
          for (let j = i + 1; j < data.length; j += 1) {
            if (deepEqual(data[i], data[j])) {
              errors.push({ path: `${path}/${i}`, keyword: "uniqueItems", message: `与 ${path}/${j} 重复` });
            }
          }
        }
      }
      if (schema.items !== undefined) {
        data.forEach((item, i) => check(schema.items, doc, item, `${path}/${i}`, errors, depth + 1));
      }
    }

    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      if (schema.required !== undefined) {
        for (const key of schema.required) {
          if (!(key in data)) errors.push({ path, keyword: "required", message: `缺必填字段 ${key}` });
        }
      }
      const props = schema.properties || {};
      for (const [key, value] of Object.entries(data)) {
        if (props[key] !== undefined) {
          check(props[key], doc, value, `${path}/${key}`, errors, depth + 1);
          continue;
        }
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}/${key}`, keyword: "additionalProperties", message: `不允许的字段 ${key}` });
        } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
          check(schema.additionalProperties, doc, value, `${path}/${key}`, errors, depth + 1);
        }
      }
    }

    for (const sub of schema.allOf || []) {
      check(sub, doc, data, path, errors, depth + 1);
    }
    if (schema.anyOf !== undefined) {
      // 失败时把「最接近成立」那个分支的具体错误带上：只报 anyOf 没法定位到字段。
      let best = null;
      let bestScore = Infinity;
      let passed = false;
      for (const sub of schema.anyOf) {
        const subErrors = [];
        check(sub, doc, data, path, subErrors, depth + 1);
        if (subErrors.length === 0) {
          passed = true;
          break;
        }
        // 「类型就不对」的分支信息量最低，同等错误数时优先展示更深的字段错误。
        const score = subErrors.length * 10 + subErrors.filter((e) => e.keyword === "type").length;
        if (score < bestScore) {
          bestScore = score;
          best = subErrors;
        }
      }
      if (!passed) {
        errors.push({ path, keyword: "anyOf", message: "没有任何一个 anyOf 分支成立" });
        for (const e of best.slice(0, 3)) errors.push(e);
      }
    }
    if (schema.oneOf !== undefined) {
      let passing = 0;
      for (const sub of schema.oneOf) {
        const subErrors = [];
        check(sub, doc, data, path, subErrors, depth + 1);
        if (subErrors.length === 0) passing += 1;
      }
      if (passing !== 1) {
        errors.push({ path, keyword: "oneOf", message: `恰好需要 1 个分支成立，实际 ${passing}` });
      }
    }
    if (schema.not !== undefined) {
      const subErrors = [];
      check(schema.not, doc, data, path, subErrors, depth + 1);
      if (subErrors.length === 0) {
        errors.push({ path, keyword: "not", message: "命中了 not 禁止的形状" });
      }
    }
    if (schema.if !== undefined) {
      const ifErrors = [];
      check(schema.if, doc, data, path, ifErrors, depth + 1);
      if (ifErrors.length === 0) {
        if (schema.then !== undefined) check(schema.then, doc, data, path, errors, depth + 1);
      } else if (schema.else !== undefined) {
        check(schema.else, doc, data, path, errors, depth + 1);
      }
    }
  }

  /**
   * @param {unknown} data
   * @param {string|object} target $id（可带 #fragment）或 schema 对象
   * @returns {{valid:boolean, errors:Array<{path,keyword,message}>}}
   */
  function validate(data, target) {
    let schema;
    let doc;
    if (typeof target === "string") {
      const resolved = resolveRef(target, undefined);
      schema = resolved.schema;
      doc = resolved.doc;
    } else {
      schema = target;
      doc = target;
    }
    const errors = [];
    check(schema, doc, data, "", errors);
    return { valid: errors.length === 0, errors };
  }

  return { validate, byId: [...byId.keys()] };
}

/**
 * schema 卫生检查 + 断言。
 * 规则：
 *  1. 每份 schema 有 $schema / $id / 非空 description
 *  2. 每个 properties / $defs 条目有非空 description
 *  3. 任何字符串里不许出现 TBD/TODO/FIXME/待定/未定
 *  4. 不许出现本校验器不认识的关键字（否则约束形同虚设）
 *  5. 声明 type 含 object 的节点必须显式写 additionalProperties（禁止静默收多余字段）
 *  6. 所有 $ref 可解析
 */
export function checkHygiene(docs) {
  const problems = [];
  const byId = new Map(docs.map((d) => [d.schema.$id, d.schema]));

  function walkStrings(node, path) {
    if (typeof node === "string") {
      for (const bad of FORBIDDEN_PLACEHOLDERS) {
        if (node.includes(bad)) problems.push(`${path}: 含占位词 ${bad}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walkStrings(v, `${path}/${i}`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}/${k}`);
    }
  }

  // mode="decl" 表示节点在声明字段（必须带 description / additionalProperties）；
  // mode="conditional" 表示节点是 if/then/else/allOf 之类的收窄叠加，只约束已有字段，
  // 不重复要求说明——否则每处 if 都要把上层字段的描述抄一遍。
  function walk(node, path, doc, mode = "decl") {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}/${i}`, doc, mode));
      return;
    }

    for (const key of Object.keys(node)) {
      if (!KNOWN_KEYWORDS.has(key)) problems.push(`${path}: 未知关键字 ${key}（校验器不会执行它）`);
    }

    if (node.$ref !== undefined) {
      const hashAt = node.$ref.indexOf("#");
      const idPart = hashAt === -1 ? node.$ref : node.$ref.slice(0, hashAt);
      const target = idPart === "" ? doc : byId.get(idPart);
      if (!target) problems.push(`${path}: $ref 的 $id 不存在 ${node.$ref}`);
    }

    if (node.format !== undefined && !KNOWN_FORMATS.has(node.format)) {
      problems.push(`${path}: 未实现的 format ${node.format}`);
    }

    const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
    for (const t of types) {
      if (!JSON_TYPES.has(t)) problems.push(`${path}: 未知 type ${t}`);
    }
    if (mode === "decl" && types.includes("object") && !("additionalProperties" in node)) {
      problems.push(`${path}: type 含 object 但没写 additionalProperties`);
    }

    if (node.properties) {
      for (const [name, sub] of Object.entries(node.properties)) {
        const subPath = `${path}/properties/${name}`;
        if (sub == null || typeof sub !== "object") {
          problems.push(`${subPath}: properties 条目必须是 schema 对象`);
          continue;
        }
        if (mode === "decl" && (typeof sub.description !== "string" || sub.description.trim() === "")) {
          problems.push(`${subPath}: 缺非空 description`);
        }
        walk(sub, subPath, doc, mode);
      }
    }

    if (node.$defs) {
      for (const [name, sub] of Object.entries(node.$defs)) {
        const subPath = `${path}/$defs/${name}`;
        if (mode === "decl" && (typeof sub.description !== "string" || sub.description.trim() === "")) {
          problems.push(`${subPath}: 缺非空 description`);
        }
        walk(sub, subPath, doc, mode);
      }
    }

    // items / additionalProperties 仍然声明数据形状，沿用当前 mode；
    // 逻辑组合关键字一律降级为 conditional。
    for (const key of ["items", "additionalProperties"]) {
      if (node[key] && typeof node[key] === "object") walk(node[key], `${path}/${key}`, doc, mode);
    }
    for (const key of ["not", "if", "then", "else"]) {
      if (node[key] && typeof node[key] === "object") walk(node[key], `${path}/${key}`, doc, "conditional");
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(node[key])) {
        node[key].forEach((v, i) => walk(v, `${path}/${key}/${i}`, doc, "conditional"));
      }
    }
  }

  for (const { name, schema } of docs) {
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      problems.push(`${name}: $schema 不是 draft 2020-12`);
    }
    if (typeof schema.$id !== "string" || schema.$id === "") problems.push(`${name}: 缺 $id`);
    if (typeof schema.description !== "string" || schema.description.trim() === "") {
      problems.push(`${name}: 缺非空 description`);
    }
    walkStrings(schema, name);
    walk(schema, name, schema);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 断言式入口：卫生检查不过直接抛，测试里用它可以当「故意注入违规必须报错」的靶子。
 */
export function assertHygiene(docs) {
  const result = checkHygiene(docs);
  if (!result.ok) {
    throw new Error(`schema 卫生检查失败:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return result;
}

/** 一次装载：读目录 → 构造校验器 → 断言卫生。测试和未来的 kernel 都用它。 */
export async function loadProtocol(dir) {
  const docs = await loadSchemaDocs(dir);
  assertHygiene(docs);
  const validator = createValidator(docs);
  return { docs, validator, validate: validator.validate, ids: validator.byId };
}
