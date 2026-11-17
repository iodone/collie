#!/bin/sh
# collie-artifact CLI: publish/list/show/export/rm, the collie store, and the read-only legacy fallback.
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

# ---- $COLLIE_ARTIFACTS_HOME picks the store --------------------------------------------------
cd "$WORK"
COLLIE_ARTIFACTS_HOME="$TMP/custom-store" $CLI publish ./report --title "Elsewhere" --json >/dev/null
test -d "$TMP/custom-store/files" || fail "COLLIE_ARTIFACTS_HOME store missing"
test -n "$(ls "$TMP/custom-store"/*.json 2>/dev/null)" || fail "COLLIE_ARTIFACTS_HOME list missing"

# ---- no writes under ~/.herdr ---------------------------------------------------------------
test ! -e "$HOME/.herdr" || fail "wrote ~/.herdr without a legacy store"

# ---- legacy store: read-only fallback -------------------------------------------------------
LEG="$TMP/legacy"
mkdir -p "$LEG/report" "$HOME/.herdr/artifacts/files/legacy-abc/v1"
cp "$WORK/report/recipe.json" "$LEG/report/recipe.json"
cp "$LEG/report/recipe.json" "$HOME/.herdr/artifacts/files/legacy-abc/v1/recipe.json"
cd "$LEG"
SLUG=$($CLI where --json | json 'd["slug"]')
cat > "$HOME/.herdr/artifacts/$SLUG.json" <<JSON
{"version": 1, "folder": "$(pwd -P)", "kind": "folder", "name": "legacy", "slug": "$SLUG",
 "artifacts": [{"id": "legacy-abc", "title": "Legacy report", "version": 1, "folder": "$(pwd -P)",
   "at": 1, "created": 1, "versions": [{"v": 1, "at": 1, "kind": "recipe"}], "files": ["recipe.json"]}]}
JSON
test "$($CLI list --json | json 'd["artifacts"][0]["id"]')" = "legacy-abc" || fail "legacy list"
test "$($CLI show legacy-abc --json | json 'd["title"]')" = "Legacy report" || fail "legacy show"
test -f "$($CLI export legacy-abc --out "$TMP/legacy-out" --json | json 'd["path"]')/recipe.json" || fail "legacy export"
if $CLI rm legacy-abc >/dev/null 2>&1; then fail "rm removed a legacy-only artifact"; fi
test -f "$HOME/.herdr/artifacts/$SLUG.json" || fail "rm touched the legacy store"

echo "ok: collie-artifact publish/list/show/export/rm, collie store, legacy read fallback"
