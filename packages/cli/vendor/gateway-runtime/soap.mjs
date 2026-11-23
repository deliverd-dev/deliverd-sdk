// Drafting tools from a WSDL 1.1 description, for applications whose API is
// SOAP, and the SOAP envelope each call becomes.
//
// One tool per operation, off until approved, exactly like `openapi.mjs`.
// The XML schema of each operation's input becomes the tool's JSON input
// schema, so an agent sends plain JSON and the runtime writes the envelope.
// What the envelope needs (the SOAP version, SOAPAction, namespaces and the
// order of elements) is kept in the input schema under `x-deliverd-soap`, so
// the approval covers it, and agents never see it. The answer comes back as
// JSON; a SOAP fault is a failed call.
//
// Document/literal and RPC/literal, SOAP 1.1 and 1.2. Not SOAP encoding,
// attachments or WS-Security: put the application's credential in the tools
// file's `credential` as for a REST API.
//
// No dependencies. The XML reader below ignores DOCTYPEs and expands only the
// five predefined entities and character references, so a document cannot
// make it read a file or a URL.

export const SOAP_KEY = "x-deliverd-soap";
const MAX_DEPTH = 8;

// ── A small XML reader ─────────────────────────────────────────────────────

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]
  );

/** Parses XML into `{ name, local, ns, attrs, children, text }`, with namespaces resolved. */
export function parseXml(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const root = { name: "#document", local: "#document", ns: null, attrs: {}, children: [], text: "", scope: { xml: "http://www.w3.org/XML/1998/namespace" } };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decode(src.slice(i));
      break;
    }
    if (lt > i) top().text += decode(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top().text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src.startsWith("<!", lt)) {
      // DOCTYPE and declarations: skipped, internal subset included. Nothing in them is used.
      let depth = 0;
      let j = lt + 2;
      for (; j < src.length; j++) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        else if (src[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = src.slice(lt + 2, end).trim();
      if (stack.length > 1 && top().name === name) stack.pop();
      else throw new Error(`The XML closes ${name} where it should not.`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(src.slice(lt, lt + 100_000));
      if (!m) throw new Error("The XML has a tag that cannot be read.");
      const attrs = {};
      for (const a of m[2].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const scope = { ...top().scope };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "xmlns") scope[""] = v;
        else if (k.startsWith("xmlns:")) scope[k.slice(6)] = v;
      }
      const [prefix, local] = m[1].includes(":") ? m[1].split(":", 2) : ["", m[1]];
      const node = { name: m[1], local, ns: scope[prefix] ?? null, attrs, children: [], text: "", scope };
      top().children.push(node);
      if (!m[3]) stack.push(node);
      if (stack.length > 200) throw new Error("The XML is nested too deeply.");
      i = lt + m[0].length;
    }
  }
  if (stack.length > 1) throw new Error(`The XML ends before ${top().name} is closed.`);
  return root;
}

const kids = (node, local) => (node?.children ?? []).filter((c) => !local || c.local === local);
const kid = (node, local) => kids(node, local)[0] ?? null;
/** A QName attribute (`tns:Claim`) as `{ ns, local }`, read in the scope it was written in. */
const qname = (node, value) => {
  if (!value) return null;
  const [p, l] = value.includes(":") ? value.split(":", 2) : ["", value];
  return { ns: node.scope[p] ?? (p ? null : node.scope[""] ?? null), local: l };
};

// ── WSDL to tools ──────────────────────────────────────────────────────────

const XSD = "http://www.w3.org/2001/XMLSchema";
const SOAP11 = "http://schemas.xmlsoap.org/wsdl/soap/";
const SOAP12 = "http://schemas.xmlsoap.org/wsdl/soap12/";
const ENVELOPE = { "1.1": "http://schemas.xmlsoap.org/soap/envelope/", "1.2": "http://www.w3.org/2003/05/soap-envelope" };

const SIMPLE = {
  string: { type: "string" },
  normalizedString: { type: "string" },
  token: { type: "string" },
  anyURI: { type: "string" },
  int: { type: "integer" },
  integer: { type: "integer" },
  short: { type: "integer" },
  byte: { type: "integer" },
  long: { type: ["integer", "string"] },
  unsignedInt: { type: "integer", minimum: 0 },
  unsignedShort: { type: "integer", minimum: 0 },
  unsignedLong: { type: ["integer", "string"] },
  nonNegativeInteger: { type: "integer", minimum: 0 },
  positiveInteger: { type: "integer", minimum: 1 },
  decimal: { type: "number" },
  double: { type: "number" },
  float: { type: "number" },
  boolean: { type: "boolean" },
  dateTime: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  time: { type: "string" },
  duration: { type: "string" },
  base64Binary: { type: "string", contentEncoding: "base64" },
  guid: { type: "string", format: "uuid" },
  char: { type: "integer" },
};

const READ = /^(get|find|list|search|read|query|lookup|check|fetch|retrieve|view|count|is|has|describe|validate|calculate|quote|ping|echo)/i;

function indexSchemas(defs) {
  const elements = new Map();
  const types = new Map();
  const qualified = new Map();
  const walk = (schema) => {
    const tns = schema.attrs.targetNamespace ?? null;
    qualified.set(tns, schema.attrs.elementFormDefault === "qualified");
    for (const c of schema.children) {
      if (c.ns !== XSD) continue;
      const key = `${tns}|${c.attrs.name}`;
      if (c.local === "element" && c.attrs.name) elements.set(key, { node: c, ns: tns });
      if ((c.local === "complexType" || c.local === "simpleType") && c.attrs.name) types.set(key, { node: c, ns: tns });
    }
  };
  for (const t of kids(defs, "types")) for (const s of kids(t, "schema")) walk(s);
  return { elements, types, qualified };
}

/**
 * An XSD element or type as JSON Schema, and the order its children go in
 * the envelope. Recursion stops at `MAX_DEPTH`: deeper parts become free text.
 */
function convert(index, node, ns, depth = 0) {
  if (depth > MAX_DEPTH) return { schema: { type: "string" }, fields: null };
  const typeRef = qname(node, node.attrs.type);
  if (typeRef) {
    if (typeRef.ns === XSD || typeRef.ns === "http://microsoft.com/wsdl/types/") return { schema: { ...(SIMPLE[typeRef.local] ?? { type: "string" }) }, fields: null };
    const t = index.types.get(`${typeRef.ns}|${typeRef.local}`);
    if (!t) return { schema: { type: "string" }, fields: null };
    return convert(index, t.node, t.ns, depth + 1);
  }
  const simple = node.local === "simpleType" ? node : kid(node, "simpleType");
  if (simple) {
    const r = kid(simple, "restriction");
    const base = r ? qname(r, r.attrs.base) : null;
    const schema = { ...(base?.ns === XSD ? SIMPLE[base.local] ?? { type: "string" } : { type: "string" }) };
    const values = kids(r, "enumeration").map((e) => e.attrs.value);
    if (values.length) schema.enum = values;
    const max = kid(r, "maxLength");
    if (max) schema.maxLength = Number(max.attrs.value);
    return { schema, fields: null };
  }
  const complex = node.local === "complexType" ? node : kid(node, "complexType");
  if (!complex) return { schema: { type: "string" }, fields: null };
  const props = {};
  const required = [];
  const fields = [];
  const group = kid(complex, "sequence") ?? kid(complex, "all") ?? kid(complex, "choice") ?? kid(kid(kid(complex, "complexContent"), "extension"), "sequence");
  const isChoice = group?.local === "choice";
  for (const el of kids(group, "element")) {
    let target = el;
    let elNs = index.qualified.get(ns) ? ns : null;
    if (el.attrs.ref) {
      const ref = qname(el, el.attrs.ref);
      const found = index.elements.get(`${ref.ns}|${ref.local}`);
      if (!found) continue;
      target = found.node;
      elNs = ref.ns;
    }
    const name = target.attrs.name;
    if (!name) continue;
    const inner = convert(index, target, ns, depth + 1);
    const many = el.attrs.maxOccurs === "unbounded" || Number(el.attrs.maxOccurs) > 1;
    const nillable = target.attrs.nillable === "true";
    let schema = inner.schema;
    if (nillable && typeof schema.type === "string") schema = { ...schema, type: [schema.type, "null"] };
    props[name] = many ? { type: "array", items: schema } : schema;
    if (!isChoice && el.attrs.minOccurs !== "0") required.push(name);
    fields.push({ name, ns: elNs, many, ...(inner.fields ? { fields: inner.fields } : {}) });
  }
  const schema = { type: "object", properties: props, additionalProperties: false };
  if (required.length) schema.required = required;
  return { schema, fields };
}

const toolNameOf = (op) =>
  op
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .replace(/^(\d)/, "op_$1")
    .slice(0, 64) || "operation";

/**
 * One tool per operation of the WSDL's first SOAP port (SOAP 1.1 before 1.2),
 * each off until approved. `notes` says what was left out and why.
 */
export function draftSoapTools(wsdlText) {
  const doc = parseXml(wsdlText);
  const defs = kid(doc, "definitions");
  if (!defs) throw new Error("This is not a WSDL 1.1 description: it has no definitions element.");
  const notes = [];
  const index = indexSchemas(defs);
  const messages = new Map(kids(defs, "message").map((m) => [m.attrs.name, m]));
  const portTypes = new Map(kids(defs, "portType").map((p) => [p.attrs.name, p]));
  const bindings = new Map(kids(defs, "binding").map((b) => [b.attrs.name, b]));

  const ports = kids(defs, "service").flatMap((s) => kids(s, "port"));
  const soapPort = (version) => ports.find((p) => kids(p, "address").some((a) => a.ns === (version === "1.1" ? SOAP11 : SOAP12)));
  const version = soapPort("1.1") ? "1.1" : soapPort("1.2") ? "1.2" : null;
  if (!version) throw new Error("The WSDL has no SOAP port (soap:address).");
  const port = soapPort(version);
  const address = kids(port, "address")[0].attrs.location;
  let path = "/";
  try {
    const u = new URL(address);
    path = u.pathname + u.search;
  } catch {
    notes.push(`The address ${address} is not a full URL; calls go to / on the base URL.`);
  }
  const binding = bindings.get(qname(port, port.attrs.binding)?.local);
  if (!binding) throw new Error("The SOAP port's binding is not in the WSDL.");
  const soapBinding = kids(binding, "binding").find((b) => b.ns === SOAP11 || b.ns === SOAP12);
  const defaultStyle = soapBinding?.attrs.style ?? "document";
  const portType = portTypes.get(qname(binding, binding.attrs.type)?.local);
  if (!portType) throw new Error("The binding's port type is not in the WSDL.");
  const tns = defs.attrs.targetNamespace ?? null;

  const tools = [];
  const names = new Set();
  for (const bop of kids(binding, "operation")) {
    const opName = bop.attrs.name;
    const pop = kids(portType, "operation").find((o) => o.attrs.name === opName);
    if (!pop) continue;
    const soapOp = kids(bop, "operation").find((o) => o.ns === SOAP11 || o.ns === SOAP12);
    const style = soapOp?.attrs.style ?? defaultStyle;
    const body = kids(kid(bop, "input"), "body")[0];
    if (body?.attrs.use === "encoded") {
      notes.push(`${opName}: uses SOAP encoding, which the runtime does not write. Left out.`);
      continue;
    }
    const msg = messages.get(qname(kid(pop, "input"), kid(pop, "input")?.attrs.message)?.local);
    const parts = kids(msg, "part");
    let wrapper;
    let converted;
    if (style === "rpc") {
      const props = {};
      const required = [];
      const fields = [];
      for (const part of parts) {
        const c = part.attrs.element ? convertElementRef(index, part) : convert(index, part, null);
        props[part.attrs.name] = c.schema;
        required.push(part.attrs.name);
        fields.push({ name: part.attrs.name, ns: null, many: false, ...(c.fields ? { fields: c.fields } : {}) });
      }
      converted = { schema: { type: "object", properties: props, additionalProperties: false, ...(required.length ? { required } : {}) }, fields };
      wrapper = { name: opName, ns: body?.attrs.namespace ?? tns };
    } else {
      const part = parts.find((p) => p.attrs.element);
      if (!part) {
        converted = { schema: { type: "object", properties: {}, additionalProperties: false }, fields: [] };
        wrapper = null;
      } else {
        const ref = qname(part, part.attrs.element);
        const el = index.elements.get(`${ref.ns}|${ref.local}`);
        if (!el) {
          notes.push(`${opName}: its input element ${ref.local} is not in the WSDL's schema (an import?). Left out.`);
          continue;
        }
        converted = convert(index, el.node, ref.ns);
        if (converted.schema.type !== "object") converted = { schema: { type: "object", properties: { value: converted.schema }, required: ["value"], additionalProperties: false }, fields: null };
        wrapper = { name: ref.local, ns: ref.ns };
      }
    }
    let name = toolNameOf(opName);
    for (let n = 2; names.has(name); n++) name = `${toolNameOf(opName).slice(0, 60)}_${n}`;
    names.add(name);
    const doc = (kid(pop, "documentation")?.text ?? "").trim().replace(/\s+/g, " ");
    tools.push({
      name,
      description: (doc || `${opName}, a SOAP operation of ${portType.attrs.name}.`).slice(0, 2000),
      method: "POST",
      path,
      access: READ.test(opName) ? "read" : "write",
      inputSchema: {
        ...converted.schema,
        [SOAP_KEY]: { version, soapAction: soapOp?.attrs.soapAction ?? "", style, wrapper, fields: converted.fields },
      },
      in: {},
      source: { kind: "wsdl", operation: `soap:${opName}` },
    });
  }
  if (!tools.length) notes.push("No operation could be drafted.");
  return { tools, notes, title: kid(defs, "service")?.attrs.name ?? defs.attrs.name ?? null };
}

function convertElementRef(index, part) {
  const ref = qname(part, part.attrs.element);
  const el = index.elements.get(`${ref.ns}|${ref.local}`);
  return el ? convert(index, el.node, ref.ns) : { schema: { type: "string" }, fields: null };
}

// ── Envelopes ──────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const scalar = (v) => (v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

function writeFields(fields, value, prefixes, out) {
  if (!fields) {
    // A free value (a deep or unknown type): written as text.
    return out.push(esc(scalar(value) ?? ""));
  }
  for (const f of fields) {
    const v = value?.[f.name];
    if (v === undefined) continue;
    const tag = f.ns ? `${prefixes(f.ns)}:${f.name}` : f.name;
    for (const item of f.many && Array.isArray(v) ? v : [v]) {
      if (item === null) {
        out.push(`<${tag} xsi:nil="true"/>`);
        continue;
      }
      out.push(`<${tag}>`);
      if (f.fields) writeFields(f.fields, item, prefixes, out);
      else out.push(esc(scalar(item)));
      out.push(`</${tag}>`);
    }
  }
}

/** The SOAP request for a tool and its checked arguments. */
export function buildSoapRequest(config, tool, args) {
  const spec = tool.inputSchema?.[SOAP_KEY];
  if (!spec) throw Object.assign(new Error(`${tool.name} is not a SOAP operation`), { code: "invalid" });
  const namespaces = new Map();
  const prefixes = (ns) => {
    if (!namespaces.has(ns)) namespaces.set(ns, `n${namespaces.size}`);
    return namespaces.get(ns);
  };
  const out = [];
  if (spec.wrapper) {
    const p = spec.wrapper.ns ? prefixes(spec.wrapper.ns) : null;
    const tag = p ? `${p}:${spec.wrapper.name}` : spec.wrapper.name;
    out.push(`<${tag}>`);
    if (spec.fields === null) out.push(esc(scalar(args?.value) ?? ""));
    else writeFields(spec.fields, args ?? {}, prefixes, out);
    out.push(`</${tag}>`);
  }
  const ns = [...namespaces].map(([uri, p]) => ` xmlns:${p}="${esc(uri)}"`).join("");
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${ENVELOPE[spec.version]}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${ns}><soap:Body>${out.join("")}</soap:Body></soap:Envelope>`;
  const url = `${config.baseUrl}${tool.path === "/" ? "" : tool.path}`;
  if (!url.startsWith(`${config.baseUrl}/`) && url !== config.baseUrl) throw Object.assign(new Error("the path leaves the application's address"), { code: "invalid" });
  const headers =
    spec.version === "1.2"
      ? { "content-type": `application/soap+xml; charset=utf-8${spec.soapAction ? `; action="${spec.soapAction.replace(/"/g, "")}"` : ""}` }
      : { "content-type": "text/xml; charset=utf-8", soapaction: `"${String(spec.soapAction ?? "").replace(/"/g, "")}"` };
  return { method: "POST", url, headers, body };
}

/** An element as JSON: text for a leaf, an object for children, arrays where a name repeats, null for xsi:nil. */
export function toJson(node) {
  if (Object.entries(node.attrs).some(([k, v]) => k.endsWith(":nil") && v === "true")) return null;
  if (!node.children.length) return node.text.trim();
  const out = {};
  const many = new Set();
  for (const c of node.children) {
    const v = toJson(c);
    if (!(c.local in out)) out[c.local] = v;
    else {
      if (!many.has(c.local)) {
        out[c.local] = [out[c.local]];
        many.add(c.local);
      }
      out[c.local].push(v);
    }
  }
  return out;
}

/**
 * The application's SOAP answer as JSON text, or the fault in words. An
 * answer that is not SOAP is passed through as it came.
 */
export function readSoapResponse(text) {
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    return { text, fault: null };
  }
  const env = kid(doc, "Envelope");
  const body = kid(env, "Body");
  if (!body) return { text, fault: null };
  const fault = kid(body, "Fault");
  if (fault) {
    const reason = (kid(fault, "faultstring")?.text ?? kid(kid(fault, "Reason"), "Text")?.text ?? "").trim();
    const code = (kid(fault, "faultcode")?.text ?? kid(kid(fault, "Code"), "Value")?.text ?? "").trim();
    return { text: JSON.stringify({ fault: { code, reason, detail: kid(fault, "detail") ?? kid(fault, "Detail") ? toJson(kid(fault, "detail") ?? kid(fault, "Detail")) : null } }, null, 2), fault: reason || code || "a SOAP fault" };
  }
  const first = body.children[0];
  return { text: JSON.stringify(first ? { [first.local]: toJson(first) } : {}, null, 2), fault: null };
}
