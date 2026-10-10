# sync-back End-to-End Integration Test Plan

**Purpose:** Verify every sync-back operation against a live prooph board workspace,
and verify that `spec-stream sync` correctly reflects each change back to the local model.

**Status:** Ready to execute — do not modify this file before running.

---

## Environment setup

Before starting, confirm the following:

1. `PROOPHBOARD_API_KEY` is set (read from `.env` or the environment). The key must have
   **write** access to the test workspace.

2. `proophboard.spec-stream.json` has `localSync.enabled: true` and points at
   `.spec-stream/model`.

3. Build the CLI:
   ```sh
   npm run build
   ```

4. The model mirror is freshly seeded:
   ```sh
   node dist/cli.js
   ```
   Confirm `.spec-stream/model/workspace.json` and `uuid-index.json` exist and are
   non-empty before beginning.

5. Read `workspace.json` and record:
   - `WORKSPACE_ID` — the workspace UUID
   - `API_ENDPOINT` — from `proophboard.spec-stream.json`
     (e.g. `https://flow.prooph-board.com/api`)

   All REST validation calls use `Authorization: Bearer $PROOPHBOARD_API_KEY`.

6. Choose one existing chapter from the model to use as the **test chapter** for
   operations that require a pre-existing chapter. Record its `id` as
   `TEST_CHAPTER_ID`. Choose one that has at least one slice, one lane, and one element.

7. **Sync helper:** After every write step the instructions say "trigger sync":
   ```sh
   node dist/cli.js
   ```
   Wait ~2 seconds then exit the command

---

## Shorthand used in task steps

```
CLI      = node dist/cli.js
API      = curl -s -H "Authorization: Bearer $PROOPHBOARD_API_KEY"
BASE     = $API_ENDPOINT    (e.g. https://flow.prooph-board.com/api)
```

---

## Test tasks

### TASK 1 — Chapter create

**Edit:**
```sh
mkdir -p .spec-stream/model/chapters/IntegrationTest/E2E-Chapter
cat > .spec-stream/model/chapters/IntegrationTest/E2E-Chapter/chapter.json <<'EOF'
{
  "name": "E2E Chapter",
  "context": "IntegrationTest",
  "mode": "event-modeling"
}
EOF
```
No `id` field — this is a create.

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # confirm "Create chapter" appears, no "Delete"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters" | jq '.[] | select(.name == "E2E Chapter")'
```
Expected: object with `name: "E2E Chapter"`, `context: "IntegrationTest"`,
`mode: "event-modeling"`. Record its `id` as `E2E_CHAPTER_ID`.

**Trigger sync, then verify local model:**
- `chapter.json` now contains `"id": "<E2E_CHAPTER_ID>"`
- `uuid-index.json` maps `E2E_CHAPTER_ID` to a path containing `E2E-Chapter`
- `.spec-stream/sync-manifest.json` contains an entry for the chapter's entityDir

---

### TASK 2 — Chapter rename

**Prerequisite:** TASK 1 complete (`chapter.json` has `E2E_CHAPTER_ID`).

**Edit:**
```sh
jq '.name = "E2E Chapter Renamed"' \
  .spec-stream/model/chapters/IntegrationTest/E2E-Chapter/chapter.json \
  > /tmp/ch.json && mv /tmp/ch.json \
  .spec-stream/model/chapters/IntegrationTest/E2E-Chapter/chapter.json
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Rename chapter"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.name'
```
Expected: `"E2E Chapter Renamed"`

**Trigger sync, verify local model:**
- Chapter directory renamed to reflect new name slug
- `chapter.json` still has `id = E2E_CHAPTER_ID`

---

### TASK 3 — Chapter context update

**Prerequisite:** TASK 1 complete.

**Edit:**
```sh
jq '.context = "IntegrationTestUpdated"' \
  .spec-stream/model/chapters/IntegrationTest/E2E-Chapter/chapter.json \
  > /tmp/ch.json && mv /tmp/ch.json \
  .spec-stream/model/chapters/IntegrationTest/E2E-Chapter/chapter.json
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Update chapter context"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.context'
```
Expected: `"IntegrationTestUpdated"`

**Trigger sync, verify local model:**
- Chapter directory may move to `chapters/IntegrationTestUpdated/...`
- `chapter.json` still has same `id`

---

### TASK 4 — Slice create

**Prerequisite:** TASK 1 complete.

**Edit:**
```sh
SLICE_DIR=".spec-stream/model/chapters/IntegrationTest/E2E-Chapter/slices/0000_E2E-Slice"
mkdir -p "$SLICE_DIR"
cat > "$SLICE_DIR/slice.json" <<'EOF'
{
  "label": "E2E Slice",
  "index": 0,
  "status": "draft",
  "width": 200
}
EOF
cat > "$SLICE_DIR/details.md" <<'EOF'
Initial slice details.
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create slice"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.slices[] | select(.label == "E2E Slice")'
```
Expected: `label: "E2E Slice"`, `status: "draft"`. Record as `E2E_SLICE_ID`.

**Trigger sync, verify:**
- `slice.json` now has `"id": "<E2E_SLICE_ID>"`
- `details.md` present and unchanged

---

### TASK 5 — Slice status update (core regression test)

**Prerequisite:** TASK 4 complete.

**Edit:**
```sh
jq '.status = "planned"' "$SLICE_DIR/slice.json" > /tmp/sl.json && mv /tmp/sl.json "$SLICE_DIR/slice.json"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose
```
**Critical check (regression for original bug):** dry-run output must contain exactly
one `slice.update-status` operation and **zero** `slice.create` operations. In the old
git-based approach, a file in a gitignored mirror was always status `"A"`, causing this
to emit a spurious create. Confirm the fix before proceeding.

```sh
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_SLICE_ID" '.slices[] | select(.id == $id) | .status'
```
Expected: `"planned"`

**Trigger sync, verify:**
- `slice.json` has `"status": "planned"`

---

### TASK 6 — Slice details update

**Prerequisite:** TASK 4 complete.

**Edit:**
```sh
cat > "$SLICE_DIR/details.md" <<'EOF'
Updated slice details — edited locally.
EOF
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_SLICE_ID" '.slices[] | select(.id == $id) | .details'
```
Expected: `"Updated slice details — edited locally."`

**Trigger sync, verify:** `details.md` matches board value.

---

### TASK 7 — Slice rename

**Prerequisite:** TASK 4 complete.

**Edit:**
```sh
jq '.label = "E2E Slice Renamed"' "$SLICE_DIR/slice.json" > /tmp/sl.json && mv /tmp/sl.json "$SLICE_DIR/slice.json"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Rename slice"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_SLICE_ID" '.slices[] | select(.id == $id) | .label'
```
Expected: `"E2E Slice Renamed"`

**Trigger sync, verify:** Slice directory renamed, `slice.json` still has same `id`.

---

### TASK 8 — Lane create

**Prerequisite:** TASK 4 complete (slice directory exists).

**Edit:**
```sh
LANE_DIR="$SLICE_DIR/lanes/information-flow/E2E-Lane"
mkdir -p "$LANE_DIR"
cat > "$LANE_DIR/lane.json" <<'EOF'
{
  "label": "E2E Lane",
  "type": "information-flow",
  "index": 0,
  "height": 150
}
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create lane"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.lanes[] | select(.label == "E2E Lane")'
```
Expected: lane with `type: "information-flow"`. Record as `E2E_LANE_ID`.

**Trigger sync, verify:** `lane.json` has `"id": "<E2E_LANE_ID>"`

---

### TASK 9 — Lane rename

**Prerequisite:** TASK 8 complete.

**Edit:**
```sh
jq '.label = "E2E Lane Renamed"' "$LANE_DIR/lane.json" > /tmp/ln.json && mv /tmp/ln.json "$LANE_DIR/lane.json"
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_LANE_ID" '.lanes[] | select(.id == $id) | .label'
```
Expected: `"E2E Lane Renamed"`

---

### TASK 10 — Lane resize

**Prerequisite:** TASK 8 complete.

**Edit:**
```sh
jq '.height = 250' "$LANE_DIR/lane.json" > /tmp/ln.json && mv /tmp/ln.json "$LANE_DIR/lane.json"
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_LANE_ID" '.lanes[] | select(.id == $id) | .height'
```
Expected: `250`

---

### TASK 11 — Element create

**Prerequisite:** TASKs 4 and 8 complete (slice and lane exist with known ids).

**Edit:**
```sh
ELEM_DIR="$LANE_DIR/elements/0000_E2E-Element"
mkdir -p "$ELEM_DIR"
cat > "$ELEM_DIR/element.json" <<EOF
{
  "type": "command",
  "name": "E2E Element",
  "context": "IntegrationTest",
  "laneId": "$E2E_LANE_ID",
  "sliceId": "$E2E_SLICE_ID",
  "index": 0
}
EOF
cat > "$ELEM_DIR/description.md" <<'EOF'
This is the element description.
EOF
cat > "$ELEM_DIR/details.md" <<'EOF'
These are the element details.
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create element"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.elements[] | select(.name == "E2E Element")'
```
Expected: `type: "command"`, `lane_id: $E2E_LANE_ID`, `slice_id: $E2E_SLICE_ID`,
`description: "This is the element description."`, `details: "These are the element details."`.
Record as `E2E_ELEMENT_ID`.

**Trigger sync, verify:**
- `element.json` has `"id": "<E2E_ELEMENT_ID>"`
- `.spec-stream/sync-back-ids.json` has an entry (visible until next sync pass absorbs it)

---

### TASK 12 — Element description update

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
cat > "$ELEM_DIR/description.md" <<'EOF'
Updated description — edited locally.
EOF
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id) | .description'
```
Expected: `"Updated description — edited locally."`

**Trigger sync, verify:** `description.md` content matches.

---

### TASK 13 — Element details update

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
cat > "$ELEM_DIR/details.md" <<'EOF'
Updated details — edited locally.
EOF
```

**Run + Verify API:** Check `.details` field, same pattern as TASK 12.

---

### TASK 14 — Element rename

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
jq '.name = "E2E Element Renamed"' "$ELEM_DIR/element.json" > /tmp/el.json && mv /tmp/el.json "$ELEM_DIR/element.json"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Rename element"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id) | .name'
```
Expected: `"E2E Element Renamed"`

**Trigger sync, verify:** Element directory renamed; `element.json` still has same `id`.

---

### TASK 15 — Element play-function update

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
cat > "$ELEM_DIR/play-function.ts" <<'EOF'
async function decide(command, state) {
  return [{ name: "E2E Happened", payload: {} }];
}
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Update element … play config"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id) | .play_function'
```
Expected: non-null string containing the function source.

**Trigger sync, verify:** `play-function.ts` present and matches board.

---

### TASK 16 — Element play-type update

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
cat > "$ELEM_DIR/play-type.ts" <<'EOF'
type Payload = { title: string }
EOF
```

**Run + Verify API:** Check `play_type` field. Same pattern as TASK 15.

---

### TASK 17 — Element move (to different lane)

**Prerequisite:** TASKs 4, 8, 11 complete. First create a second lane:

```sh
LANE2_DIR="$SLICE_DIR/lanes/system/E2E-System-Lane"
mkdir -p "$LANE2_DIR"
cat > "$LANE2_DIR/lane.json" <<'EOF'
{
  "label": "E2E System Lane",
  "type": "system",
  "index": 1,
  "height": 150
}
EOF
node dist/cli.js sync-back   # creates lane 2; record id as E2E_LANE2_ID from API:
$API "$BASE/chapters/$E2E_CHAPTER_ID" | jq '.lanes[] | select(.label == "E2E System Lane") | .id'
```

**Edit element.json to point at the new lane:**
```sh
jq --arg lid "$E2E_LANE2_ID" '.laneId = $lid' "$ELEM_DIR/element.json" \
  > /tmp/el.json && mv /tmp/el.json "$ELEM_DIR/element.json"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Move element … to lane $E2E_LANE2_ID"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id) | .lane_id'
```
Expected: `E2E_LANE2_ID`

**Trigger sync, verify:** Element directory moved under the new lane path.

---

### TASK 18 — Milestone create

**Edit:**
```sh
MILESTONE_DIR=".spec-stream/model/milestones/E2E-Milestone"
mkdir -p "$MILESTONE_DIR"
cat > "$MILESTONE_DIR/milestone.json" <<'EOF'
{
  "name": "E2E Milestone",
  "deadline": "2030-12-31",
  "color": "#3b82f6"
}
EOF
cat > "$MILESTONE_DIR/description.md" <<'EOF'
E2E milestone description.
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create milestone"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/milestones" | jq '.[] | select(.name == "E2E Milestone")'
```
Expected: `deadline: "2030-12-31"`, `color: "#3b82f6"`, `description: "E2E milestone description."`.
Record as `E2E_MILESTONE_ID`.

**Trigger sync, verify:** `milestone.json` has `"id": "<E2E_MILESTONE_ID>"`

---

### TASK 19 — Milestone update

**Prerequisite:** TASK 18 complete.

**Edit:**
```sh
jq '.deadline = "2031-06-30"' "$MILESTONE_DIR/milestone.json" \
  > /tmp/ms.json && mv /tmp/ms.json "$MILESTONE_DIR/milestone.json"
cat > "$MILESTONE_DIR/description.md" <<'EOF'
Updated milestone description.
EOF
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/milestones/$E2E_MILESTONE_ID" | jq '{deadline, description}'
```
Expected: `"2031-06-30"` and `"Updated milestone description."`

---

### TASK 20 — HTML snippet create

**Edit:**
```sh
mkdir -p .spec-stream/model/html-snippets
cat > .spec-stream/model/html-snippets/e2e-snippet.html <<'EOF'
<div class="e2e-test"><h1>E2E Snippet</h1></div>
EOF
cat > .spec-stream/model/html-snippets/e2e-snippet.json <<'EOF'
{
  "slug": "e2e-snippet",
  "name": "E2E HTML Snippet"
}
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create HTML snippet"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/snippets" | jq '.[] | select(.slug == "e2e-snippet")'
```
Expected: `name: "E2E HTML Snippet"`, `snippet` contains the HTML content.

**Trigger sync, verify:**
- `html-snippets/e2e-snippet.html` present with correct HTML
- `html-snippets/e2e-snippet.json` has `slug: "e2e-snippet"`

---

### TASK 21 — HTML snippet content update

**Prerequisite:** TASK 20 complete.

**Edit:**
```sh
cat > .spec-stream/model/html-snippets/e2e-snippet.html <<'EOF'
<div class="e2e-test updated"><h1>E2E Snippet Updated</h1></div>
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Update HTML snippet"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/snippets/e2e-snippet" | jq '.snippet'
```
Expected: updated HTML string.

---

### TASK 22 — HTML snippet name update

**Prerequisite:** TASK 20 complete.

**Edit:**
```sh
jq '.name = "E2E HTML Snippet Renamed"' \
  .spec-stream/model/html-snippets/e2e-snippet.json \
  > /tmp/sn.json && mv /tmp/sn.json .spec-stream/model/html-snippets/e2e-snippet.json
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/snippets/e2e-snippet" | jq '.name'
```
Expected: `"E2E HTML Snippet Renamed"`

---

### TASK 23 — HTML snippet delete

**Prerequisite:** TASK 20 complete.

**Edit:**
```sh
rm .spec-stream/model/html-snippets/e2e-snippet.html \
   .spec-stream/model/html-snippets/e2e-snippet.json
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Delete HTML snippet e2e-snippet"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/snippets" | jq '.[] | select(.slug == "e2e-snippet")'
```
Expected: empty (no match).

**Trigger sync, verify:** `html-snippets/e2e-snippet.*` no longer present.

---

### TASK 24 — Scenario create

**Prerequisite:** TASK 1 complete (E2E chapter exists with `E2E_CHAPTER_ID`).

sync-back creates scenarios directly from a local `scenario.json` — no board API call or UI needed.

**Edit:**
```sh
SCENARIO_DIR=".spec-stream/model/chapters/IntegrationTest/E2E-Chapter/scenarios/E2E-Scenario"
mkdir -p "$SCENARIO_DIR"
cat > "$SCENARIO_DIR/scenario.json" <<EOF
{
  "chapterId": "$E2E_CHAPTER_ID",
  "name": "E2E Scenario"
}
EOF
```
No `id` field — this is a create.

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Create scenario"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios" | jq '.[] | select(.name == "E2E Scenario")'
```
Expected: scenario object with `name: "E2E Scenario"`. Record as `E2E_SCENARIO_ID`.

**Trigger sync, verify:**
- `scenario.json` now has `"id": "<E2E_SCENARIO_ID>"`
- `uuid-index.json` maps `E2E_SCENARIO_ID` to the scenario directory
- `.spec-stream/sync-manifest.json` has an entry for the scenario entityDir

---

### TASK 25 — Scenario rename + clock update + initial state

**Prerequisite:** TASK 24 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d["name"] = "E2E Scenario Renamed"
d["clock"] = "2026-01-01T09:00:00.000Z"
d["initialState"] = {"IntegrationTest": {"TodoList": {"todos": []}}}
d["seededEvents"] = [{"name": "Todo Added", "context": "IntegrationTest", "payload": {"title": "Seed item"}}]
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Update scenario …"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID" | \
  jq '{name, clock, initial_state, seeded_events}'
```
Expected:
- `name: "E2E Scenario Renamed"`
- `clock: "2026-01-01T09:00:00.000Z"`
- `initial_state` contains the TodoList entry
- `seeded_events` has one event

**Trigger sync, verify:** `scenario.json` reflects all fields.

---

### TASK 26 — Scenario clock clear

**Prerequisite:** TASK 25 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d["clock"] = None   # null in JSON → clears the clock
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID" | jq '.clock'
```
Expected: `null`

---

### TASK 27 — Scenario record interactions

**Prerequisite:** TASK 24 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d["interactions"] = [
  {"uiElementId": "ui-elem-1", "storage": {"title": "First Todo"}},
  {"uiElementId": "ui-elem-2", "storage": {"title": "Second Todo"}}
]
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose
# expect: "Clear interactions on scenario …"
#          "Record interaction step 0 on scenario …"
#          "Record interaction step 1 on scenario …"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID" | jq '.interactions'
```
Expected: array with 2 entries matching `step_index` 0 and 1.

**Trigger sync, verify:** `scenario.json` `interactions` array matches board.

---

### TASK 28 — Scenario clear interactions

**Prerequisite:** TASK 27 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d["interactions"] = []
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose
# expect: "Clear interactions on scenario …"
# no "Record interaction" lines (empty array)
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID" | jq '.interactions'
```
Expected: `[]` or `null`

---

### TASK 29 — Scenario expectations add

**Prerequisite:** TASK 24 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d.setdefault("expectations", []).append({
  "id": "exp-e2e-001",
  "sliceId": "$E2E_SLICE_ID",
  "kind": "events",
  "expected": {
    "events": [{"name": "E2E Happened", "context": "IntegrationTest"}]
  }
})
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Set expectation exp-e2e-001"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID" | \
  jq '.expectations[] | select(.id == "exp-e2e-001")'
```
Expected: the expectation object.

**Trigger sync, verify:**
- `scenario.json` contains the expectation
- `.spec-stream/sync-manifest.json` entry for this scenario has `extra.expectations`

---

### TASK 30 — Scenario expectation remove

**Prerequisite:** TASK 29 complete.

**Edit:**
```sh
python3 - <<EOF
import json
p = "$SCENARIO_DIR/scenario.json"
d = json.load(open(p))
d["expectations"] = [e for e in d.get("expectations", []) if e["id"] != "exp-e2e-001"]
json.dump(d, open(p, "w"), indent=2)
EOF
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Remove expectation exp-e2e-001"
node dist/cli.js sync-back
```

**Verify API:** Expectation must no longer appear.

**Trigger sync, verify:** `scenario.json` no longer contains `exp-e2e-001`.

---

### TASK 31 — Scenario delete

**Prerequisite:** TASK 24 complete.

**Edit:**
```sh
rm -rf "$SCENARIO_DIR"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Delete scenario $E2E_SCENARIO_ID"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID/scenarios" | \
  jq --arg id "$E2E_SCENARIO_ID" '.[] | select(.id == $id)'
```
Expected: empty.

**Trigger sync, verify:**
- Scenario directory gone from local model
- `uuid-index.json` no longer maps `E2E_SCENARIO_ID`

---

### TASK 32 — Entity delete (element)

**Prerequisite:** TASK 11 complete.

**Edit:**
```sh
rm -rf "$ELEM_DIR"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Delete element $E2E_ELEMENT_ID"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id)'
```
Expected: empty.

**Trigger sync, verify:**
- Element directory absent from local model
- `uuid-index.json` no longer contains `E2E_ELEMENT_ID`

---

### TASK 33 — Entity delete (slice)

**Prerequisite:** TASK 4 complete. Delete any child elements and lanes inside the slice
first (or they will become orphans on the board). Then:

**Edit:**
```sh
rm -rf "$SLICE_DIR"
```

**Run + Verify API:** Same pattern as TASK 30 — `slice_id` must not appear in
`GET /chapters/$E2E_CHAPTER_ID`.

---

### TASK 34 — Entity delete (lane)

**Prerequisite:** TASK 8 complete, elements inside the lane already deleted.

**Edit:**
```sh
rm -rf "$LANE_DIR"
```

**Run + Verify API:** Same pattern.

---

### TASK 35 — Entity delete (chapter)

**Prerequisite:** All inner entities deleted (or use the E2E chapter which should now
be empty after prior tasks).

**Edit:**
```sh
rm -rf ".spec-stream/model/chapters/IntegrationTest/E2E-Chapter"
```

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose   # expect "Delete chapter $E2E_CHAPTER_ID"
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters" | jq --arg id "$E2E_CHAPTER_ID" '.[] | select(.id == $id)'
```
Expected: empty.

---

### TASK 36 — Entity delete (milestone)

**Prerequisite:** TASK 18 complete.

**Edit:**
```sh
rm -rf ".spec-stream/model/milestones/E2E-Milestone"
```

**Run + Verify API:**
```sh
node dist/cli.js sync-back
$API "$BASE/milestones" | jq --arg id "$E2E_MILESTONE_ID" '.[] | select(.id == $id)'
```
Expected: empty.

---

### TASK 37 — Directory rename detected as rename/move (not delete + create)

Tests the manifest diff rename path: same entity id appears in a new directory.

**Prerequisite:** TASK 11 complete (element exists at `$ELEM_DIR`).

**Edit:**
```sh
NEW_ELEM_DIR="$LANE_DIR/elements/0000_Renamed-Via-Move"
mv "$ELEM_DIR" "$NEW_ELEM_DIR"
ELEM_DIR="$NEW_ELEM_DIR"   # update variable for subsequent tasks
```
The element's id is still inside `element.json`. `sync-manifest.json` still has the old
directory as the key — the manifest diff will detect this as a rename.

**Run dry-run and check output:**
```sh
node dist/cli.js sync-back --dry-run --verbose
```
Confirm output contains exactly **one** operation of kind `element.rename` (or
`element.move` if the parent lane also changed) and **zero** operations of kind
`element.delete` or `element.create`. This confirms rename detection works correctly.

```sh
node dist/cli.js sync-back
```

**Verify API:**
```sh
$API "$BASE/chapters/$E2E_CHAPTER_ID" | \
  jq --arg id "$E2E_ELEMENT_ID" '.elements[] | select(.id == $id)'
```
Element still exists, no duplicate.

---

### TASK 38 — Dry-run is a true no-op

**Edit:** Change `description.md` for any existing element.

**Run:**
```sh
node dist/cli.js sync-back --dry-run --verbose
```

**Verify:** Read the element description from the API — it must be **unchanged**.

Then run without `--dry-run` and confirm the description changes on the board.

---

### TASK 39 — Cold-start: no manifest

Simulates a PM who has no prior manifest (e.g. first use after cloning a project with
a pre-populated model directory).

```sh
rm -f .spec-stream/sync-manifest.json .spec-stream/sync-back-ids.json
```

Create one isolated new entity:
```sh
mkdir -p .spec-stream/model/milestones/Cold-Start-Milestone
cat > .spec-stream/model/milestones/Cold-Start-Milestone/milestone.json <<'EOF'
{ "name": "Cold Start Milestone" }
EOF
```

**Run dry-run only:**
```sh
node dist/cli.js sync-back --dry-run --verbose
```

**Expected:** Every entity on disk appears as a `Create` operation (manifest is empty).
The new `Cold-Start-Milestone` is among them. The existing entities would produce API
conflicts if applied, which is the expected graceful degradation (not data loss).

**Do NOT run without `--dry-run`** for this task. Restore state:
```sh
node dist/cli.js # re-seeds sync-manifest.json from the live board, wait 2secs for the sync to happen
rm -rf .spec-stream/model/milestones/Cold-Start-Milestone
```

---

### TASK 40 — sync-back-ids.json bridges the gap when sync is not running

Verify that new entity ids are persisted correctly so the next sync-back run does not
re-create the same entity.

**Precondition:** `node dist/cli.js run` must NOT be running during this task.

**Steps:**
1. Create a new entity (e.g. milestone) locally with no `id` field.
2. Run sync-back. Confirm it succeeds and reports one create.
3. Check `.spec-stream/sync-back-ids.json` — it must contain an entry for the new
   entity's directory with the id returned by the API.
4. **Without** running `node dist/cli.js`, run dry-run again:
   ```sh
   node dist/cli.js sync-back --dry-run --verbose
   ```
5. Confirm the entity is classified as `update` (not `create`) — proving `sync-back-ids.json`
   bridges the gap correctly between sync-back runs.
6. Verify via REST that only **one** entity with that name exists on the board.

---

## Cleanup

After all tasks are complete, delete any remaining test entities:

```sh
# Delete E2E chapter (if not already done in TASK 33)
$API -X DELETE "$BASE/chapters/$E2E_CHAPTER_ID"

# Delete E2E milestone (if not already done in TASK 34)
$API -X DELETE "$BASE/milestones/$E2E_MILESTONE_ID"

# Delete HTML snippet (if not already done in TASK 23)
$API -X DELETE "$BASE/snippets/e2e-snippet"

# Delete E2E scenario (if not already done in TASK 29)
$API -X DELETE "$BASE/chapters/$E2E_CHAPTER_ID/scenarios/$E2E_SCENARIO_ID"

# Reset local model to clean board state
node dist/cli.js
```

---

## Pass criteria

All 40 tasks pass when:

1. Every `--dry-run` output lists the expected operation kind(s) and none unexpected.
2. Every REST verification returns the expected value immediately after `sync-back`.
3. Every sync verification shows the local model files match board state after sync.
4. No duplicate entities appear on the board at any point.

**Key regression checks:**
- **TASK 5:** dry-run shows `slice.update-status` and zero `slice.create` — the original
  gitignored-mirror bug is fixed.
- **TASK 35:** dry-run shows `element.rename` and zero `element.delete` / `element.create`
  — manifest-based rename detection works correctly.
- **TASK 37:** dry-run with empty manifest shows all-creates but without data loss.
- **TASK 38:** second dry-run (without sync) classifies the entity as `update`, not
  `create` — `sync-back-ids.json` bridges the gap correctly.
