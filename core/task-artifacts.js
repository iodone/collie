// A ticket's artifacts come only from explicit records: artifact.task === task.ref, or the
// artifact named by Task.proof. Proof is first; every other artifact is newest first.

/**
 * The ids explicitly bound to a task, its proof first, then newest first.
 * arts: collie-artifact records ({ id, task, folder, at, machine? }).
 * task: { ref, folder, machine, proof: { id, title } | null }.
 */
export function taskArtifacts(arts, task) {
  const ref = task?.ref ?? null, machine = task?.machine ?? null, proof = task?.proof?.id ?? null;
  const mine = (Array.isArray(arts) ? arts : []).filter((a) => {
    if (!a?.id || (a.machine ?? null) !== machine || (a.folder ?? null) !== (task?.folder ?? null)) return false;
    return a.id === proof || a.task === ref;
  });
  return mine.sort((x, y) => Number(y.id === proof) - Number(x.id === proof) || (y.at ?? 0) - (x.at ?? 0)).map((a) => a.id);
}

/** Its title as the task's tab lists it: without the task's id in front ("SHEP-60: Coverage" -> "Coverage"), and a
 *  proof's without " · Proof" at its end (its Proof mark says it). */
export function titleInTask(title, ref, proof = false) {
  let t = String(title ?? "");
  const r = String(ref ?? "");
  // SHOP-4 never cuts SHOP-40's
  if (r && t.slice(0, r.length).toUpperCase() === r.toUpperCase() && !/\d/.test(t[r.length] ?? "")) t = t.slice(r.length).replace(/^[:\s·-]+/, "") || t;
  if (proof) t = t.replace(/\s*·\s*proof\s*$/i, "") || t;
  return t;
}
