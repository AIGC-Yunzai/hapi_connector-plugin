# Triage Labels

The skills speak in terms of canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker — in this case they are identical, because the repo uses Matt's default vocabulary unchanged.

| Role | Label in our tracker | Kind | Meaning |
| --- | --- | --- | --- |
| `bug` | `bug` | category | Something is broken |
| `enhancement` | `enhancement` | category | New feature or improvement |
| `needs-triage` | `needs-triage` | state | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | state | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | state | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | state | Requires human implementation |
| `wontfix` | `wontfix` | state | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Every triaged issue carries exactly one category role and one state role.
