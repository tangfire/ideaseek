"""IdeaSeek Python worker (Phase 2): PDF/文献 parsing behind a JSON protocol.

The worker never becomes a second Agent Loop: the TypeScript side spawns it
per task, hands over a path, and receives structured JSON (docs/plan.md §3).
"""

__all__ = ["pdf_parse", "minipdf"]
__version__ = "0.1.0"
