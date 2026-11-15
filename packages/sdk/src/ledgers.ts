/**
 * Accounting ledgers: what an agent's call to Xero or QuickBooks Online is,
 * in the words a finance approver and a policy rule use.
 *
 * Agents now write to the books. Xero's remote MCP server and its open-source
 * one (`@xeroapi/xero-mcp-server`), Intuit's open-source QuickBooks server
 * (`intuit/quickbooks-online-mcp-server`), and plain calls to both REST APIs
 * can create payments, post journals and change a supplier's bank details.
 * None of them asks anybody first. This module turns any of those calls into
 * one of a handful of finance actions (approve a bill, record a payment,
 * change a supplier's bank details...) with the amount, currency and
 * counterparty pulled out, so a rule can say "over 5,000 needs two people"
 * and mean it, whichever door the agent came through.
 *
 * It also reads what the ledgers' webhooks say, and turns a record the ledger
 * sends back into a change worth watching, so a bill authorised or a bank
 * account swapped with no yes behind it shows on the Enforcement panel.
 *
 * Three lines are held throughout:
 *
 * - **Pure, no imports.** This file is copied verbatim into
 *   `packages/sdk/src/ledgers.ts`, and a test fails when they differ, so an
 *   agent classifies its own calls the same way the hosted gateway does. The
 *   local MCP hook carries a JavaScript copy of the tool map
 *   (`integrations/agent-hooks/deliverd/ledgers.mjs`), held to the same cases.
 * - **Unknown writes are still asked about.** A tool or route this file does
 *   not recognise but that changes something is `finance.ledger_write`, never
 *   waved through. Reads are never asked about.
 * - **Bank details never travel whole.** Only masked forms (`•••• 1234`) are
 *   put in front of an approver or stored.
 */

export const LEDGERS = ["xero", "quickbooks"] as const;
export type Ledger = (typeof LEDGERS)[number];

export const LEDGER_LABEL: Record<Ledger, string> = { xero: "Xero", quickbooks: "QuickBooks Online" };

/** The finance actions, by the id policy keys on. `finance.*` in a rule catches every one. */
export const FINANCE_ACTIONS = {
  approveBill: "finance.approve_bill",
  recordPayment: "finance.record_payment",
  postJournal: "finance.post_journal",
  bankTransaction: "finance.bank_transaction",
  supplierBankDetails: "finance.change_supplier_bank_details",
  sendInvoice: "finance.send_invoice",
  creditNote: "finance.issue_credit_note",
  payroll: "finance.approve_payroll",
  voidRecord: "finance.void_record",
  ledgerWrite: "finance.ledger_write",
} as const;
export type FinanceActionId = (typeof FINANCE_ACTIONS)[keyof typeof FINANCE_ACTIONS];

export const FINANCE_ACTION_IDS: readonly FinanceActionId[] = Object.values(FINANCE_ACTIONS);

/**
 * What every finance gate carries. One shape for all of them, so a rule
 * written for one (`amount gte 5000`, `newCounterparty eq true`) reads the
 * same on the others. Flat and primitive, because the action schema subset is.
 */
export interface LedgerInput {
  ledger: Ledger;
  /** What was called: `create-payment`, `POST /Payments`. */
  tool: string;
  recordType?: string;
  amount?: number;
  currency?: string;
  counterparty?: string;
  reference?: string;
  recordId?: string;
  status?: string;
  /** The ledger has no earlier bill or payment for this counterparty. Set only when Deliverd could look. */
  newCounterparty?: boolean;
  /** The record is dated inside a period the ledger has locked. Set only when Deliverd could look. */
  closedPeriod?: boolean;
  /** The call changes where a supplier is paid. */
  bankDetailsChanged?: boolean;
  previousBankDetails?: string;
  newBankDetails?: string;
  /** What the approver should know, one finding a line: duplicates, recent bills. */
  checks?: string;
}

export interface LedgerCall {
  actionId: FinanceActionId;
  input: LedgerInput;
  /** One line for the approval card and the agent: "Record a payment of 1,200.00 GBP to Acme". */
  summary: string;
}

/* ─── reading values out of whatever shape the call came in ─────────────── */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
};
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Keys compared without case, underscores or dashes: `TotalAmt`, `total_amt`, `totalAmt` are one key. */
const norm = (k: string): string => k.toLowerCase().replace(/[_\-\s]/g, "");

function field(o: Rec, ...names: string[]): unknown {
  const want = new Set(names.map(norm));
  for (const [k, v] of Object.entries(o)) if (want.has(norm(k))) return v;
  return undefined;
}

/**
 * The record a call is about. Xero wraps writes as `{ Invoices: [ … ] }`, the
 * QuickBooks MCP server takes `{ bill: { … } }`, others pass the fields flat.
 */
const LINE_KEYS = new Set(["lineitems", "line", "lines", "journallines", "manualjournallines"]);

export function primaryRecord(args: unknown): Rec {
  if (!isRec(args)) return {};
  const keys = Object.keys(args);
  if (keys.length <= 2) {
    for (const k of keys) {
      const v = args[k];
      if (Array.isArray(v) && v.length && isRec(v[0]) && !LINE_KEYS.has(norm(k))) return v[0];
      if (isRec(v) && keys.length === 1 && !/^(contact|vendor|customer|invoice|account)ref?$/i.test(k)) return v;
    }
  }
  return args;
}

function nameOf(v: unknown): string | undefined {
  if (isRec(v)) return str(field(v, "name", "displayName", "contactName")) ?? str(field(v, "value", "contactId", "id"));
  return str(v);
}

function lineTotal(lines: unknown): number | undefined {
  if (!Array.isArray(lines) || !lines.length) return undefined;
  let total = 0;
  let any = false;
  for (const l of lines) {
    if (!isRec(l)) continue;
    const amount = num(field(l, "lineAmount", "amount"));
    if (amount !== undefined) {
      total += amount;
      any = true;
      continue;
    }
    const qty = num(field(l, "quantity", "qty")) ?? 1;
    const unit = num(field(l, "unitAmount", "unitPrice"));
    if (unit !== undefined) {
      total += qty * unit;
      any = true;
    }
  }
  return any ? round2(total) : undefined;
}

/** A journal's size: the sum of its debits (its positive lines, or lines marked Debit). */
function journalTotal(lines: unknown): number | undefined {
  if (!Array.isArray(lines) || !lines.length) return undefined;
  let debit = 0;
  let any = false;
  for (const l of lines) {
    if (!isRec(l)) continue;
    const detail = field(l, "journalEntryLineDetail");
    const posting = isRec(detail) ? str(field(detail, "postingType")) : undefined;
    const amount = num(field(l, "lineAmount", "amount"));
    if (amount === undefined) continue;
    any = true;
    if (posting ? posting.toLowerCase() === "debit" : amount > 0) debit += Math.abs(amount);
  }
  return any ? round2(debit) : undefined;
}

export function amountOf(record: Rec): number | undefined {
  const direct = num(field(record, "total", "totalAmt", "amount", "totalAmount"));
  if (direct !== undefined) return round2(Math.abs(direct));
  const journal = journalTotal(field(record, "journalLines", "manualJournalLines"));
  if (journal !== undefined) return journal;
  const lines = field(record, "lineItems", "line", "lines");
  if (Array.isArray(lines) && lines.some((l) => isRec(l) && isRec(field(l, "journalEntryLineDetail")))) return journalTotal(lines);
  return lineTotal(lines);
}

export function currencyOf(record: Rec): string | undefined {
  const c = field(record, "currencyCode", "currency", "currencyRef");
  const code = isRec(c) ? str(field(c, "value")) : str(c);
  return code && /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : undefined;
}

/**
 * Who a record is with: a name wherever one is given, and an id only when no
 * name is. `self` is for a contact or vendor record, which names itself.
 */
export function counterpartyOf(record: Rec, self = false): string | undefined {
  const refs = ["contact", "vendorRef", "customerRef", "entityRef", "payeeRef", "employeeRef"];
  for (const key of refs) {
    const v = field(record, key);
    if (isRec(v)) {
      const n = str(field(v, "name", "displayName", "contactName"));
      if (n) return n;
    }
  }
  const named = str(field(record, "contactName", "vendorName", "customerName", "payeeName", "employeeName"));
  if (named) return named;
  const invoice = field(record, "invoice");
  if (isRec(invoice)) {
    const n = counterpartyOf(invoice);
    if (n) return n;
  }
  if (self) {
    const n = selfName(record);
    if (n) return n;
  }
  for (const key of refs) {
    const v = field(record, key);
    const id = isRec(v) ? str(field(v, "value", "contactId", "id")) : str(v);
    if (id) return id;
  }
  return str(field(record, "contactId", "vendorId", "customerId", "employeeId"));
}

/** A contact, vendor or employee record names itself. */
function selfName(record: Rec): string | undefined {
  return str(field(record, "name", "displayName", "companyName", "fullName"));
}

/** `YYYY-MM-DD` from an ISO date, a QuickBooks `TxnDate`, or Xero's `/Date(1731628800000+0000)/`. */
export function isoDay(v: unknown): string | undefined {
  const s = str(v, 60);
  if (!s) return undefined;
  const ms = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

export function dateOf(record: Rec): string | undefined {
  return isoDay(field(record, "dateString", "txnDate", "date"));
}

function referenceOf(record: Rec): string | undefined {
  return str(field(record, "reference", "invoiceNumber", "docNumber", "billNumber", "narration", "privateNote"), 120);
}

function recordIdOf(record: Rec): string | undefined {
  return str(field(record, "invoiceId", "billId", "paymentId", "bankTransactionId", "manualJournalId", "contactId", "creditNoteId", "timesheetId", "id"), 100);
}

const BANK_KEYS = [
  "bankAccountDetails",
  "batchPayments",
  "bankAccountNumber",
  "bankAccountName",
  "sortCode",
  "iban",
  "bsb",
  "routingNumber",
  "vendorPaymentBankDetail",
  "acctNum",
  "bankBranchIdentifier",
];

/** The bank details a call sets, flattened to one string, or undefined when it sets none. */
export function bankDetailsIn(record: Rec): string | undefined {
  const parts: string[] = [];
  const walk = (o: Rec, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      const n = norm(k);
      if (BANK_KEYS.some((b) => norm(b) === n)) {
        if (isRec(v)) walk(v, depth + 1);
        else {
          const s = str(v, 120);
          if (s) parts.push(s);
        }
      } else if (depth > 0 && isRec(v)) walk(v, depth + 1);
      else if (depth > 0) {
        const s = str(v, 120);
        if (s && /number|account|sort|bsb|iban|routing|branch/i.test(k)) parts.push(s);
      }
    }
  };
  walk(record, 0);
  return parts.length ? parts.join(" ") : undefined;
}

/** `•••• 1234`: enough for a person to recognise an account, not enough to pay into it. */
export function maskAccount(value: string | undefined | null): string {
  const digits = (value ?? "").replace(/[^0-9A-Za-z]/g, "");
  if (!digits) return "none on file";
  return `•••• ${digits.slice(-4)}`;
}

/* ─── tools: MCP servers and SDK tool calls ─────────────────────────────── */

/** `xero__create-payment`, `mcp__qbo__create_bill`, `create-payment` → `create_payment`. */
export function toolKey(tool: string): string {
  const bare = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return bare.toLowerCase().replace(/[-\s.]/g, "_");
}

const READ_VERBS = /^(list|get|search|read|find|query|fetch|report|retrieve|download|show|describe|count|whoami|lookup)(_|$)/;
const WRITE_VERBS = /^(create|update|delete|remove|void|approve|revert|add|send|email|post|pay|authori[sz]e|submit|apply|allocate|reconcile|write|set|upsert|import|batch|archive|refund|transfer)(_|$)/;

const label = (actionId: FinanceActionId): string =>
  ({
    "finance.approve_bill": "Approve a bill for payment",
    "finance.record_payment": "Record a payment",
    "finance.post_journal": "Post a journal",
    "finance.bank_transaction": "Post a bank transaction",
    "finance.change_supplier_bank_details": "Change a supplier's bank details",
    "finance.send_invoice": "Issue or send an invoice",
    "finance.issue_credit_note": "Issue a credit note or refund",
    "finance.approve_payroll": "Approve payroll",
    "finance.void_record": "Void or delete a ledger record",
    "finance.ledger_write": "Change the ledger",
  })[actionId];

export function financeActionLabel(actionId: string): string {
  return (FINANCE_ACTION_IDS as readonly string[]).includes(actionId) ? label(actionId as FinanceActionId) : actionId;
}

function money(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return "";
  const n = amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${n} ${currency}` : n;
}

export function summarise(call: { actionId: FinanceActionId; input: LedgerInput }): string {
  const { input } = call;
  const m = money(input.amount, input.currency);
  const who = input.counterparty;
  const base = label(call.actionId);
  const parts = [base];
  if (m) parts.push(`of ${m}`);
  if (who) parts.push(call.actionId === FINANCE_ACTIONS.supplierBankDetails ? `for ${who}` : `${call.actionId === FINANCE_ACTIONS.sendInvoice || call.actionId === FINANCE_ACTIONS.creditNote ? "to" : "for"} ${who}`);
  parts.push(`in ${LEDGER_LABEL[input.ledger]}`);
  return parts.join(" ");
}

function build(ledger: Ledger, tool: string, actionId: FinanceActionId, record: Rec, extra: Partial<LedgerInput> = {}): LedgerCall {
  const input: LedgerInput = { ledger, tool: tool.slice(0, 200) };
  const amount = amountOf(record);
  if (amount !== undefined) input.amount = amount;
  const currency = currencyOf(record);
  if (currency) input.currency = currency;
  const counterparty = counterpartyOf(record, /contact|vendor|supplier|employee/.test(extra.recordType ?? ""));
  if (counterparty) input.counterparty = counterparty;
  const reference = referenceOf(record);
  if (reference) input.reference = reference;
  const id = recordIdOf(record);
  if (id) input.recordId = id;
  const status = str(field(record, "status"), 40);
  if (status) input.status = status.toUpperCase();
  Object.assign(input, extra);
  if (actionId === FINANCE_ACTIONS.supplierBankDetails) {
    input.bankDetailsChanged = true;
    const next = bankDetailsIn(record);
    if (next) input.newBankDetails = maskAccount(next);
  }
  return { actionId, input, summary: summarise({ actionId, input }) };
}

/** Which family a tool's noun belongs to, after the verb. */
function nounOf(key: string): string {
  return key.replace(WRITE_VERBS, "").replace(/^_/, "");
}

/**
 * One MCP tool call (or an SDK tool call with the same name), as a finance
 * action. Null for a read: listing invoices or running a report asks nobody.
 */
export function classifyLedgerTool(ledger: Ledger, tool: string, args: unknown): LedgerCall | null {
  const key = toolKey(tool);
  if (READ_VERBS.test(key)) return null;
  const record = primaryRecord(args);
  const verb = key.split("_")[0] ?? "";
  const noun = nounOf(key);
  const status = (str(field(record, "status")) ?? "").toUpperCase();
  const type = (str(field(record, "type")) ?? "").toUpperCase();

  if (/^(delete|remove|void|archive)$/.test(verb) || status === "VOIDED" || status === "DELETED") {
    if (noun.includes("timesheet") && verb === "delete") return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record);
    return build(ledger, tool, FINANCE_ACTIONS.voidRecord, record, { recordType: noun || undefined });
  }
  if (/payroll|payrun|pay_run|timesheet/.test(noun)) {
    if (/^(approve|revert|post|submit)$/.test(verb) || /payrun|pay_run/.test(noun)) return build(ledger, tool, FINANCE_ACTIONS.payroll, record, { recordType: "payroll" });
    return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record, { recordType: "payroll" });
  }
  if (/(^|_)(contact|vendor|supplier|employee)s?$/.test(noun)) {
    if (bankDetailsIn(record)) return build(ledger, tool, FINANCE_ACTIONS.supplierBankDetails, record, { recordType: noun.includes("vendor") || noun.includes("supplier") ? "vendor" : "contact" });
    return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record, { recordType: noun });
  }
  if (/payment/.test(noun) || verb === "pay") return build(ledger, tool, FINANCE_ACTIONS.recordPayment, record, { recordType: noun || "payment" });
  if (/journal/.test(noun)) {
    // A Xero manual journal can be saved as a draft; QuickBooks journals post when saved.
    const posted = ledger === "quickbooks" || status === "POSTED" || verb === "post";
    return build(ledger, tool, posted ? FINANCE_ACTIONS.postJournal : FINANCE_ACTIONS.ledgerWrite, record, { recordType: "journal" });
  }
  if (/bank_?transaction|bank_?transfer|purchase|expense|deposit|transfer|spend|receive_money/.test(noun)) return build(ledger, tool, FINANCE_ACTIONS.bankTransaction, record, { recordType: noun });
  if (/credit_?note|credit_?memo|refund|vendor_?credit/.test(noun)) return build(ledger, tool, FINANCE_ACTIONS.creditNote, record, { recordType: noun });
  if (/^(send|email)$/.test(verb) || /(^|_)send$|email$/.test(noun)) return build(ledger, tool, FINANCE_ACTIONS.sendInvoice, record, { recordType: "invoice" });
  if (/bill/.test(noun)) {
    // A QuickBooks bill is payable as soon as it is saved: entering one is approving it.
    return build(ledger, tool, FINANCE_ACTIONS.approveBill, record, { recordType: "bill" });
  }
  if (/invoice/.test(noun)) {
    if (type === "ACCPAY") return build(ledger, tool, status === "AUTHORISED" || verb === "approve" || verb === "authorise" ? FINANCE_ACTIONS.approveBill : FINANCE_ACTIONS.ledgerWrite, record, { recordType: "bill" });
    if (status === "AUTHORISED" || verb === "approve" || verb === "authorise") return build(ledger, tool, FINANCE_ACTIONS.sendInvoice, record, { recordType: "invoice" });
    return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record, { recordType: "invoice" });
  }
  if (WRITE_VERBS.test(key)) return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record, { recordType: noun || undefined });
  return null;
}

/* ─── REST: the ledger HTTP gateway ─────────────────────────────────────── */

/** The JSON body as a record, or {} when it is not JSON. */
function parseBody(body: string | null | undefined): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * One REST request to a ledger, as a finance action. `path` is relative to
 * the ledger's API root: `/api.xro/2.0/Invoices/…` for Xero, `/bill?…` for
 * QuickBooks (whose root already names the company). Null for a read.
 */
export function classifyLedgerRequest(ledger: Ledger, method: string, path: string, body?: string | null): LedgerCall | null {
  const m = method.toUpperCase();
  const [rawPath = "", query = ""] = path.split("?");
  const segments = rawPath.split("/").filter(Boolean).map((s) => s.toLowerCase());
  const tool = `${m} ${rawPath}`.slice(0, 200);
  if (["GET", "HEAD", "OPTIONS"].includes(m)) return null;
  const parsed = parseBody(body);
  const record = primaryRecord(parsed);

  if (ledger === "quickbooks") {
    const entity = segments[0] ?? "";
    if (entity === "query" || entity === "reports" || entity === "cdc" || entity === "batch") {
      if (entity === "batch") return build(ledger, tool, FINANCE_ACTIONS.ledgerWrite, record, { recordType: "batch" });
      return null;
    }
    const operation = /(?:^|&)operation=([a-z]+)/i.exec(query)?.[1]?.toLowerCase();
    if (m === "DELETE" || operation === "delete" || operation === "void") return build(ledger, tool, FINANCE_ACTIONS.voidRecord, record, { recordType: entity });
    if (segments.includes("send")) return build(ledger, tool, FINANCE_ACTIONS.sendInvoice, record, { recordType: entity });
    const verb = field(record, "id") !== undefined ? "update" : "create";
    const call = classifyLedgerTool(ledger, `${verb}_${entity}`, record);
    return call && { ...call, input: { ...call.input, tool } };
  }

  // Xero: /api.xro/2.0/<Collection>[/<id>[/<sub>]], /payroll.xro/2.0/…
  const at = segments.findIndex((s) => /\.xro$/.test(s));
  const rest = at === -1 ? segments : segments.slice(at + 2);
  const collection = rest[0] ?? "";
  const sub = rest[2] ?? rest[1] ?? "";
  const payroll = segments.some((s) => s.startsWith("payroll"));
  const idIn = rest[1] && !/^(email|history|attachments|approve|revert|allocations)$/.test(rest[1]) ? rest[1] : undefined;
  const withId = (call: LedgerCall | null): LedgerCall | null => {
    if (!call) return call;
    const input = { ...call.input, tool };
    if (idIn && !input.recordId) input.recordId = idIn;
    return { ...call, input, summary: summarise({ actionId: call.actionId, input }) };
  };
  if (/history|attachments/.test(sub)) return null;
  if (m === "DELETE") return withId(build(ledger, tool, FINANCE_ACTIONS.voidRecord, record, { recordType: collection }));
  if (payroll) return withId(classifyLedgerTool(ledger, `${/approve|revert/.test(sub) ? sub : "update"}_payroll_${collection}`, record));
  if (sub === "email") return withId(build(ledger, tool, FINANCE_ACTIONS.sendInvoice, record, { recordType: "invoice" }));
  const singular: Record<string, string> = {
    invoices: "invoice",
    payments: "payment",
    batchpayments: "batch_payment",
    overpayments: "payment",
    prepayments: "payment",
    banktransactions: "bank_transaction",
    banktransfers: "bank_transfer",
    manualjournals: "manual_journal",
    contacts: "contact",
    creditnotes: "credit_note",
    purchaseorders: "purchase_order",
    quotes: "quote",
    items: "item",
    accounts: "account",
  };
  const noun = singular[collection] ?? collection;
  if (!noun) return null;
  if (/^(allocations)$/.test(rest[2] ?? rest[1] ?? "")) return withId(build(ledger, tool, FINANCE_ACTIONS.recordPayment, record, { recordType: "allocation" }));
  return withId(classifyLedgerTool(ledger, `${idIn ? "update" : "create"}_${noun}`, record));
}

/* ─── webhooks ───────────────────────────────────────────────────────────── */

export interface LedgerEvent {
  ledger: Ledger;
  /** Xero's tenant id, or the QuickBooks company's realm id. */
  tenantId: string;
  /** `invoice`, `contact`, `bill`, `vendor`, `billpayment`, `journalentry`… lower case. */
  entity: string;
  entityId: string;
  /** `create`, `update`, `delete`, `void`, `emailed`, `merge`. */
  operation: string;
  at: string;
  /** Unique per event, for recording each once. */
  eventId: string;
}

/** Xero's batch: `{ events: [ { resourceId, tenantId, eventCategory, eventType, eventDateUtc } ] }`. */
export function parseXeroWebhook(body: unknown): LedgerEvent[] {
  const events = isRec(body) && Array.isArray(body.events) ? body.events : [];
  const out: LedgerEvent[] = [];
  for (const e of events) {
    if (!isRec(e)) continue;
    const tenantId = str(e.tenantId, 100);
    const entityId = str(e.resourceId, 100);
    const entity = str(e.eventCategory, 40)?.toLowerCase();
    const operation = str(e.eventType, 40)?.toLowerCase();
    if (!tenantId || !entityId || !entity || !operation || str(e.tenantType)?.toUpperCase() === "APPLICATION") continue;
    const at = str(e.eventDateUtc, 40) ?? new Date(0).toISOString();
    out.push({ ledger: "xero", tenantId, entity, entityId, operation, at, eventId: `${entity}:${entityId}:${operation}:${at}` });
  }
  return out;
}

/**
 * Intuit sends either format during its move to CloudEvents: a JSON array of
 * CloudEvents (`type: "qbo.bill.created.v1"`, `intuitaccountid`,
 * `intuitentityid`), or the older `{ eventNotifications: [ { realmId,
 * dataChangeEvent: { entities: [ { name, id, operation, lastUpdated } ] } } ] }`.
 */
export function parseQuickbooksWebhook(body: unknown): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  const op = (s: string): string => {
    const o = s.toLowerCase();
    return o === "created" ? "create" : o === "updated" ? "update" : o === "deleted" ? "delete" : o === "voided" ? "void" : o === "merged" ? "merge" : o;
  };
  if (Array.isArray(body)) {
    for (const e of body) {
      if (!isRec(e)) continue;
      const type = str(e.type, 120) ?? "";
      const t = /^qbo\.([a-z]+)\.([a-z]+)\b/i.exec(type);
      const data = isRec(e.data) ? e.data : {};
      const tenantId = str(e.intuitaccountid, 60) ?? str(field(data, "realmId", "accountId"), 60);
      const entityId = str(e.intuitentityid, 60) ?? str(field(data, "id", "entityId"), 60);
      if (!t || !tenantId || !entityId) continue;
      const at = str(e.time, 40) ?? new Date(0).toISOString();
      out.push({ ledger: "quickbooks", tenantId, entity: t[1]!.toLowerCase(), entityId, operation: op(t[2]!), at, eventId: str(e.id, 120) ?? `${t[1]}:${entityId}:${t[2]}:${at}` });
    }
    return out;
  }
  const notes = isRec(body) && Array.isArray(body.eventNotifications) ? body.eventNotifications : [];
  for (const n of notes) {
    if (!isRec(n)) continue;
    const tenantId = str(n.realmId, 60);
    const change = isRec(n.dataChangeEvent) ? n.dataChangeEvent : {};
    const entities = Array.isArray(change.entities) ? change.entities : [];
    for (const e of entities) {
      if (!isRec(e) || !tenantId) continue;
      const entity = str(e.name, 40)?.toLowerCase();
      const entityId = str(e.id, 60);
      const operation = str(e.operation, 20);
      if (!entity || !entityId || !operation) continue;
      const at = str(e.lastUpdated, 40) ?? new Date(0).toISOString();
      out.push({ ledger: "quickbooks", tenantId, entity, entityId, operation: op(operation), at, eventId: `${entity}:${entityId}:${operation.toLowerCase()}:${at}` });
    }
  }
  return out;
}

/** The record a ledger event names, as the ledger's API answers for it. Xero: `/Invoices/{id}`; QuickBooks: `/{entity}/{id}`. */
export function recordPath(event: Pick<LedgerEvent, "ledger" | "entity" | "entityId">): string | null {
  const id = encodeURIComponent(event.entityId);
  if (event.ledger === "xero") {
    const map: Record<string, string> = { invoice: "Invoices", contact: "Contacts", creditnote: "CreditNotes" };
    const c = map[event.entity];
    return c ? `/api.xro/2.0/${c}/${id}` : null;
  }
  const watched = ["bill", "billpayment", "vendor", "journalentry", "purchase", "invoice", "creditmemo", "payment", "deposit", "transfer", "vendorcredit", "refundreceipt"];
  return watched.includes(event.entity) ? `/${event.entity}/${id}` : null;
}

/** The record out of the ledger's answer: Xero's `{ Invoices: [x] }`, QuickBooks' `{ Bill: x }`. */
export function unwrapRecord(answer: unknown): Rec {
  if (!isRec(answer)) return {};
  for (const v of Object.values(answer)) {
    if (Array.isArray(v) && v.length && isRec(v[0])) return v[0];
    if (isRec(v) && Object.keys(answer).length <= 2) return v;
  }
  return answer;
}

/**
 * A change worth watching, from an event and the record as it now stands.
 * Null for one nobody needs to see: a draft saved, a contact's phone number.
 *
 * `previousBank` is the masked bank details Deliverd last saw on that
 * contact (null the first time, which records a baseline and flags nothing).
 */
export interface LedgerChange {
  actionId: FinanceActionId;
  summary: string;
  /** What a covering gate's input must mention. */
  subjectTerms: string[];
  /** A contact's bank details, masked: store it as the next baseline. */
  bankNow?: string;
  /** Nothing to record: only the baseline changed hands (the first sight of a contact, or no bank change). */
  baselineOnly?: boolean;
}

export function changeFrom(event: LedgerEvent, record: Rec, previousBank: string | null | undefined): LedgerChange | null {
  const ledger = event.ledger;
  const op = event.operation;
  const status = (str(field(record, "status")) ?? "").toUpperCase();
  const type = (str(field(record, "type")) ?? "").toUpperCase();
  const amount = amountOf(record);
  const currency = currencyOf(record);
  const who = counterpartyOf(record, event.entity === "contact" || event.entity === "vendor");
  const terms = (...t: (string | undefined)[]) => t.filter((x): x is string => !!x).map((x) => x.slice(0, 200));
  const make = (actionId: FinanceActionId, recordType: string, extra: Partial<LedgerInput> = {}): LedgerChange => {
    const input: LedgerInput = { ledger, tool: `${event.entity}.${op}`, recordType, ...(amount !== undefined ? { amount } : {}), ...(currency ? { currency } : {}), ...(who ? { counterparty: who } : {}), ...extra };
    return { actionId, summary: summarise({ actionId, input }), subjectTerms: terms(who, amount !== undefined ? String(amount) : undefined) };
  };

  if (event.entity === "contact" || event.entity === "vendor") {
    const bank = bankDetailsIn(record);
    const now = bank ? maskAccount(bank) : undefined;
    const bankNow = now ?? "none on file";
    if (previousBank === null || previousBank === undefined || bankNow === previousBank) {
      return { ...make(FINANCE_ACTIONS.ledgerWrite, event.entity), subjectTerms: [], bankNow, baselineOnly: true };
    }
    const c = make(FINANCE_ACTIONS.supplierBankDetails, event.entity, { previousBankDetails: previousBank, newBankDetails: bankNow });
    return { ...c, summary: `${c.summary}: ${previousBank} → ${bankNow}`, subjectTerms: terms(who), bankNow };
  }

  if (op === "delete" || op === "void" || status === "VOIDED" || status === "DELETED") return make(FINANCE_ACTIONS.voidRecord, event.entity);

  if (ledger === "xero") {
    if (event.entity === "invoice" && type === "ACCPAY" && status === "AUTHORISED") return make(FINANCE_ACTIONS.approveBill, "bill");
    if (event.entity === "invoice" && status === "PAID") return make(FINANCE_ACTIONS.recordPayment, type === "ACCPAY" ? "bill" : "invoice");
    if (event.entity === "creditnote" && status === "AUTHORISED") return make(FINANCE_ACTIONS.creditNote, "credit_note");
    return null;
  }
  // QuickBooks has no approval state: a bill saved is a bill to pay.
  const map: Record<string, FinanceActionId> = {
    bill: FINANCE_ACTIONS.approveBill,
    billpayment: FINANCE_ACTIONS.recordPayment,
    journalentry: FINANCE_ACTIONS.postJournal,
    purchase: FINANCE_ACTIONS.bankTransaction,
    deposit: FINANCE_ACTIONS.bankTransaction,
    transfer: FINANCE_ACTIONS.bankTransaction,
    creditmemo: FINANCE_ACTIONS.creditNote,
    refundreceipt: FINANCE_ACTIONS.creditNote,
    vendorcredit: FINANCE_ACTIONS.creditNote,
  };
  if (event.entity === "invoice" && op === "emailed") return make(FINANCE_ACTIONS.sendInvoice, "invoice");
  const a = map[event.entity];
  if (a && (op === "create" || op === "update")) return make(a, event.entity);
  return null;
}

/** Is this Xero record a bill waiting for someone to approve it? */
export function awaitingApproval(record: Rec): boolean {
  return (str(field(record, "type")) ?? "").toUpperCase() === "ACCPAY" && (str(field(record, "status")) ?? "").toUpperCase() === "SUBMITTED";
}

/* ─── what the approver should know ──────────────────────────────────────── */

export interface PastRecord {
  id?: string;
  reference?: string;
  amount?: number;
  date?: string;
  status?: string;
}

export interface CheckInput {
  amount?: number;
  currency?: string;
  reference?: string;
  recordId?: string;
  /** The counterparty's recent records of the same kind, newest first. */
  recent?: PastRecord[];
  /** The record's date, `YYYY-MM-DD`. */
  date?: string;
  /** The ledger's lock date, `YYYY-MM-DD`: nothing on or before it should change. */
  lockDate?: string | null;
}

/**
 * The findings an approver reads above Approve, and the flags rules key on.
 * A duplicate is the same reference, or the same amount within 30 days.
 */
export function ledgerChecks(c: CheckInput): { checks: string[]; newCounterparty?: boolean; closedPeriod?: boolean } {
  const checks: string[] = [];
  const recent = (c.recent ?? []).filter((r) => !c.recordId || r.id !== c.recordId);
  let newCounterparty: boolean | undefined;
  if (c.recent) {
    newCounterparty = recent.length === 0;
    if (newCounterparty) checks.push("First record for this counterparty in the ledger.");
  }
  const day = (s: string | undefined) => (s ? Date.parse(s.slice(0, 10)) : NaN);
  for (const r of recent) {
    const sameRef = c.reference && r.reference && r.reference.trim().toLowerCase() === c.reference.trim().toLowerCase();
    const near = Number.isFinite(day(r.date)) && Number.isFinite(day(c.date)) && Math.abs(day(r.date) - day(c.date)) <= 30 * 86_400_000;
    const sameAmount = c.amount !== undefined && r.amount !== undefined && Math.abs(r.amount - c.amount) < 0.005;
    if (sameRef || (sameAmount && near)) {
      checks.push(`Possible duplicate of ${r.reference || r.id || "an earlier record"}${r.date ? ` dated ${r.date.slice(0, 10)}` : ""}${r.amount !== undefined ? ` for ${money(r.amount, c.currency)}` : ""}.`);
      break;
    }
  }
  const amounts = recent.map((r) => r.amount).filter((a): a is number => a !== undefined);
  if (c.amount !== undefined && amounts.length >= 2) {
    const largest = Math.max(...amounts);
    if (c.amount > largest * 2) checks.push(`More than twice the largest of the last ${amounts.length} (${money(largest, c.currency)}).`);
  }
  if (recent.length) {
    checks.push(`Last ${Math.min(recent.length, 3)}: ${recent
      .slice(0, 3)
      .map((r) => [r.reference || r.id, r.date?.slice(0, 10), r.amount !== undefined ? money(r.amount, c.currency) : undefined].filter(Boolean).join(", "))
      .join("; ")}.`);
  }
  let closedPeriod: boolean | undefined;
  if (c.lockDate !== undefined) {
    closedPeriod = !!(c.lockDate && c.date && c.date.slice(0, 10) <= c.lockDate.slice(0, 10));
    if (closedPeriod) checks.push(`Dated in a locked period (locked to ${c.lockDate!.slice(0, 10)}).`);
  }
  return { checks, ...(newCounterparty !== undefined ? { newCounterparty } : {}), ...(closedPeriod !== undefined ? { closedPeriod } : {}) };
}
