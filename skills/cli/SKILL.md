---
name: collie-cli
description: Operate Collie through its CLI. Use when judging, creating, continuing, or reporting Work; do not guess task or Decision state.
---

# Collie CLI

Use `collie` for Collie operations. Read real state from the CLI; do not infer it from chat history.

## Registry

```sh
collie roles list
```

Choose a playbook only from the returned registry.

## Create Work

```sh
collie ticket create \
  --space <space> \
  --title "<title>" \
  --brief <path|-> \
  --kind build|review \
  [--project <project>] \
  [--playbook <name>]
```

`--brief -` reads stdin. stdout is JSON containing `decision_id` and `ticket_ref`.

## Commit a Decision

```sh
collie decision commit --space <space> --file <path|-> [--project <project>] [--turn-id <id>]
```

The file or stdin is a `urn:collie:decision:v1` JSON Decision. Use the same `--turn-id` when retrying.

To continue an existing target, set `decision_ref` to a `decision_id` from the current Case `snapshot.active`. The service writes a new revision of that Decision and preserves its Task. Never combine `decision_ref` with `spawn_task`; only a genuinely separate goal may spawn. Use `run.kind = build | review | verify` for the current Task action.

## Operate a Budget-deferred Todo

```sh
collie decision run --decision <decision_id>
collie decision archive --decision <decision_id>
```

Run now accepts an open Todo. With an existing Task it starts that same Task directly, without waking the Coordinator or spawning again. Without a Task it supports only a budget-deferred Decision and re-enters the Coordinator. Archive completes any existing Task with `done`, then settles the real Decision as `archived`; orphan Tasks use the Task command directly.

## Read State

```sh
collie ticket show --decision <decision_id>
collie ticket show --ticket <task_ref>
collie task list --json
collie task show <task> --json
```

## Task Facts

Public task commands are exactly `add / list / show / start / status / ready / accept / done`. Use the canonical task ref (for example `COLL-42`) throughout spawn, adopt, Receipt, and Artifact binding; key/id compatibility fallback is not part of the contract.

| Command | Contract |
|---|---|
| `collie task add <title> [--prompt <brief>]` | Create a `todo` Task. |
| `collie task list --json` | List Tasks. |
| `collie task show <task> --json` | Read one Task. |
| `collie task start <task>` | Start `todo → running`; service also uses this for rework `ready → running` and to restart a stopped `running` Task whose terminal was removed, always on the same Task. |
| `collie task status <task> "<what is happening>" --done 40 --left 10m` | Record progress while `running`. |
| `collie task ready <task> --summary "<result>" --details "<details>" --proof "<artifact>"` | Driver delivery: `running → ready` with the required generic receipt fields. |
| `collie task accept <task>` | Service finalization after accept: only `ready → done`; no merge, PR, review, or verification behavior. |
| `collie task done <task>` | Service finalization after drop. `drop` is a Card option, not a task subcommand. |

Drivers record `status` and finish at `ready`; they never mark a Task `done`. Review and verification are playbook helper activities, and merge / comment / close are playbook / Decision delivery: none is a Task command, field, state, or accept gate. Receipts join a Ticket through their Task ref; proof refs open the existing evidence viewer.

## Retry Delivery

```sh
collie decision deliver --decision <decision_id>
```

## Result Handling

- stdout is JSON or task output; stderr and exit code describe failure.
- Surface the original error; never invent success.
- Use `collie task` for task facts; `collie-task` is internal and not a prompt contract.
