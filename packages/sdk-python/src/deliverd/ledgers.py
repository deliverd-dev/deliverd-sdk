"""Xero and QuickBooks Online: which tool calls change the books, as finance actions.

The same map as ``@deliverd/sdk``'s ``classifyLedgerTool`` and Deliverd's
ledger gateway, for agents built on Xero's agent toolkit or Intuit's MCP
server in Python. A read (listing invoices, running a report) is ``None``;
everything that changes the books is one of the finance actions, with the
amount, currency and counterparty read from the call, so a rule written as
``amount gte 5000`` or "a supplier's bank details always asks" applies::

    from deliverd import Deliverd
    from deliverd.ledgers import classify_ledger_tool

    call = classify_ledger_tool("xero", "create-payment", arguments)
    if call is not None:
        gate = Deliverd().gates.check(action_id=call.action_id, input=call.input, description=call.summary)
        ...

The finance actions are the "Agents in the books" starter kit's. Kept in step
with the TypeScript by ``tests/test_ledgers.py``, which runs the cases in
``packages/core/src/ledgers.cases.json`` when it can see them.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

__all__ = [
    "LEDGERS",
    "LEDGER_LABEL",
    "FINANCE_ACTIONS",
    "FINANCE_ACTION_IDS",
    "LedgerCall",
    "classify_ledger_tool",
    "finance_action_label",
    "mask_account",
    "tool_key",
]

LEDGERS = ("xero", "quickbooks")
LEDGER_LABEL = {"xero": "Xero", "quickbooks": "QuickBooks Online"}

FINANCE_ACTIONS = {
    "approve_bill": "finance.approve_bill",
    "record_payment": "finance.record_payment",
    "post_journal": "finance.post_journal",
    "bank_transaction": "finance.bank_transaction",
    "supplier_bank_details": "finance.change_supplier_bank_details",
    "send_invoice": "finance.send_invoice",
    "credit_note": "finance.issue_credit_note",
    "payroll": "finance.approve_payroll",
    "void_record": "finance.void_record",
    "ledger_write": "finance.ledger_write",
}
FINANCE_ACTION_IDS = tuple(FINANCE_ACTIONS.values())
_A = FINANCE_ACTIONS

_LABELS = {
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
}


@dataclass(frozen=True)
class LedgerCall:
    """A finance action: its id, the gate's input, and one line for the approver."""

    action_id: str
    input: Dict[str, Any]
    summary: str


Rec = Dict[str, Any]


def _is_rec(v: Any) -> bool:
    return isinstance(v, dict)


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return v
    if isinstance(v, str) and re.fullmatch(r"-?\d+(\.\d+)?", v.strip()):
        n = float(v.strip())
        return int(n) if n.is_integer() else n
    return None


def _str(v: Any, limit: int = 200) -> Optional[str]:
    if isinstance(v, str) and v.strip():
        return v.strip()[:limit]
    n = _num(v) if not isinstance(v, str) else None
    if n is not None:
        return str(int(n)) if float(n).is_integer() else repr(n)
    return None


def _round2(n: float) -> float:
    r = math.floor(n * 100 + 0.5) / 100
    return int(r) if float(r).is_integer() else r


def _norm(k: str) -> str:
    return re.sub(r"[_\-\s]", "", k.lower())


def _field(o: Rec, *names: str) -> Any:
    want = {_norm(n) for n in names}
    for k, v in o.items():
        if _norm(k) in want:
            return v
    return None


_LINE_KEYS = {"lineitems", "line", "lines", "journallines", "manualjournallines"}


def _primary_record(args: Any) -> Rec:
    if not _is_rec(args):
        return {}
    keys = list(args.keys())
    if len(keys) <= 2:
        for k in keys:
            v = args[k]
            if isinstance(v, list) and v and _is_rec(v[0]) and _norm(k) not in _LINE_KEYS:
                return v[0]
            if _is_rec(v) and len(keys) == 1 and not re.fullmatch(r"(contact|vendor|customer|invoice|account)ref?", k, re.I):
                return v
    return args


def _line_total(lines: Any) -> Optional[float]:
    if not isinstance(lines, list) or not lines:
        return None
    total, seen = 0.0, False
    for line in lines:
        if not _is_rec(line):
            continue
        amount = _num(_field(line, "lineAmount", "amount"))
        if amount is not None:
            total += amount
            seen = True
            continue
        qty = _num(_field(line, "quantity", "qty"))
        unit = _num(_field(line, "unitAmount", "unitPrice"))
        if unit is not None:
            total += (1 if qty is None else qty) * unit
            seen = True
    return _round2(total) if seen else None


def _journal_total(lines: Any) -> Optional[float]:
    if not isinstance(lines, list) or not lines:
        return None
    debit, seen = 0.0, False
    for line in lines:
        if not _is_rec(line):
            continue
        detail = _field(line, "journalEntryLineDetail")
        posting = _str(_field(detail, "postingType")) if _is_rec(detail) else None
        amount = _num(_field(line, "lineAmount", "amount"))
        if amount is None:
            continue
        seen = True
        if (posting.lower() == "debit") if posting else amount > 0:
            debit += abs(amount)
    return _round2(debit) if seen else None


def _amount_of(record: Rec) -> Optional[float]:
    direct = _num(_field(record, "total", "totalAmt", "amount", "totalAmount"))
    if direct is not None:
        return _round2(abs(direct))
    journal = _journal_total(_field(record, "journalLines", "manualJournalLines"))
    if journal is not None:
        return journal
    lines = _field(record, "lineItems", "line", "lines")
    if isinstance(lines, list) and any(_is_rec(l) and _is_rec(_field(l, "journalEntryLineDetail")) for l in lines):
        return _journal_total(lines)
    return _line_total(lines)


def _currency_of(record: Rec) -> Optional[str]:
    c = _field(record, "currencyCode", "currency", "currencyRef")
    code = _str(_field(c, "value")) if _is_rec(c) else _str(c)
    return code.upper() if code and re.fullmatch(r"[A-Za-z]{3}", code) else None


_REFS = ("contact", "vendorRef", "customerRef", "entityRef", "payeeRef", "employeeRef")


def _counterparty_of(record: Rec, self_named: bool = False) -> Optional[str]:
    for key in _REFS:
        v = _field(record, key)
        if _is_rec(v):
            n = _str(_field(v, "name", "displayName", "contactName"))
            if n:
                return n
    named = _str(_field(record, "contactName", "vendorName", "customerName", "payeeName", "employeeName"))
    if named:
        return named
    invoice = _field(record, "invoice")
    if _is_rec(invoice):
        n = _counterparty_of(invoice)
        if n:
            return n
    if self_named:
        n = _str(_field(record, "name", "displayName", "companyName", "fullName"))
        if n:
            return n
    for key in _REFS:
        v = _field(record, key)
        i = _str(_field(v, "value", "contactId", "id")) if _is_rec(v) else _str(v)
        if i:
            return i
    return _str(_field(record, "contactId", "vendorId", "customerId", "employeeId"))


_BANK_KEYS = {
    _norm(k)
    for k in (
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
    )
}


def _bank_details_in(record: Rec) -> Optional[str]:
    parts = []

    def walk(o: Rec, depth: int) -> None:
        for k, v in o.items():
            if _norm(k) in _BANK_KEYS:
                if _is_rec(v):
                    walk(v, depth + 1)
                else:
                    s = _str(v, 120)
                    if s:
                        parts.append(s)
            elif depth > 0 and _is_rec(v):
                walk(v, depth + 1)
            elif depth > 0:
                s = _str(v, 120)
                if s and re.search(r"number|account|sort|bsb|iban|routing|branch", k, re.I):
                    parts.append(s)

    walk(record, 0)
    return " ".join(parts) if parts else None


def mask_account(value: Optional[str]) -> str:
    """``•••• 1234``: enough for a person to recognise an account, not enough to pay into it."""
    digits = re.sub(r"[^0-9A-Za-z]", "", value or "")
    return f"•••• {digits[-4:]}" if digits else "none on file"


def tool_key(tool: str) -> str:
    """``xero__create-payment``, ``mcp__qbo__create_bill``, ``create-payment`` → ``create_payment``."""
    bare = tool[tool.rfind("__") + 2 :] if "__" in tool else tool
    return re.sub(r"[-\s.]", "_", bare.lower())


_READ = re.compile(r"^(list|get|search|read|find|query|fetch|report|retrieve|download|show|describe|count|whoami|lookup)(_|$)")
_WRITE = re.compile(
    r"^(create|update|delete|remove|void|approve|revert|add|send|email|post|pay|authori[sz]e|submit|apply|allocate|reconcile|write|set|upsert|import|batch|archive|refund|transfer)(_|$)"
)


def finance_action_label(action_id: str) -> str:
    return _LABELS.get(action_id, action_id)


def _money(amount: Optional[float], currency: Optional[str]) -> str:
    if amount is None:
        return ""
    n = f"{amount:,.2f}"
    return f"{n} {currency}" if currency else n


def _summarise(action_id: str, inp: Rec) -> str:
    parts = [_LABELS[action_id]]
    m = _money(inp.get("amount"), inp.get("currency"))
    if m:
        parts.append(f"of {m}")
    who = inp.get("counterparty")
    if who:
        to = action_id in (_A["send_invoice"], _A["credit_note"])
        parts.append(f"{'to' if to else 'for'} {who}")
    parts.append(f"in {LEDGER_LABEL[inp['ledger']]}")
    return " ".join(parts)


def _build(ledger: str, tool: str, action_id: str, record: Rec, **extra: Any) -> LedgerCall:
    inp: Rec = {"ledger": ledger, "tool": tool[:200]}
    amount = _amount_of(record)
    if amount is not None:
        inp["amount"] = amount
    currency = _currency_of(record)
    if currency:
        inp["currency"] = currency
    counterparty = _counterparty_of(record, bool(re.search(r"contact|vendor|supplier|employee", extra.get("recordType") or "")))
    if counterparty:
        inp["counterparty"] = counterparty
    reference = _str(_field(record, "reference", "invoiceNumber", "docNumber", "billNumber", "narration", "privateNote"), 120)
    if reference:
        inp["reference"] = reference
    rid = _str(_field(record, "invoiceId", "billId", "paymentId", "bankTransactionId", "manualJournalId", "contactId", "creditNoteId", "timesheetId", "id"), 100)
    if rid:
        inp["recordId"] = rid
    status = _str(_field(record, "status"), 40)
    if status:
        inp["status"] = status.upper()
    inp.update({k: v for k, v in extra.items() if v is not None})
    if action_id == _A["supplier_bank_details"]:
        inp["bankDetailsChanged"] = True
        nxt = _bank_details_in(record)
        if nxt:
            inp["newBankDetails"] = mask_account(nxt)
    return LedgerCall(action_id, inp, _summarise(action_id, inp))


def classify_ledger_tool(ledger: str, tool: str, args: Any) -> Optional[LedgerCall]:
    """One MCP or toolkit tool call as a finance action, or ``None`` for a read."""
    if ledger not in LEDGERS:
        raise ValueError(f"ledger is one of {', '.join(LEDGERS)}")
    key = tool_key(tool)
    if _READ.search(key):
        return None
    record = _primary_record(args)
    verb = key.split("_")[0]
    noun = re.sub(r"^_", "", _WRITE.sub("", key, count=1))
    status = (_str(_field(record, "status")) or "").upper()
    kind = (_str(_field(record, "type")) or "").upper()

    def b(action: str, **extra: Any) -> LedgerCall:
        return _build(ledger, tool, action, record, **extra)

    if re.fullmatch(r"delete|remove|void|archive", verb) or status in ("VOIDED", "DELETED"):
        if "timesheet" in noun and verb == "delete":
            return b(_A["ledger_write"])
        return b(_A["void_record"], recordType=noun or None)
    if re.search(r"payroll|payrun|pay_run|timesheet", noun):
        if re.fullmatch(r"approve|revert|post|submit", verb) or re.search(r"payrun|pay_run", noun):
            return b(_A["payroll"], recordType="payroll")
        return b(_A["ledger_write"], recordType="payroll")
    if re.search(r"(^|_)(contact|vendor|supplier|employee)s?$", noun):
        if _bank_details_in(record):
            return b(_A["supplier_bank_details"], recordType="vendor" if ("vendor" in noun or "supplier" in noun) else "contact")
        return b(_A["ledger_write"], recordType=noun)
    if "payment" in noun or verb == "pay":
        return b(_A["record_payment"], recordType=noun or "payment")
    if "journal" in noun:
        posted = ledger == "quickbooks" or status == "POSTED" or verb == "post"
        return b(_A["post_journal"] if posted else _A["ledger_write"], recordType="journal")
    if re.search(r"bank_?transaction|bank_?transfer|purchase|expense|deposit|transfer|spend|receive_money", noun):
        return b(_A["bank_transaction"], recordType=noun)
    if re.search(r"credit_?note|credit_?memo|refund|vendor_?credit", noun):
        return b(_A["credit_note"], recordType=noun)
    if re.fullmatch(r"send|email", verb) or re.search(r"(^|_)send$|email$", noun):
        return b(_A["send_invoice"], recordType="invoice")
    if "bill" in noun:
        return b(_A["approve_bill"], recordType="bill")
    if "invoice" in noun:
        approving = status == "AUTHORISED" or verb in ("approve", "authorise")
        if kind == "ACCPAY":
            return b(_A["approve_bill"] if approving else _A["ledger_write"], recordType="bill")
        return b(_A["send_invoice"] if approving else _A["ledger_write"], recordType="invoice")
    if _WRITE.search(key):
        return b(_A["ledger_write"], recordType=noun or None)
    return None
