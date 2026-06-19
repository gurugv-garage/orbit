# Decision trace — tasks: the in-process design that was scrapped

> Why the tasks subsystem looks the way it does. Captured out of the (now current)
> [tasks.md](../tasks.md) when it was trimmed to an as-built reference.

The tasks subsystem **started as an in-process design** built around a single
`ctx.step` primitive, child pi sessions, and a curated camera/body capability menu —
a framework that tried to structure the task's *internal* steps.

That was **scrapped.** A task is now **a plain Node process + a WS connection + a tiny
message contract**, nothing more. The LLM writes ordinary code; the only framework is
the base class that connects + handshakes.

**The guiding rule that drove the change** — and that still governs the subsystem:
*only structure where a real contract exists; don't reinvent.* The real contract is
the wire protocol between the task process and the station (the `tasks` topic); inside
the process, the task is just code. Everything in the current design follows from that.
