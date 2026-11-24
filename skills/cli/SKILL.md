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

Drivers record `status` and finish at `ready`; they never mark a Task `done`. Review and verification are playbook helper activities, and merge / comment / close are playbook / Decision delivery: none is a Task command, field, state, or accept gate. Artifacts join a Ticket only through `artifact.task` or `Task.proof`.

## Retry Delivery

```sh
collie decision deliver --decision <decision_id>
```

## Result Handling

- stdout is JSON or task output; stderr and exit code describe failure.
- Surface the original error; never invent success.
- Use `collie task` for task facts; `collie-task` is internal and not a prompt contract.
