# Agent recordings

Scripted planner answers for replay mode (spec §9): `AGENT_MODE=REPLAY` serves `<scenario>.json`
from this directory through the AI SDK mock language model, so the demo and CI run without API keys.
The files here are **hand-written** (`"recordedWith": "hand-written"`), not captured from a live
model. Running a scenario live with `RECORD=1` and a model key overwrites a file with a real capture
(`recordedWith` then names the model).
