// A Task's Receipts are its ready delivery records, not terminal output or helper messages.
// Receipt files are the durable source; Task.receipts is their ordered projection.

export function sortReceipts(receipts) {
  return [...(Array.isArray(receipts) ? receipts : [])].sort((a, b) => Date.parse(b?.received_at ?? b?.task?.ready_at ?? "") - Date.parse(a?.received_at ?? a?.task?.ready_at ?? ""));
}

/** Receipts for one task, newest first. A receipt matches by its canonical task ref or id. */
export function taskReceipts(receipts, task) {
  const ref = String(task?.ref ?? task?.id ?? "").toUpperCase();
  return sortReceipts((Array.isArray(receipts) ? receipts : []).filter((r) => {
    const id = String(r?.task?.ref ?? r?.task?.id ?? "").toUpperCase();
    return Boolean(r?.id && ref && id === ref);
  }));
}

export function receiptTitle(receipt) {
  return String(receipt?.summary ?? receipt?.proof?.title ?? receipt?.id ?? "Receipt");
}

export function receiptProofRefs(receipt) {
  const refs = receipt?.proof?.refs;
  return Array.isArray(refs) ? refs.filter((ref) => typeof ref === "string" && ref) : [];
}
