---
name: ai-model-lineage-tracking
description: "What exists (and doesn't) for tracking AI model fine-tuning lineage and family trees"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 66be148d-924b-48b4-be21-54004614e9d7
---

There is **no single comprehensive, authoritative site** that tracks the full fine-tuning lineage tree of every AI model. Model provenance is scattered across model cards, blog posts, and paper citations.

## What exists

- **Stanford CRFM Ecosystem Graphs** (https://crfm.stanford.edu/ecosystem-graphs/) — Foundation model provenance, tracks which models are built on which base models. Focused on major releases, not every fine-tune.
- **Hugging Face model cards** — Individual models sometimes list `base_model` in metadata, but there's no aggregated cross-model search.
- **LifeArchitect.ai/models** (https://lifearchitect.ai/models-table/) — 800+ LLMs listed chronologically with params, tokens, benchmarks — but no lineage/parent column in the data dictionary.
- **Papers With Code** — Tracks which builds improve on prior work, but not explicitly a family tree.
- **Research papers** — Several papers have attempted LLM genealogy (e.g., "A Family Tree of Large Language Models"), but these are one-off snapshots, not live trackers.
- **Social media / blogs** — Individual researchers occasionally publish lineage diagrams, but again one-offs.

## What doesn't exist

- No live, comprehensive LLM family tree. The GitHub topic `llm-family-tree` is unused.
- `github.com/JosephLai2411/LLM-Family-Tree` → 404, doesn't exist.
- `github.com/srush/LLM-family-tree` → 404, doesn't exist.
- `llm-tracker.info` — personal LLM notes/reference site, not a lineage tool.
- `huggingface.co/spaces/society-ethics/llm-family-tree` → 401 unauthorized (private space or doesn't exist publicly).
- `interconnects.ai/p/llm-family-tree` → 404.
