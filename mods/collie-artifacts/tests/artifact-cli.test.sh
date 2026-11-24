#!/bin/sh
# collie-artifact CLI: publish/list/show/export/rm, explicit task binding, and the single collie store.
# Runs entirely under a temporary HOME; no Shepherdr artifacts mod and no herdr-app state needed.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="python3 $HERE/bin/collie-artifact"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset COLLIE_ARTIFACTS_HOME || true
mkdir -p "$HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

# ---- a recipe folder ---------------------------------------------------------------------
WORK="$TMP/work"
mkdir -p "$WORK/report"
cat > "$WORK/report/recipe.json" <<'JSON'
{"recipe": 1, "blocks": [
  {"type": "text", "md": "**92%** of lines are covered."},
  {"type": "table", "columns": ["Package", "Coverage"], "rows": [["api", "88%"], ["web", "95%"]]},
  {"type": "image", "src": "pic.svg", "caption": "A picture beside recipe.json"}
]}
JSON
cat > "$WORK/report/pic.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#2f81f7"/></svg>
SVG

# ---- --version needs no store --------------------------------------------------------------
test "$($CLI --version)" = "1" || fail "--version"

# ---- publish (belongs to the folder it runs in, like a task) --------------------------------
cd "$WORK"
ID=$($CLI publish ./report --title "Coverage by package" --json | json 'd["id"]')
test -n "$ID" || fail "publish returned no id"
LIST=$($CLI list --json)
test "$(printf '%s' "$LIST" | json 'len(d["artifacts"])')" = "1" || fail "list: $LIST"
test "$(printf '%s' "$LIST" | json 'd["artifacts"][0]["id"]')" = "$ID" || fail "list id"
case "$LIST" in *'"store": "'"$HOME"'/.local/share/collie/artifacts/'*) ;; *) fail "list store: $LIST" ;; esac

# ---- show ---------------------------------------------------------------------------------
SHOW=$($CLI show "$ID" --json)
test "$(printf '%s' "$SHOW" | json 'd["version"]')" = "1" || fail "show: $SHOW"
test "$(printf '%s' "$SHOW" | json 'd["title"]')" = "Coverage by package" || fail "show title"

# ---- export: copies the version's files, changes nothing ------------------------------------
OUT=$($CLI export "$ID" --out "$TMP/out" --json | json 'd["path"]')
test "$OUT" = "$TMP/out/$ID-v1" || fail "export path: $OUT"
test -f "$OUT/recipe.json" || fail "export recipe.json"
test -f "$OUT/pic.svg" || fail "export pic.svg"
test -f "$HOME/.local/share/collie/artifacts/files/$ID/v1/recipe.json" || fail "export moved the store"

# ---- a second version, and an older one exported --------------------------------------------
cat > report/recipe.json <<'JSON'
{"recipe": 1, "blocks": [{"type": "text", "md": "Now **95%**."}]}
JSON
$CLI update "$ID" ./report --note "adds a line" --json >/dev/null
$CLI export "$ID" --version 1 --out "$TMP/out-old" >/dev/null
test -f "$TMP/out-old/$ID-v1/recipe.json" || fail "older export"

# ---- rm ------------------------------------------------------------------------------------
$CLI rm "$ID" --json >/dev/null
test "$($CLI list --json | json 'len(d["artifacts"])')" = "0" || fail "rm left it listed"
test ! -d "$HOME/.local/share/collie/artifacts/files/$ID" || fail "rm left files"

# ---- explicit task binding, proof ordering, and live-driver Mark up routing -------------------
export COLLIE_TASK_STORE="$TMP/task-store"
SLUG=$($CLI where --folder "$WORK" | json 'd["slug"]')
python3 - "$COLLIE_TASK_STORE" "$SLUG" "$WORK" <<'PY'
import json, os, sys
store, slug, folder = sys.argv[1:]
folder = os.path.realpath(folder)
os.makedirs(store, exist_ok=True)
with open(os.path.join(store, slug + ".json"), "w") as f:
    json.dump({"folder": folder, "prefix": "COLL", "tasks": [{
        "id": 42, "title": "Bind artifacts",
        "agents": [
            {"address": "t88", "role": "worker"},
            {"address": "t90", "role": "reviewer"},
            {"address": "t91", "role": "verifier"},
            {"address": "t92", "role": "helper"}
        ]
    }]}, f)
PY
mkdir -p "$TMP/bin"
cat > "$TMP/bin/hc" <<'SH'
#!/bin/sh
case "$1" in
  ls) printf '%s\n' "$HC_LIVE" ;;
  get) printf '{}\n' ;;
  send) printf '%s\n' "$2" > "$HC_CAPTURE" ;;
esac
SH
chmod +x "$TMP/bin/hc"
export PATH="$TMP/bin:$PATH"
export HC_CAPTURE="$TMP/note-target"
export HC_LIVE='{"terminals":[{"address":"t88","state":"live"},{"address":"t90","state":"live"},{"address":"t91","state":"live"},{"address":"t92","state":"live"}]}'
TASK_SHOW=$(HC_TERMINAL_ID=t90 $CLI publish ./report --title "Task proof" --task COLL-42 --json)
TASK_ID=$(printf '%s' "$TASK_SHOW" | json 'd["id"]')
test "$(printf '%s' "$TASK_SHOW" | json 'd["task"]')" = "COLL-42" || fail "publish --task binding"
test "$(printf '%s' "$TASK_SHOW" | json 'd["publisher"]')" = "t90" || fail "publisher"
PROOF_SHOW=$(HERDR_BROWSER_TASK="$SLUG#42" $CLI publish ./report --title "Accepted proof" --json)
test "$(printf '%s' "$PROOF_SHOW" | json 'd["task"]')" = "COLL-42" || fail "current task store ref lookup"
PROOF_ID=$(printf '%s' "$PROOF_SHOW" | json 'd["id"]')
NOTE=$($CLI note "$TASK_ID" --text "Driver only" --json)
test "$(printf '%s' "$NOTE" | json 'd["to"]')" = "t88" || fail "markup did not choose driver: $NOTE"
test "$(cat "$HC_CAPTURE")" = "t88" || fail "markup sent to helper"
export HC_LIVE='{"terminals":[{"address":"t88","state":"live"}]}'
test "$($CLI note "$TASK_ID" --text "Publisher ended" --json | json 'd["to"]')" = "t88" || fail "ended publisher did not fall back to driver"
export HC_LIVE='{"terminals":[{"address":"t90","state":"live"},{"address":"t91","state":"live"},{"address":"t92","state":"live"}]}'
if $CLI note "$TASK_ID" --text "No driver" --json >/dev/null 2>&1; then fail "markup fell back to helper"; fi
TASK_ID="$TASK_ID" PROOF_ID="$PROOF_ID" node --input-type=module - "$HERE" <<'JS'
import { pathToFileURL } from "node:url";
const { taskArtifacts } = await import(pathToFileURL(`${process.argv[2]}/core/task-artifacts.js`));
const task = { ref: "COLL-42", folder: "/repo", machine: "vm", proof: { id: process.env.PROOF_ID, title: "Proof" } };
const at = (id, extra = {}) => ({ id, folder: "/repo", machine: "vm", at: 1, ...extra });
const ids = taskArtifacts([
  at(process.env.TASK_ID, { task: "COLL-42", at: 2 }),
  at(process.env.PROOF_ID, { task: "COLL-42", at: 0 }),
  at("same-publisher", { versions: [{ publisher: "t90" }], at: 9 }),
  at("wrong-folder", { task: "COLL-42", folder: "/other" }),
  at("wrong-machine", { task: "COLL-42", machine: "other" }),
], task);
if (JSON.stringify(ids) !== JSON.stringify([process.env.PROOF_ID, process.env.TASK_ID])) {
  throw new Error(`explicit artifact binding failed: ${JSON.stringify(ids)}`);
}
JS

# ---- $COLLIE_ARTIFACTS_HOME picks the store --------------------------------------------------
cd "$WORK"
COLLIE_ARTIFACTS_HOME="$TMP/custom-store" $CLI publish ./report --title "Elsewhere" --json >/dev/null
test -d "$TMP/custom-store/files" || fail "COLLIE_ARTIFACTS_HOME store missing"
test -n "$(ls "$TMP/custom-store"/*.json 2>/dev/null)" || fail "COLLIE_ARTIFACTS_HOME list missing"

# ---- no writes under ~/.herdr ---------------------------------------------------------------
test ! -e "$HOME/.herdr" || fail "wrote ~/.herdr without a legacy store"

echo "ok: collie-artifact publish/list/show/export/rm, collie store"
