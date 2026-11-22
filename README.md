# Push-Optimal Sokoban Solver

[![Competition](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/xdiablo052-ai/sokoban-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/xdiablo052-ai/sokoban-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A Sokoban solver for the make.fun [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty.

These levels are a hallway with independent rooms off it — a box can never leave its
room — so the solver cuts the hallway out of the floor, solves each room push-optimally
with a breadth-first search over pushes (dead-square and frozen-block deadlock pruning),
and stitches the rooms' solutions together. On the kit's practice set it matches the
known optimum P* on every instance.
