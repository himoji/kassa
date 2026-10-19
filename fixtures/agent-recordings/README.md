# Agent recordings

Scripted planner answers for replay mode (spec §9): `AGENT_MODE=REPLAY` serves `<scenario>.json` through the AI SDK mock language model, so the demo and CI need no API keys. The files are **hand-written** (`"recordedWith": "hand-written"`). Running a scenario live with `RECORD=1` and a model key overwrites the file with a real capture (`recordedWith` names the model).
