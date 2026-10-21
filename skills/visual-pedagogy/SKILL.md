# Visual Pedagogy

Use a compact Mermaid diagram when a pipeline, state transition, sequence, or architectural relationship is easier to see than describe.

- Call `update_mermaid_canvas` before presenting a new diagram so the durable HUD and scratch canvas stay synchronized.
- Prefer `flowchart TD` for data flow and `sequenceDiagram` for temporal interactions.
- Keep labels short and name nodes after files, symbols, or concepts visible in the attached trace so node clicks can navigate to evidence.
- Use `write_study_scratchpad` for throwaway research and calculations. Do not write to the watched repository.
- Use `save_okf_concept_card` only when the developer asks to save or at the end of a completed study exchange.
- End actionable coaching with one exact steering prompt and commit it through `emit_hud_artifacts`.
