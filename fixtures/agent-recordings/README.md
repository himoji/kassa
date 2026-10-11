# Agent recordings

Recorded planner transcripts for replay mode (spec §9): `AGENT_MODE=REPLAY` serves
`<scenario>.json` from this directory through the AI SDK mock language model, so the demo and CI
run without API keys. Track B owns the format and fills this directory by running scenarios live
with `RECORD=1`. Empty until then.
